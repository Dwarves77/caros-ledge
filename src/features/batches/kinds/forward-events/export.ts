// Ported from old_repo/scripts/turns/export-corpus-for-extraction.mjs (lines 1-87)
// Ported from old_repo/scripts/turns/export-corpus-for-extraction.mjs (lines 254-380)
// Ported from old_repo/scripts/turns/export-corpus-for-extraction.mjs (lines 421-541)
// The forward-event export: the items whose events are owed, with the claims, sections and reference dates the extractor reads. Scope: the items of the open corpus-turn tickets (verified and live, oldest first, the
// limit applied there), then verified live items that have no event yet. Each item carries the ticket ids it serves, and the bundle carries the ticket snapshot so the apply consumes exactly those ids. The read of
// held events is by chunks of candidate items, never the whole event table.
import { fetchAllRows, type Db } from "@/core/db";
import { readExtractionInput } from "@/features/obligations";
import { rowsByIds } from "@/core/db";

import { type BatchExport, type Obj } from "../../kit/session-batch";

import { buildSnapshot, selectTickets } from "./tickets";

export const FORWARD_EXPORT_LIMIT = 100;
const CHUNK = 200;

/** Verified live item ids in id order that hold no forward event: candidates are read in chunks and stop at `need`. */
async function itemsWithoutEvents(sb: Db, need: number, exclude: ReadonlySet<string>): Promise<string[]> {
  const ids = (await fetchAllRows<{ id: string }>((from, to) => sb.from("intelligence_items").select("id").eq("provenance_status", "verified").eq("is_archived", false).order("id", { ascending: true }).range(from, to) as never, { cap: 500_000 })).map((r) => r.id).filter((id) => !exclude.has(id));
  const out: string[] = [];
  for (let i = 0; i < ids.length && out.length < need; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const held = new Set((await rowsByIds<{ intelligence_item_id: string }>(sb, "item_forward_events", "id, intelligence_item_id", slice, "intelligence_item_id")).map((r) => r.intelligence_item_id));
    for (const id of slice) if (!held.has(id) && out.length < need) out.push(id);
  }
  return out;
}

export function forwardEventsExporter(sb: Db, now: () => Date) {
  return async ({ limit }: { limit: number }): Promise<BatchExport> => {
    try {
      const t = await selectTickets(sb, { limit });
      const ticketsByItem = new Map<string, string[]>();
      for (const r of t.chosen) ticketsByItem.set(r.intelligence_item_id, [...(ticketsByItem.get(r.intelligence_item_id) ?? []), r.id]);
      const fromTickets = [...ticketsByItem.keys()];
      const rest = fromTickets.length < limit ? await itemsWithoutEvents(sb, limit - fromTickets.length, new Set(fromTickets)) : [];
      const items: Obj[] = [];
      for (const id of [...fromTickets, ...rest]) {
        const input = await readExtractionInput(sb, id, now());
        items.push({ id, ticket_ids: ticketsByItem.get(id) ?? [], claims: input.claims, sections: input.sections, referenceDates: input.referenceDates });
      }
      const snapshot = buildSnapshot(t.chosen, { generatedAt: now().toISOString(), archived: t.archived, deferredCount: t.deferred.length });
      const withContent = items.filter((it) => (it.claims as unknown[]).length || (it.sections as unknown[]).length).length;
      return { ok: true, items, source: { type: "table", table: "corpus_turn_requests" }, summary: { open_tickets: t.totalOpen, tickets_selected: t.chosen.length, tickets_archived: t.archived.length, tickets_deferred_not_verified: t.deferred.length, items_exported: items.length, items_with_content: withContent, items_from_tickets: fromTickets.length, items_without_events: rest.length, tickets: snapshot } };
    } catch (e) {
      return { ok: false, items: [], error: (e as Error).message };
    }
  };
}
