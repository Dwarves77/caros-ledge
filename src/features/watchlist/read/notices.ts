// Ported from old_repo/src/app/api/notices/route.ts (lines 29-96)
// Ported from old_repo/src/app/api/notices/logic.ts (lines 1-34)
// Ported from old_repo/src/app/api/notices/resolve-watched-entities.ts (lines 1-84)
// Recalculation notices: the old and new derived values of the entities the WORKSPACE watches, since a date. Watched items and sources map to their entity (the item's instrument, its entity refs,
// the source's organisation); every read checks its error and the whole read rejects, so an outage never reads as "nothing was recalculated" (INV-263).
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import { isUuid } from "@/core/http/parse";
import { fetchSupersededNotices, type SupersededNotice } from "@/core/propagation";

import { ITEM_BACKED } from "../links";

/** What a recalculation notice looks at: the last 30 days. */
export const NOTICE_WINDOW_DAYS = 30;
export interface WatchNotice extends SupersededNotice {
  entityLabel: string | null;
}
export interface NoticesRead {
  notices: WatchNotice[];
  /** The start of the window, an ISO instant. */
  since: string;
}

async function entityIdsOf(db: Db, watched: { item_type: string; item_id: string }[]): Promise<string[]> {
  const ids = new Set<string>();
  const of = (type: (t: string) => boolean) => [...new Set(watched.filter((w) => type(w.item_type)).map((w) => w.item_id))];
  const read = async <T,>(keys: string[], run: (slice: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> =>
    fetchAllByIdChunks(keys, async (slice) => {
      const { data, error } = await run(slice);
      if (error) throw new Error(`notices: ${what} read failed: ${error.message}`);
      return (data ?? []) as T[];
    }, { manyPerId: true });
  // A watched item is keyed by the id the page used: its uuid, or its legacy id. Both resolve to the item before its entities are looked up (the old read matched uuids only).
  const keys = of((t) => ITEM_BACKED.has(t));
  const item = (column: "id" | "legacy_id", list: string[]) => read<{ id: string; instrument_entity_id: string | null }>(list, (s) => db.from("intelligence_items").select("id, instrument_entity_id").in(column, s), "intelligence_items");
  const found = [...(await item("id", keys.filter((k) => isUuid(k)))), ...(await item("legacy_id", keys.filter((k) => !isUuid(k))))];
  const [refs, bySource, bySeries] = await Promise.all([
    read<{ entity_id: string }>(found.map((i) => i.id), (s) => db.from("entity_refs").select("entity_id").eq("ref_table", "intelligence_items").in("ref_id", s), "entity_refs"),
    read<{ organisation_entity_id: string | null }>(of((t) => t === "source"), (s) => db.from("sources").select("organisation_entity_id").in("id", s), "sources"),
    read<{ entity_id: string | null }>(of((t) => t === "market_series"), (s) => db.from("market_series").select("entity_id").in("id", s), "market_series"),
  ]);
  for (const r of found) if (r.instrument_entity_id) ids.add(r.instrument_entity_id);
  for (const r of refs) ids.add(r.entity_id);
  for (const r of bySource) if (r.organisation_entity_id) ids.add(r.organisation_entity_id);
  for (const r of bySeries) if (r.entity_id) ids.add(r.entity_id);
  return [...ids];
}

/** The notices for the workspace's team watchlist. `now` is the request's one instant. */
export async function readNotices(db: Db, orgId: string, now: Date): Promise<NoticesRead> {
  const since = new Date(now.getTime() - NOTICE_WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await db.from("org_watchlist").select("item_type, item_id").eq("org_id", orgId);
  if (error) throw new Error(`notices: org_watchlist read failed: ${error.message}`);
  const entities = await entityIdsOf(db, (data ?? []) as { item_type: string; item_id: string }[]);
  const found = await fetchSupersededNotices(db, entities, since);
  const labelled = [...new Set(found.map((n) => n.entityId).filter((id): id is string => !!id))];
  const names = new Map((await fetchAllByIdChunks(labelled, async (slice) => {
    const { data: rows, error: labelError } = await db.from("entities").select("entity_id, canonical_name, display_name").in("entity_id", slice);
    if (labelError) throw new Error(`notices: entities read failed: ${labelError.message}`);
    return (rows ?? []) as { entity_id: string; canonical_name: string; display_name: string | null }[];
  })).map((e) => [e.entity_id, e.display_name || e.canonical_name]));
  return { notices: found.map((n) => ({ ...n, entityLabel: (n.entityId && names.get(n.entityId)) || null })), since };
}
