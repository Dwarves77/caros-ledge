// Ported from old_repo/scripts/turns/consume-turn-requests.mjs (lines 1-385)
// The corpus-turn ticket queue (INV-212). A ticket is read oldest first and partitioned by its item's live state BEFORE any limit: selectable (verified, not archived: the real scope), archived (closed under
// `<by>:item-archived`, never worked) and deferred (not verified yet: stays OPEN and unselected, surfacing on its own once the item verifies). A ticket is consumed only by the run that selected it, and marking retires
// exactly the ids a prior snapshot named, never the queue as it looks now.
import type { Db } from "@/core/db";

import { allRows, rowsByIds } from "../../kit/session-batch";

export interface Ticket { id: string; intelligence_item_id: string; reason: string | null; requested_at: string }
export interface ItemState { provenance_status: string | null; is_archived: boolean | null }
export interface TicketPartition { selectable: Ticket[]; archived: Ticket[]; deferred: Ticket[] }
export interface TicketSnapshot {
  generated_at: string;
  count: number;
  by_reason: Record<string, number>;
  ids: string[];
  requests: Ticket[];
  archived_requests: Ticket[];
  deferred_not_verified: number;
}
export const archivedConsumedBy = (by: string): string => `${by}:item-archived`;

/** Split open tickets by the live state of their item. An item with no state (a vanished row) defers: that is no reason to consume its ticket. Pure. */
export function partitionByCorpusMembership(rows: readonly Ticket[], states: ReadonlyMap<string, ItemState>): TicketPartition {
  const out: TicketPartition = { selectable: [], archived: [], deferred: [] };
  for (const r of rows) {
    const st = states.get(r.intelligence_item_id);
    (!st ? out.deferred : st.is_archived === true ? out.archived : st.provenance_status === "verified" ? out.selectable : out.deferred).push(r);
  }
  return out;
}
/** The first `limit` rows in their existing (oldest-first) order. Pure. */
export const applyLimit = <T>(rows: readonly T[], limit: number | null | undefined): T[] => (Number.isInteger(limit) && (limit as number) > 0 ? rows.slice(0, limit as number) : [...rows]);
/** The distinct item ids of a set of tickets, in order. Pure. */
export const itemIdsOf = (rows: readonly Ticket[]): string[] => [...new Set(rows.map((r) => r.intelligence_item_id).filter(Boolean))];
/** The snapshot a run records when it selects: the ids a later mark retires. Pure over the rows and the caller's clock. */
export function buildSnapshot(selected: readonly Ticket[], opts: { generatedAt: string; archived?: readonly Ticket[]; deferredCount?: number }): TicketSnapshot {
  const by_reason: Record<string, number> = {};
  for (const r of selected) by_reason[r.reason ?? "unknown"] = (by_reason[r.reason ?? "unknown"] ?? 0) + 1;
  return { generated_at: opts.generatedAt, count: itemIdsOf(selected).length, by_reason, ids: itemIdsOf(selected), requests: [...selected], archived_requests: [...(opts.archived ?? [])], deferred_not_verified: opts.deferredCount ?? 0 };
}

/** The live state of every item a set of tickets names (chunked); an item that no longer exists is absent. A read error throws. */
export async function readItemStates(sb: Db, itemIds: readonly string[]): Promise<Map<string, ItemState>> {
  const rows = await rowsByIds<ItemState & { id: string }>(sb, "intelligence_items", "id, provenance_status, is_archived", itemIds);
  return new Map(rows.map((r) => [r.id, { provenance_status: r.provenance_status, is_archived: r.is_archived }]));
}
/** The open queue oldest first, partitioned, the limit applied to the selectable tickets only. */
export async function selectTickets(sb: Db, o: { limit?: number | null } = {}): Promise<TicketPartition & { totalOpen: number; chosen: Ticket[] }> {
  const open = await allRows<Ticket>(sb, "corpus_turn_requests", "id, intelligence_item_id, reason, requested_at", { order: "id", where: (q) => q.is("consumed_at", null) });
  const sorted = [...open].sort((a, b) => a.requested_at.localeCompare(b.requested_at) || a.id.localeCompare(b.id));
  const part = partitionByCorpusMembership(sorted, await readItemStates(sb, itemIdsOf(sorted)));
  return { ...part, totalOpen: sorted.length, chosen: applyLimit(part.selectable, o.limit) };
}

/** Stamp exactly these ticket ids consumed (still open only: a ticket consumed meanwhile is not re-stamped). Returns how many rows were stamped; a failed write throws. */
export async function consumeTickets(sb: Db, ids: readonly string[], by: string, nowIso: string): Promise<number> {
  let stamped = 0;
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from("corpus_turn_requests").update({ consumed_at: nowIso, consumed_by: by }).in("id", ids.slice(i, i + 100)).is("consumed_at", null).select("id");
    if (error) throw new Error(`corpus_turn_requests update failed: ${error.message}`);
    stamped += (data ?? []).length;
  }
  return stamped;
}
