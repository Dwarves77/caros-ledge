// New in R2d (addendum A, operator ruling 2026-10-20: "items per source is at least 1 for every source once collected; fewer items than sources means uncollected, and the system must say so").
// The source coverage ledger, read from the `source_coverage` view (migration 0092) and nowhere else: how many public sources are collected (hold at least one admissible item), refused, access-requested or not yet
// collected, and when the newest capture was made. The number of sources alone is never a coverage figure. A failed read throws; the view absent (production before the cutover) is the same stated failure.
import type { Db } from "@/core/db";
import { exactCount, fetchAllRows } from "@/core/db/query";
import { qb } from "@/core/db/qb";

const COVERAGE_STATES = ["collected", "uncollected", "refused", "access_requested"] as const;
export type CoverageSourceState = (typeof COVERAGE_STATES)[number];

export interface SourceCoverage {
  /** Public registry sources the view lists. */
  total: number;
  byState: Record<CoverageSourceState, number>;
  /** The newest capture among all of them, or null when none was ever captured. */
  lastCaptureAt: string | null;
}

/** The sources collected (the ids), for a reader that must count only collected sources (the map's region coverage). */
export async function readCollectedSourceIds(db: Db): Promise<Set<string>> {
  const rows = await fetchAllRows<{ source_id: string }>((from, to) => qb(db.from("source_coverage").select("source_id").eq("state", "collected")).order("source_id", { ascending: true }).range(from, to) as never, { cap: 200_000 });
  return new Set(rows.map((r) => r.source_id));
}

export async function readSourceCoverage(db: Db): Promise<SourceCoverage> {
  const count = (state?: CoverageSourceState) => {
    const q = qb(db.from("source_coverage").select("source_id", { count: "exact", head: true }));
    return exactCount((state ? q.eq("state", state) : q) as never);
  };
  const [total, ...parts] = await Promise.all([count(), ...COVERAGE_STATES.map((s) => count(s))]);
  const byState = Object.fromEntries(COVERAGE_STATES.map((s, i) => [s, parts[i] as number])) as Record<CoverageSourceState, number>;
  const counted = COVERAGE_STATES.reduce((n, s) => n + byState[s], 0);
  if (counted !== total) throw new Error(`source_coverage holds ${total} sources but ${counted} in the four states this reader knows: the view returned another state`);
  const newest = await qb<{ last_capture_at: string | null }>(db.from("source_coverage").select("last_capture_at").not("last_capture_at", "is", null)).order("last_capture_at", { ascending: false }).limit(1);
  if (newest.error) throw new Error(`source_coverage read failed: ${newest.error.message}`);
  return { total, byState, lastCaptureAt: newest.data?.[0]?.last_capture_at ?? null };
}

/** Sources not yet collected, from the view: every state but collected (a refused or access-requested source is not collected either). */
export const notCollected = (c: SourceCoverage): number => c.total - c.byState.collected;
