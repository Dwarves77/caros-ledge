// Ported from old_repo/src/lib/supabase-server.ts (lines 877-893, 1213-1358)
// Ported from old_repo/src/lib/supabase-server.ts (lines 1383-1533)
// Ported from old_repo/src/lib/supabase-server.ts (lines 2516-2565, 2830-2843, 2910-2985)
// Ported from old_repo/src/lib/dashboard/surface-coverage.ts (lines 65-111)
// The Dashboard's reads, on the caller's own client (the rpcs assert the caller's membership). THREE reads for the rows: the nearest binding dates (get_workspace_due_next), the dated change feed
// (get_workspace_recent_changes, windowed by the scrape cadence) and ONE by-id backfill of the items either card can draw; then the changelog field of the updated ones. Two reads for the counts. Every
// read checks its error and the whole digest rejects: a failure is a stated failure, never an empty card (INV-263), and the cache above this refuses to keep it.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import { getScrapeState } from "@/core/fetch";
import type { Resource } from "@/core/types";
import { enrichSources, mapRows, readAggregates, readSurfaceCounts, readSurfaceTotals, type WorkspaceAggregates } from "@/features/lists";

import { recentChangesWindowDays, selectBriefResources, type Candidate, type FeedRow } from "../rows";

import { readItemRows, type FullRow } from "./items";

/** The due-next rpc returns this many, soonest first; the card draws the nearest few. */
const DUE_NEXT_READ = 24;

export interface Digest {
  dueNext: Resource[];
  feed: FeedRow[];
  candidates: Candidate[];
  /** intelligence_items.id to the newest changelog field of an UPDATED item. */
  changelogField: Record<string, string>;
  /** Only read when the feed is empty: the newest changelog date, so "Detection pass" is never made up. */
  lastChangelogDate: string | null;
  windowDays: number;
  /** The source ratings did not load: the rows carry no tier and the card says so. */
  ratingsFailed: boolean;
}

type Raw = FullRow;

async function rpc<T>(db: Db, fn: string, args: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return (data ?? []) as T[];
}

/** The digest for one workspace. Rejects when any read fails. */
export async function readDigest(db: Db, orgId: string): Promise<Digest> {
  const windowDays = recentChangesWindowDays((await getScrapeState(db)).cadence);
  const [due, feed] = await Promise.all([rpc<Raw>(db, "get_workspace_due_next", { p_org_id: orgId, p_limit: DUE_NEXT_READ }), rpc<FeedRow>(db, "get_workspace_recent_changes", { p_org_id: orgId, p_days: windowDays })]);
  const { changeIds } = selectBriefResources(due.map((d) => d.id), feed);
  const wanted = [...new Set([...due.map((d) => d.id), ...changeIds])];
  const backfill = await readItemRows(db, wanted);
  const raw = new Map(backfill.map((r) => [r.id, r]));
  const feedById = new Map(feed.map((f) => [f.id, f]));
  const dueRows = due.map((d) => ({ ...raw.get(d.id), ...d }) as Raw);
  const changeRows = changeIds.flatMap((id) => (raw.has(id) ? [{ ...(raw.get(id) as Raw), effective_priority: feedById.get(id)?.effective_priority ?? null }] : []));
  const [dueMapped, changeMapped] = await Promise.all([mapRows(db, dueRows), mapRows(db, changeRows)]);
  const dueNext = dueMapped.active;
  const changed = changeMapped.active;
  const ratings = await enrichSources(db, [...dueNext, ...changed], { biasTags: true });
  const uuidOf = new Map(changeRows.map((r) => [r.legacy_id || r.id, r.id]));
  const candidates = changed.map((resource): Candidate => ({ uuid: uuidOf.get(resource.id) ?? resource.id, resource, verticals: raw.get(uuidOf.get(resource.id) ?? "")?.verticals ?? [] }));

  const updated = changeIds.filter((id) => feedById.get(id)?.change_kind === "updated");
  const changelogField: Record<string, string> = {};
  for (const r of await fetchAllByIdChunks(updated, async (slice) => {
    const { data, error } = await db.from("item_changelog").select("item_id, field, change_date").eq("change_type", "UPDATED").in("item_id", slice).order("change_date", { ascending: false });
    if (error) throw new Error(`item_changelog read failed: ${error.message}`);
    return (data ?? []) as { item_id: string; field: string | null }[];
  }, { manyPerId: true })) if (r.field && !(r.item_id in changelogField)) changelogField[r.item_id] = r.field;

  let lastChangelogDate: string | null = null;
  if (feed.length === 0) {
    const { data, error } = await db.from("item_changelog").select("change_date").order("change_date", { ascending: false }).limit(1);
    if (error) throw new Error(`item_changelog read failed: ${error.message}`);
    lastChangelogDate = (data?.[0] as { change_date?: string } | undefined)?.change_date ?? null;
  }
  return { dueNext, feed, candidates, changelogField, lastChangelogDate, windowDays, ratingsFailed: !ratings };
}

export interface Counts {
  /** The regulations surface's own tallies: what the four band tiles count, because every tile opens that list. */
  regulations: WorkspaceAggregates;
  surfaces: { regulations: number; marketIntel: number; research: number; operations: number };
  aggregates: WorkspaceAggregates;
}

const must = <T>(v: T | null, what: string): T => {
  if (v === null) throw new Error(`${what} read failed`);
  return v;
};
/** The three count reads behind the band tiles, the "Across the platform" card and the masthead. Rejects when any is unknown: a count is a number or a failure, never a zero. */
export async function readCounts(db: Db, orgId: string): Promise<Counts> {
  const [regulations, surfaces, aggregates] = await Promise.all([readSurfaceCounts(db, orgId, "regulations"), readSurfaceTotals(db, orgId), readAggregates(db, orgId)]);
  return { regulations: must(regulations, "regulations counts"), surfaces: must(surfaces, "surface totals"), aggregates: must(aggregates, "workspace aggregates") };
}
