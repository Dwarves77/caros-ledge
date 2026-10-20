// Ported from old_repo/src/lib/supabase-server.ts (lines 4425-4551)
// Ported from old_repo/src/lib/supabase-server.ts (lines 4570-4702)
// Ported from old_repo/src/lib/supabase-server.ts (lines 4720-4985)
// Ported from old_repo/src/lib/data.ts (lines 682-789)
// The watchlist read: the caller's personal rows and the workspace's team rows (RLS binds both to the caller), one dedup (personal wins), then ONE lookup per table in parallel. Item-backed rows
// go through the lists' own mapper (timelines, source rating) so a watched row draws exactly what the list draws; a source or a series is labelled by its own name; a row the read gate hides is
// said to be unavailable, never titled with its raw id. Every read checks its error and the whole read rejects: a failure is never an empty watchlist (INV-263).
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import { isUuid } from "@/core/http/parse";
import { dueInfo, toListRowFields, type ListRowFields } from "@/core/lists";
import { loadRoster, nameIndex } from "@/core/workspace";
import { enrichSources, mapRows, type WorkspaceItemRpcRow } from "@/features/lists";

import { ITEM_BACKED, type WatchlistItemType, type WatchlistScope } from "../links";

/** The rail asks for the 14 most recent per scope, the page for 250. */
export const WATCHLIST_RAIL_LIMIT = 14;
export const WATCHLIST_PAGE_LIMIT = 250;
const UNAVAILABLE_TITLE = "Item no longer available";
const ITEM_COLUMNS = "id, legacy_id, title, summary, tags, domain, category, item_type, source_id, source_url, jurisdictions, transport_modes, priority, compliance_deadline, added_date, is_archived, item_grade, origin_class, last_regenerated_at, jurisdiction_iso";

export interface WatchlistItem {
  id: string;
  type: WatchlistItemType;
  scope: WatchlistScope;
  title: string;
  watchedAt: string;
  note: string | null;
  addedBy: string | null;
  /** The list-row fields of an item the read gate returned; null for a source, a series, or an item that is no longer published. */
  fields: ListRowFields | null;
  /** Whole days to the item's nearest future binding date (UTC days), or null; the page sorts on it. */
  dueDays: number | null;
}
export interface WatchlistRead {
  items: WatchlistItem[];
  /** A scope returned as many rows as asked for: older watches exist and are not listed. */
  capped: boolean;
  /** The source ratings did not load: the rows carry no tier and the surface says so. */
  ratingsFailed: boolean;
  /** Some rows' milestone read failed: they carry no timeline and the surface says so. */
  timelinesFailed: boolean;
}
/** Next date first (an undated row after the dated), the most recent watch first among equals: the order the card's aside states. */
export const byNextDate = (a: WatchlistItem, b: WatchlistItem): number => (a.dueDays ?? Infinity) - (b.dueDays ?? Infinity) || b.watchedAt.localeCompare(a.watchedAt);

interface WatchRow {
  item_type: WatchlistItemType;
  item_id: string;
  created_at: string;
  scope: WatchlistScope;
  note: string | null;
  added_by_user_id: string | null;
}

async function rows(db: Db, scope: WatchlistScope, key: string, limit: number): Promise<WatchRow[]> {
  const table = scope === "personal" ? "user_watchlist" : "org_watchlist";
  const column = scope === "personal" ? "user_id" : "org_id";
  const cols = scope === "personal" ? "item_type, item_id, created_at" : "item_type, item_id, created_at, note, added_by_user_id";
  const { data, error } = await db.from(table).select(cols).eq(column, key).order("created_at", { ascending: false }).limit(limit);
  if (error) throw new Error(`${table} read failed: ${error.message}`);
  return ((data ?? []) as unknown as Partial<WatchRow>[]).map((r) => ({ item_type: r.item_type as WatchlistItemType, item_id: r.item_id as string, created_at: r.created_at as string, scope, note: r.note ?? null, added_by_user_id: r.added_by_user_id ?? null }));
}

async function byIds<T>(ids: string[], read: (slice: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  return fetchAllByIdChunks(ids, async (slice) => {
    const { data, error } = await read(slice);
    if (error) throw new Error(`${what} read failed: ${error.message}`);
    return (data ?? []) as T[];
  });
}

/** The caller's watchlist, newest watch first, with the display fields of every row. Rejects when any read fails. */
export async function readWatchlist(db: Db, who: { userId: string; orgId: string | null }, limit: number, now: Date): Promise<WatchlistRead> {
  const [personal, team] = await Promise.all([rows(db, "personal", who.userId, limit), who.orgId ? rows(db, "team", who.orgId, limit) : Promise.resolve([] as WatchRow[])]);
  const seen = new Set<string>();
  const all = [...personal, ...team].filter((r) => !seen.has(`${r.item_type}:${r.item_id}`) && (seen.add(`${r.item_type}:${r.item_id}`), true)).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const capped = personal.length >= limit || team.length >= limit;
  if (all.length === 0) return { items: [], capped, ratingsFailed: false, timelinesFailed: false };

  const of = (type: (t: string) => boolean) => [...new Set(all.filter((r) => type(r.item_type)).map((r) => r.item_id))];
  const itemKeys = of((t) => ITEM_BACKED.has(t));
  const uuidKeys = itemKeys.filter((k) => isUuid(k));
  const legacyKeys = itemKeys.filter((k) => !isUuid(k));
  const adders = [...new Set(all.map((r) => r.added_by_user_id).filter((id): id is string => !!id))];
  const itemRead = (column: "id" | "legacy_id", keys: string[]) => byIds<WorkspaceItemRpcRow>(keys, (slice) => db.from("intelligence_items").select(ITEM_COLUMNS).eq("provenance_status", "verified").in(column, slice), "intelligence_items");
  const [byUuid, byLegacy, sources, series, roster] = await Promise.all([
    itemRead("id", uuidKeys),
    itemRead("legacy_id", legacyKeys),
    byIds<{ id: string; name: string }>(of((t) => t === "source"), (slice) => db.from("sources").select("id, name").in("id", slice), "sources"),
    byIds<{ id: string; label: string }>(of((t) => t === "market_series"), (slice) => db.from("market_series").select("id, label").in("id", slice), "market_series"),
    adders.length > 0 && who.orgId ? loadRoster(db, who.orgId) : Promise.resolve([]),
  ]);

  const itemRows = [...byUuid, ...byLegacy];
  const mapped = await mapRows(db, itemRows, { orgId: who.orgId ?? null });
  const resources = [...mapped.active, ...mapped.archived];
  const enriched = await enrichSources(db, resources, { biasTags: true });
  const resourceById = new Map(resources.map((r) => [r.id, r]));
  const resourceOf = new Map<string, (typeof resources)[number]>();
  for (const row of itemRows) {
    const resource = resourceById.get(mapped.uuidToUiId.get(row.id) ?? row.id);
    if (resource) [row.id, row.legacy_id].forEach((k) => k && resourceOf.set(k, resource));
  }
  const sourceName = new Map(sources.map((s) => [s.id, s.name]));
  const seriesLabel = new Map(series.map((s) => [s.id, s.label]));
  const names = nameIndex(roster);

  const items = all.map((r): WatchlistItem => {
    const resource = ITEM_BACKED.has(r.item_type) ? resourceOf.get(r.item_id) : undefined;
    const title = resource?.title ?? (r.item_type === "source" ? sourceName.get(r.item_id) : r.item_type === "market_series" ? seriesLabel.get(r.item_id) : undefined) ?? UNAVAILABLE_TITLE;
    return { id: r.item_id, type: r.item_type, scope: r.scope, title, watchedAt: r.created_at, note: r.note, addedBy: r.added_by_user_id ? (names.get(r.added_by_user_id) ?? null) : null, fields: resource ? toListRowFields(resource, now) : null, dueDays: resource ? (dueInfo(resource, now)?.daysNum ?? null) : null };
  });
  return { items, capped, ratingsFailed: !enriched, timelinesFailed: mapped.timelineFailures > 0 };
}
