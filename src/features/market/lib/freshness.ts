// Ported from old_repo/src/lib/market/series-freshness.mjs (lines 1-81)
// Series freshness (INV-258): judged against the producer's registered cadence. The cadence maps to the exact named period when one exists, otherwise to the LONGEST named period not longer than it, so a series never reads
// fresher than its source (the old fallback took the shortest period not shorter, which read an off-grid cadence fresher). A null cadence or an unregistered series is unknown, the worst state governs a summary, and an empty list is unknown.
import { stalenessOf } from "@/core/contracts";
import { FRESHNESS, REFRESH_PERIOD_DAYS } from "@/core/contracts/vocabularies";

import type { SeriesBoard } from "./series-board";

export type FreshnessCode = "current" | "ageing" | "stale" | "frozen" | "unknown";
export interface SeriesFreshness {
  code: FreshnessCode;
  label: string;
  degraded: boolean;
  asOfDate: string | null;
  cadenceDays: number | null;
}

const NAMED = Object.entries(REFRESH_PERIOD_DAYS).filter((e): e is [string, number] => e[1] !== null);

function cadenceNameForDays(cadenceDays: number | null | undefined): string {
  if (cadenceDays === null || cadenceDays === undefined) return "irregular";
  const exact = NAMED.find(([, d]) => d === cadenceDays);
  if (exact) return exact[0];
  const notLonger = NAMED.filter(([, d]) => d <= cadenceDays).sort((a, b) => b[1] - a[1]);
  return (notLonger[0] ?? [...NAMED].sort((a, b) => a[1] - b[1])[0] ?? ["irregular"])[0];
}

/** One series row against its producer (null for an unregistered series). `nowIso` is the request's one instant. */
export function deriveSeriesFreshness(row: { as_at_date?: string | null; reference_period?: string | null }, producer: { cadenceDays: number | null } | null, nowIso: string): SeriesFreshness {
  const asOfDate = row.as_at_date ?? row.reference_period ?? null;
  const code = stalenessOf({ expected_refresh: producer ? cadenceNameForDays(producer.cadenceDays) : "irregular", as_of: { event_date: asOfDate ?? "", source_published_at: asOfDate } }, nowIso.slice(0, 10)) as FreshnessCode;
  const meta = FRESHNESS[code] as { label: string; degraded?: boolean };
  return { code, label: meta.label, degraded: meta.degraded === true, asOfDate, cadenceDays: producer?.cadenceDays ?? null };
}

function summarizeBoardFreshness(states: ReadonlyArray<{ code: string } | string>): { counts: Record<FreshnessCode, number>; total: number; worst: FreshnessCode } {
  const counts: Record<FreshnessCode, number> = { current: 0, ageing: 0, stale: 0, frozen: 0, unknown: 0 };
  const order = (c: FreshnessCode): number => (FRESHNESS[c] as { order?: number } | undefined)?.order ?? 0;
  let worst: FreshnessCode | null = null;
  for (const s of states) {
    const code = (typeof s === "string" ? s : s.code) as FreshnessCode;
    if (!(code in counts)) continue;
    counts[code] += 1;
    if (worst === null || order(code) > order(worst)) worst = code;
  }
  return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0), worst: worst ?? "unknown" };
}

/** The panel's summary over every POPULATED series on a board, each judged against its own producer's cadence. */
export type BoardFreshnessSummary = ReturnType<typeof summarizeBoardFreshness>;
export function boardFreshnessSummary(board: Pick<SeriesBoard, "groups">, nowIso: string): BoardFreshnessSummary {
  return summarizeBoardFreshness(board.groups.filter((g) => g.state === "populated").flatMap((g) => g.series.map((s) => deriveSeriesFreshness({ as_at_date: s.asAtDate, reference_period: s.referencePeriod }, g, nowIso))));
}
