// Ported from old_repo/src/lib/learning/questions-on-change.mjs (lines 1-216)
// Questions on change (ADR-044 decision 1): when a value the system holds changes (an outbox event from a registered emitting table), every VERIFIED, non-archived item linked
// to the changed entity gets its questions re-asked with the change stated, at most 25 items per event. A new emitting table adds one data file (and its line in the
// registry, which a test holds equal to the directory). A failed entity read is counted and its event id returned for replay, never swallowed.
import { z } from "zod";

import { fetchAllByIdChunks, fetchAllRows, type Db } from "@/core/db";
import { runResult, type RunResult } from "@/core/intake/result";

import derived_values from "./data/emitting-tables/derived_values.json";
import emission_factors from "./data/emitting-tables/emission_factors.json";
import entity_aliases from "./data/emitting-tables/entity_aliases.json";
import entity_relations from "./data/emitting-tables/entity_relations.json";
import estimated_values from "./data/emitting-tables/estimated_values.json";
import grid_connection_queues from "./data/emitting-tables/grid_connection_queues.json";
import market_series from "./data/emitting-tables/market_series.json";
import obligation_objects from "./data/emitting-tables/obligation_objects.json";
import oem_tech_roadmaps from "./data/emitting-tables/oem_tech_roadmaps.json";
import regional_data_facts from "./data/emitting-tables/regional_data_facts.json";
import signposts from "./data/emitting-tables/signposts.json";
import statutory_computations from "./data/emitting-tables/statutory_computations.json";
import { generateTriggerQuestions, TRIGGER_EVENT_TYPES, writeQuestions, type QuestionDeps, type QuestionItem, type TriggerQuestion } from "./trigger-questions";

export const MAX_ITEMS_PER_EVENT = 25;
const entry = z.object({ table_name: z.string().min(1), type: z.string().min(1), label: z.string().min(1), byKind: z.record(z.string(), z.string()).default({}), describe: z.literal("identity").optional() }).strict();
export type EmittingTable = z.infer<typeof entry>;
/** Every registered emitting table; the file name must equal its table_name. */
const FILES: Record<string, unknown> = { derived_values, emission_factors, entity_aliases, entity_relations, estimated_values, grid_connection_queues, market_series, obligation_objects, oem_tech_roadmaps, regional_data_facts, signposts, statutory_computations };
export const EMITTING_TABLES: Readonly<Record<string, EmittingTable>> = Object.freeze(
  Object.fromEntries(Object.entries(FILES).map(([name, raw]) => {
    const e = entry.parse(raw);
    if (e.table_name !== name) throw new Error(`emitting-tables/${name}.json: table_name "${e.table_name}" differs from the filename`);
    if (!(TRIGGER_EVENT_TYPES as readonly string[]).includes(e.type)) throw new Error(`emitting-tables/${name}.json: type "${e.type}" is not a trigger event type`);
    return [name, Object.freeze(e)];
  })),
);

export interface ChangeEvent { eventId: string | number; tableName: string; rowPk?: string | null; entityId: string | null; changeKind?: string | null; occurredAt?: string }
const KIND_VERB: Record<string, string> = { insert: "was added", update: "was revised", delete: "was removed", supersede: "was superseded" };

/** The trigger event type of an outbox row; null when its table is not registered or its type is not a trigger event. */
export function eventTypeForOutboxRow(row: { table_name: string; change_kind?: string | null }): string | null {
  const e = EMITTING_TABLES[row.table_name];
  if (!e) return null;
  const type = (row.change_kind && e.byKind[row.change_kind]) || e.type;
  return (TRIGGER_EVENT_TYPES as readonly string[]).includes(type) ? type : null;
}
/** The change in words, stated in the question. An alias or relation change is an identity revision. */
export function describeChange(ev: ChangeEvent, entityName: string | null): string {
  const e = EMITTING_TABLES[ev.tableName];
  const who = entityName ? `${entityName} (${ev.entityId})` : String(ev.entityId);
  if (e?.describe === "identity") return `the identity of ${who} changed (alias or relation): re-resolve mentions and roll-ups that name it`;
  return `${e ? e.label : `a value in ${ev.tableName}`} (${ev.rowPk}) ${KIND_VERB[ev.changeKind ?? ""] ?? "changed"} on ${who}`;
}

export interface EntityLinks { entityName: string | null; items: Array<QuestionItem & { provenance_status?: string; is_archived?: boolean }> }
/** The items linked to an entity (its instrument items and its entity_refs), verified only. Every read throws on error. */
export function buildEntityItemsReader(sb: Db): (entityId: string) => Promise<EntityLinks> {
  return async (entityId) => {
    const ent = await sb.from("entities").select("entity_id,kind,canonical_name").eq("entity_id", entityId).maybeSingle();
    if (ent.error) throw new Error(`entities read failed: ${ent.error.message}`);
    const viaInstrument = await fetchAllRows<{ id: string }>((a, b) => sb.from("intelligence_items").select("id").eq("instrument_entity_id", entityId).order("id", { ascending: true }).range(a, b) as never, { cap: 100_000 });
    const viaRefs = await fetchAllRows<{ ref_id: string }>((a, b) => sb.from("entity_refs").select("ref_id,role").eq("ref_table", "intelligence_items").eq("entity_id", entityId).order("ref_id", { ascending: true }).order("role", { ascending: true }).range(a, b) as never, { cap: 100_000 });
    const items = await fetchAllByIdChunks([...new Set([...viaInstrument.map((r) => r.id), ...viaRefs.map((r) => r.ref_id)])], async (slice) => {
      const { data, error } = await sb.from("intelligence_items").select("id,title,domain,item_type,provenance_status,is_archived").in("id", slice).eq("provenance_status", "verified");
      if (error) throw new Error(`intelligence_items read failed: ${error.message}`);
      return (data ?? []) as EntityLinks["items"];
    });
    return { entityName: (ent.data as { canonical_name?: string } | null)?.canonical_name ?? null, items };
  };
}

export interface ChangeDeps extends QuestionDeps { readEntityLinks(entityId: string): Promise<EntityLinks> }
export interface ChangeResult extends RunResult { failedEventIds: Array<string | number> }

/** Raise the questions for a batch of outbox events. An event whose table is unregistered or has no entity is counted; a failed entity read is counted with its text and replayable. */
export async function runQuestionsOnChange(deps: ChangeDeps, input: { dry?: boolean; events: readonly ChangeEvent[]; cap?: number }): Promise<ChangeResult> {
  const cap = input.cap ?? MAX_ITEMS_PER_EVENT;
  const c = { events_seen: input.events.length, events_mapped: 0, events_unmapped: 0, events_no_entity: 0, read_errors: 0, items_affected: 0, items_dropped_by_cap: 0 };
  const notes: string[] = [];
  const failed: Array<string | number> = [];
  const cache = new Map<string, EntityLinks>();
  const questions: TriggerQuestion[] = [];
  for (const ev of input.events) {
    const eventType = eventTypeForOutboxRow({ table_name: ev.tableName, change_kind: ev.changeKind ?? null });
    if (!eventType) { c.events_unmapped += 1; continue; }
    if (!ev.entityId) { c.events_no_entity += 1; continue; }
    c.events_mapped += 1;
    let links = cache.get(ev.entityId);
    if (!links) {
      try {
        links = await deps.readEntityLinks(ev.entityId);
      } catch (e) {
        c.read_errors += 1;
        notes.push(`event ${ev.eventId}: reading links of ${ev.entityId} failed: ${(e as Error).message}`);
        failed.push(ev.eventId);
        continue;
      }
      cache.set(ev.entityId, links);
    }
    const eligible = links.items.filter((i) => i?.id && i.provenance_status === "verified" && !i.is_archived).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const affected = eligible.slice(0, cap);
    c.items_affected += affected.length;
    c.items_dropped_by_cap += eligible.length - affected.length;
    const change = describeChange(ev, links.entityName);
    for (const item of affected) questions.push(...generateTriggerQuestions(item, { eventType, eventId: ev.eventId, change }));
  }
  const written = await writeQuestions(deps, { ...(input.dry === undefined ? {} : { dry: input.dry }), questions, itemsConsidered: c.items_affected, step: "questions-on-change" });
  const outcome = written.outcome === "failed" ? "failed" : c.read_errors ? "partial" : written.outcome;
  return { ...runResult(outcome, { ...c, ...written.counts }, [...notes, ...written.notes]), failedEventIds: failed };
}

const OUTBOX_COLS = "event_id,table_name,row_pk,entity_id,change_kind,occurred_at";
/** Replay reader: outbox rows by id list or by event-id range, ordered by id. Throws on any read error. */
export async function readOutboxEvents(sb: Db, q: { ids: readonly (string | number)[] } | { from: number; to: number }): Promise<ChangeEvent[]> {
  const rows = "ids" in q
    ? await fetchAllByIdChunks(q.ids.map(String), async (slice) => {
        const { data, error } = await sb.from("propagation_events").select(OUTBOX_COLS).in("event_id", slice);
        if (error) throw new Error(`propagation_events read failed: ${error.message}`);
        return (data ?? []) as Rec[];
      })
    : await fetchAllRows<Rec>((a, b) => sb.from("propagation_events").select(OUTBOX_COLS).gte("event_id", q.from).lte("event_id", q.to).order("event_id", { ascending: true }).range(a, b) as never, { cap: 500_000 });
  return rows.map((r) => ({ eventId: r.event_id as string | number, tableName: String(r.table_name), rowPk: (r.row_pk as string) ?? null, entityId: (r.entity_id as string) ?? null, changeKind: (r.change_kind as string) ?? null, occurredAt: String(r.occurred_at) })).sort((a, b) => Number(a.eventId) - Number(b.eventId));
}
type Rec = Record<string, unknown>;
