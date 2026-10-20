// Ported from old_repo/scripts/obligations/derive-obligations.mjs (lines 96-302)
// The register derivation (migration 290): one `obligations` row per forward event, carrying the item's jurisdiction codes, its LEG modes (never
// multimodal or an alias), the event's kind and date (due_date and date_precision null together), status archived exactly when the item is, and the
// binding_position decided in the fixed order. Idempotent on forward_event_id: a re-run inserts nothing. Reads are chunked by id (not the whole table) and an
// optional context read that fails FAILS THE RUN: classifying by title alone and reporting success hid a read error (B-0322).
import type { Db } from "@/core/db";
import { fetchAllByIdChunks, fetchAllRows } from "@/core/db";
import { LEG_MODE_CODES, normaliseMode } from "@/core/contracts/vocabularies";
import { currentObligationObjects } from "@/core/workspace";
import type { RunResult } from "@/core/sources/run-result";

import { classifyItemBindingPosition, contextFromClaims, type ClassifyContext, type ItemForClassification } from "./classify-binding-position";

const DERIVATION_VERSION = "oblig-derive-2026-10-08.1";
const LEG_MODE_SET = new Set(LEG_MODE_CODES);

export interface EventRow {
  id: string;
  intelligence_item_id: string;
  event_date: string | null;
  date_precision: string | null;
  event_kind: string;
}
export interface ItemRow extends ItemForClassification {
  id: string;
  transport_modes?: string[] | null;
  is_archived?: boolean | null;
}
export interface ObligationRow {
  intelligence_item_id: string;
  forward_event_id: string;
  jurisdiction: string[];
  modes: string[];
  binding_position: string | null;
  due_date: string | null;
  date_precision: string | null;
  event_kind: string;
  status: "active" | "archived";
  derivation_version: string;
}

function deriveObligationRow(event: EventRow, item: ItemRow, ctx: ClassifyContext = {}): ObligationRow {
  const jurisdiction = Array.isArray(item?.jurisdiction_iso) ? item.jurisdiction_iso.filter(Boolean) : [];
  const modes = Array.isArray(item?.transport_modes) ? [...new Set(item.transport_modes.map((m) => normaliseMode(m)).filter((m): m is string => !!m && LEG_MODE_SET.has(m)))] : [];
  const classified = classifyItemBindingPosition(item, ctx);
  const hasDate = typeof event?.event_date === "string" && event.event_date.length > 0;
  return {
    intelligence_item_id: event.intelligence_item_id, forward_event_id: event.id, jurisdiction, modes, binding_position: classified ? classified.position : null,
    due_date: hasDate ? (event.event_date as string) : null, date_precision: hasDate ? (event.date_precision ?? null) : null, event_kind: event.event_kind, status: item?.is_archived ? "archived" : "active", derivation_version: DERIVATION_VERSION,
  };
}
function deriveObligationRows(events: readonly EventRow[], itemsById: ReadonlyMap<string, ItemRow>, ctxByItemId: ReadonlyMap<string, ClassifyContext> = new Map()): ObligationRow[] {
  const out: ObligationRow[] = [];
  for (const event of events) {
    const item = itemsById.get(event.intelligence_item_id);
    if (item) out.push(deriveObligationRow(event, item, ctxByItemId.get(event.intelligence_item_id) ?? {}));
  }
  return out;
}
/** Rows whose forward event has no obligations row yet. */
const filterNewRows = (derived: readonly ObligationRow[], existingForwardEventIds: Iterable<string>): ObligationRow[] => {
  const seen = new Set(existingForwardEventIds);
  return derived.filter((r) => !seen.has(r.forward_event_id));
};
/** Per item: the record-facts position and the duty-holder classes (the item's current objects, plus the Member-State addressee). */
function buildContextByItem(claimRows: readonly { intelligence_item_id: string; claim_text: string }[], objectRows: readonly { instrument_item_id: string; obligation_id: string; supersedes?: string | null; duty_holder_class?: string[] | null }[]): Map<string, ClassifyContext> {
  const texts = new Map<string, string[]>();
  for (const c of claimRows) texts.set(c.intelligence_item_id, [...(texts.get(c.intelligence_item_id) ?? []), c.claim_text]);
  const objs = new Map<string, typeof objectRows[number][]>();
  for (const o of objectRows) objs.set(o.instrument_item_id, [...(objs.get(o.instrument_item_id) ?? []), o]);
  const out = new Map<string, ClassifyContext>();
  for (const id of new Set([...texts.keys(), ...objs.keys()])) {
    const fromClaims = contextFromClaims(texts.get(id) ?? []);
    const fromObjects = currentObligationObjects<typeof objectRows[number]>(objs.get(id) ?? []).flatMap((o) => (Array.isArray(o.duty_holder_class) ? o.duty_holder_class : []));
    out.set(id, { recordFactsPosition: fromClaims.recordFactsPosition, dutyHolderClasses: [...new Set([...fromObjects, ...fromClaims.dutyHolderClasses])] });
  }
  return out;
}

const chunked = <T>(sb: Db, ids: readonly string[], table: string, columns: string, idColumn: string, opts: { factOnly?: boolean } = {}) =>
  fetchAllByIdChunks<T>(ids, async (slice) => {
    const base = sb.from(table).select(columns).in(idColumn, slice);
    const { data, error } = await (opts.factOnly ? base.eq("claim_kind", "FACT").like("claim_text", "[%") : base);
    if (error) throw new Error(`derive-register: ${table} read failed: ${error.message}`);
    return (data ?? []) as unknown as T[];
  }, { manyPerId: true });

/** Derive the register rows for the given items' forward events (or every event when no ids are given). Dry computes and counts; apply inserts the new rows and reads them back. */
export async function deriveRegister(sb: Db, input: { dry: boolean; itemIds?: readonly string[] }): Promise<RunResult<{ derived: number; toInsert: number; byBindingPosition: Record<string, number> }>> {
  let events: EventRow[];
  if (input.itemIds) events = await chunked<EventRow>(sb, input.itemIds, "item_forward_events", "id, intelligence_item_id, event_date, date_precision, event_kind", "intelligence_item_id");
  else events = await fetchAllRows<EventRow>((from, to) => sb.from("item_forward_events").select("id, intelligence_item_id, event_date, date_precision, event_kind").order("id", { ascending: true }).range(from, to), { cap: 1_000_000 });
  const itemIds = [...new Set(events.map((e) => e.intelligence_item_id))];
  const items = await chunked<ItemRow>(sb, itemIds, "intelligence_items", "id, title, jurisdiction_iso, transport_modes, is_archived, instrument_identifier, canonical_instrument_key", "id");
  const claimRows = await chunked<{ intelligence_item_id: string; claim_text: string }>(sb, itemIds, "section_claim_provenance", "intelligence_item_id, claim_text", "intelligence_item_id", { factOnly: true });
  const objectRows = await chunked<{ instrument_item_id: string; obligation_id: string; supersedes: string | null; duty_holder_class: string[] | null }>(sb, itemIds, "obligation_objects", "instrument_item_id, obligation_id, supersedes, duty_holder_class", "instrument_item_id");
  const derived = deriveObligationRows(events, new Map(items.map((i) => [i.id, i])), buildContextByItem(claimRows, objectRows));
  const existing = await chunked<{ forward_event_id: string }>(sb, events.map((e) => e.id), "obligations", "forward_event_id", "forward_event_id");
  const toInsert = filterNewRows(derived, existing.map((r) => r.forward_event_id));
  const byBindingPosition: Record<string, number> = {};
  for (const r of derived) byBindingPosition[r.binding_position ?? "unclassified"] = (byBindingPosition[r.binding_position ?? "unclassified"] ?? 0) + 1;
  const counts: Record<string, number> = { forward_events: events.length, items: itemIds.length, derived: derived.length, skipped_no_item: events.length - derived.length, already_registered: existing.length, to_insert: toInsert.length, inserted: 0 };
  const detail = { derived: derived.length, toInsert: toInsert.length, byBindingPosition };
  if (input.dry || !toInsert.length) return { counts, outcome: "ok", notes: input.dry ? ["dry: nothing written"] : [], data: detail };
  let inserted = 0;
  const notes: string[] = [];
  for (let i = 0; i < toInsert.length; i += 200) {
    const batch = toInsert.slice(i, i + 200);
    const { data, error } = await sb.from("obligations").insert(batch).select("id");
    if (error) notes.push(`obligations insert chunk ${i} failed: ${error.message}`);
    else inserted += (data ?? []).length;
  }
  counts.inserted = inserted;
  if (inserted !== toInsert.length) notes.push(`MISMATCH: ${toInsert.length} rows prepared, ${inserted} confirmed inserted`);
  return { counts, outcome: inserted === toInsert.length ? "ok" : inserted > 0 ? "partial" : "failed", notes, data: detail };
}
