// Ported from old_repo/scripts/turns/apply-extraction-output.mjs (lines 12-191)
// Forward events loaded from a batch: per item, the events a session (or the rule extractor run offline) lifted from the item's own claims and sections, checked against the database's own CHECKs before any write (a claim-sourced
// event names a claim of the item, a section-sourced one a section, high confidence only from a claim, the span verbatim in what it cites), then written through the ONE writer on the migration-307 identity (a re-apply
// inserts nothing new). The same run derives the item's obligations and syncs its compliance deadline (rule 17), and consumes exactly the tickets the batch names (INV-212).
import { assertVerbatim } from "@/core/contracts/verbatim";
import { EVENT_KINDS, forwardEventKey, insertForwardEvents, PRECISIONS, syncComplianceDeadline } from "@/features/obligations";
import type { ExtractedEvent } from "@/features/obligations";
import { runResult } from "@/core/types/run-result";
import { allRows, rowsByIds } from "@/core/db";

import { applyEntries, isObj, nonEmpty, type ApplyOpts, type BatchDeps, type EntrySpec } from "../../kit/session-batch";

import { archivedConsumedBy, consumeTickets, readItemStates, type Ticket } from "./tickets";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUIRED = ["event_date", "date_precision", "event_kind", "obligation_text", "source_kind", "source_span", "confidence", "extractor_version"] as const;

interface ItemLive { archived: boolean; claims: Map<string, string>; sections: Map<string, string>; keys: Set<string> }
export interface ForwardLive { items: Map<string, ItemLive>; tickets: Map<string, Ticket & { consumed_at: string | null }>; itemStates: Map<string, { provenance_status: string | null; is_archived: boolean | null }>; archivedClose: string[]; archivedErrors: string[] }
export interface ForwardPlan { itemId: string; events: ExtractedEvent[]; ticketIds: string[] }

/** One event checked against the table's CHECKs and the item's own material; the refusal reasons. */
export function validateEvent(ev: unknown, at: string, item: ItemLive): string[] {
  if (!isObj(ev)) return [`${at}: not an object`];
  const errs: string[] = [];
  for (const k of REQUIRED) if (!nonEmpty(ev[k])) errs.push(`${at}: ${k} missing or not a non-empty string`);
  if (errs.length) return errs;
  if (!(EVENT_KINDS as readonly string[]).includes(String(ev.event_kind))) errs.push(`${at}: event_kind ${JSON.stringify(ev.event_kind)} is not one of ${EVENT_KINDS.join(", ")}`);
  if (!(PRECISIONS as readonly string[]).includes(String(ev.date_precision))) errs.push(`${at}: date_precision ${JSON.stringify(ev.date_precision)} is not one of ${PRECISIONS.join(", ")}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ev.event_date)) || Number.isNaN(Date.parse(String(ev.event_date)))) errs.push(`${at}: event_date must be an ISO date (YYYY-MM-DD)`);
  if (ev.confidence !== "high" && ev.confidence !== "medium") errs.push(`${at}: confidence must be high or medium`);
  if (ev.source_kind !== "claim" && ev.source_kind !== "section") return [...errs, `${at}: source_kind must be claim or section`];
  const [claimId, sectionId] = [ev.source_claim_id ?? null, ev.source_section_id ?? null];
  if ((ev.source_kind === "claim") !== (claimId !== null)) errs.push(`${at}: a claim-sourced event names source_claim_id, a section-sourced one does not`);
  if (ev.confidence === "high" && ev.source_kind !== "claim") errs.push(`${at}: high confidence needs a claim source (a section-sourced event is capped at medium)`);
  const cited = ev.source_kind === "claim" ? item.claims.get(String(claimId)) : item.sections.get(String(sectionId));
  if (ev.source_kind === "claim" && cited === undefined) errs.push(`${at}: source_claim_id ${JSON.stringify(claimId)} is not a claim of this item`);
  else if (ev.source_kind === "section" && cited === undefined) errs.push(`${at}: source_section_id ${JSON.stringify(sectionId)} is not a section of this item`);
  else if (cited !== undefined) {
    try {
      assertVerbatim(cited, String(ev.source_span));
    } catch {
      errs.push(`${at}: source_span is not verbatim in the ${String(ev.source_kind)} it cites`);
    }
  }
  return errs;
}

export const forwardEventsSpec: EntrySpec<ForwardLive, ForwardPlan> = {
  kind: "forward-events",
  batchRe: /^forward-events-[A-Za-z0-9._-]+$/,
  ceiling: 200,
  keyOf: (e) => (typeof e.item_id === "string" ? e.item_id : null),
  async load(deps, file) {
    const entries = (file.entries as unknown[]).filter(isObj);
    const itemIds = [...new Set(entries.map((e) => (typeof e.item_id === "string" && UUID_RE.test(e.item_id) ? e.item_id : "")).filter(Boolean))];
    const ticketIds = [...new Set([...entries.flatMap((e) => (Array.isArray(e.ticket_ids) ? e.ticket_ids : [])), ...(Array.isArray(file.archived_ticket_ids) ? file.archived_ticket_ids : [])].filter((x): x is string => typeof x === "string"))];
    const tickets = new Map((await rowsByIds<Ticket & { consumed_at: string | null }>(deps.sb, "corpus_turn_requests", "id, intelligence_item_id, reason, requested_at, consumed_at", ticketIds)).map((t) => [t.id, t]));
    const itemStates = await readItemStates(deps.sb, [...new Set([...itemIds, ...[...tickets.values()].map((t) => t.intelligence_item_id)])]);
    const items = new Map<string, ItemLive>();
    for (const id of itemIds) {
      const st = itemStates.get(id);
      if (!st) continue;
      const claims = await allRows<{ id: string; claim_text: string; source_span: string | null }>(deps.sb, "section_claim_provenance", "id, claim_text, source_span", { where: (q) => q.eq("intelligence_item_id", id).in("claim_kind", ["FACT", "GAP"]) });
      const sections = await allRows<{ id: string; content_md: string | null }>(deps.sb, "intelligence_item_sections", "id, content_md", { where: (q) => q.eq("item_id", id) });
      const events = await allRows<{ event_date: string; event_kind: string; obligation_text: string }>(deps.sb, "item_forward_events", "id, event_date, event_kind, obligation_text", { where: (q) => q.eq("intelligence_item_id", id) });
      items.set(id, { archived: st.is_archived === true, claims: new Map(claims.map((c) => [c.id, `${c.claim_text}\n${c.source_span ?? ""}`])), sections: new Map(sections.map((s) => [s.id, s.content_md ?? ""])), keys: new Set(events.map(forwardEventKey)) });
    }
    // Archived-item tickets close under their own label, and only when the item really is archived (INV-212).
    const archivedErrors: string[] = [];
    const archivedClose: string[] = [];
    for (const id of Array.isArray(file.archived_ticket_ids) ? (file.archived_ticket_ids as unknown[]) : []) {
      const t = typeof id === "string" ? tickets.get(id) : undefined;
      if (!t || t.consumed_at !== null) archivedErrors.push(`archived ticket ${String(id)} is not an open ticket`);
      else if (itemStates.get(t.intelligence_item_id)?.is_archived !== true) archivedErrors.push(`archived ticket ${t.id}: its item is not archived, so the ticket stays open`);
      else archivedClose.push(t.id);
    }
    return { items, tickets, itemStates, archivedClose, archivedErrors };
  },
  entry(e, i, live) {
    if (!isObj(e)) return { errors: [`entries[${i}]: must be an object`] };
    const tag = `item ${String(e.item_id)}`;
    if (typeof e.item_id !== "string" || !UUID_RE.test(e.item_id)) return { errors: [`entries[${i}]: item_id must be a UUID`] };
    const item = live.items.get(e.item_id);
    if (!item) return { errors: [`${tag}: item not found`] };
    if (item.archived) return { errors: [`${tag}: the item is archived: its events are not loaded`] };
    if (!Array.isArray(e.events) || !e.events.length) return { errors: [`${tag}: events must be a non-empty array`] };
    const errors = (e.events as unknown[]).flatMap((ev, k) => validateEvent(ev, `${tag} events[${k}]`, item));
    const ticketIds = Array.isArray(e.ticket_ids) ? (e.ticket_ids as unknown[]) : [];
    for (const id of ticketIds) {
      const t = typeof id === "string" ? live.tickets.get(id) : undefined;
      const st = t ? live.itemStates.get(t.intelligence_item_id) : undefined;
      if (!t || t.consumed_at !== null) errors.push(`${tag}: ticket ${String(id)} is not an open ticket`);
      else if (t.intelligence_item_id !== e.item_id) errors.push(`${tag}: ticket ${t.id} belongs to another item`);
      else if (st?.provenance_status !== "verified" || st.is_archived === true) errors.push(`${tag}: ticket ${t.id}: the item is not verified and live, so the ticket stays open and is not consumed here`);
    }
    if (errors.length) return { errors };
    const events = (e.events as ExtractedEvent[]);
    return events.every((ev) => item.keys.has(forwardEventKey(ev))) && !ticketIds.length ? { errors: [], done: true } : { errors: [], plan: { itemId: e.item_id, events, ticketIds: ticketIds as string[] } };
  },
  async write(deps, live, item, batch) {
    const it = live.items.get(item.plan.itemId) as ItemLive;
    const w = await insertForwardEvents(deps.sb, item.plan.itemId, item.plan.events, { claimIds: new Set(it.claims.keys()), sectionIds: new Set(it.sections.keys()) });
    const sync = await syncComplianceDeadline(deps.sb, item.plan.itemId, deps.now().toISOString().slice(0, 10));
    const tickets = item.plan.ticketIds.length ? await consumeTickets(deps.sb, item.plan.ticketIds, batch, deps.now().toISOString()) : 0;
    return { ref: item.plan.itemId, counts: { events_attempted: w.attempted, events_inserted: w.inserted, events_collided: w.collisions, stale_events: w.staleIds.length, deadlines_changed: sync.changed ? 1 : 0, tickets_consumed: tickets } };
  },
  async readBack(deps, _live, written) {
    const bad: string[] = [];
    for (const w of written) {
      const rows = await allRows<{ event_date: string; event_kind: string; obligation_text: string }>(deps.sb, "item_forward_events", "id, event_date, event_kind, obligation_text", { where: (q) => q.eq("intelligence_item_id", w.plan.itemId) });
      const have = new Set(rows.map(forwardEventKey));
      if (!w.plan.events.every((ev) => have.has(forwardEventKey(ev)))) bad.push(w.plan.itemId);
    }
    return bad;
  },
  async downstream(deps, live, written, o) {
    const counts: Record<string, number> = { obligations_derived: 0, archived_tickets_closed: 0 };
    const notes: string[] = [];
    for (const w of written) {
      try {
        counts.obligations_derived = (counts.obligations_derived as number) + (await deps.intake.connect.deriveObligations(w.plan.itemId)).derived;
      } catch (e) {
        notes.push(`obligations for ${w.plan.itemId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (live.archivedClose.length) counts.archived_tickets_closed = await consumeTickets(deps.sb, live.archivedClose, archivedConsumedBy(String(o.batch ?? "forward-events")), deps.now().toISOString());
    return runResult(notes.length || live.archivedErrors.length ? "partial" : "ok", counts, [...notes, ...live.archivedErrors]);
  },
};

export const applyForwardEvents = (deps: BatchDeps, file: unknown, o: ApplyOpts) => applyEntries(forwardEventsSpec, deps, file, { ...o, batch: isObj(file) ? file.batch : undefined });
