// Ported from old_repo/scripts/entities/backfill-derivation-edges.mjs (lines 13-67)
// Author the derivation edges of the figures already landed: every live emission factor (carbon_intensity_tkm) and every market series
// (market_series_delta). The authors are the market slice's, passed in; authoring is idempotent by (input, method), so a re-run writes nothing new.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import type { RunResult } from "@/core/sources/run-result";

export interface EdgeAuthors {
  authorCarbonIntensityEdges(rows: { factor_id: string; source_key: string }[], ctx: { rows: unknown[] }, deps: { sb: Db }): Promise<Record<string, number>>;
  authorMarketSeriesDeltaEdges(seriesKeys: string[], mode: "apply", deps: { sb: Db }): Promise<Record<string, number>>;
}

export async function backfillDerivationEdges(deps: { sb: Db; now: () => Date; authors: EdgeAuthors }, input: { dry: boolean; limit?: number }): Promise<RunResult> {
  const { sb } = deps;
  let ef = await fetchAllRows<{ factor_id: string; source_key: string }>((from, to) => sb.from("emission_factors").select("factor_id, source_key").is("superseded_by", null).order("factor_id", { ascending: true }).range(from, to), { cap: 200_000 });
  const seriesRows = await fetchAllRows<{ series_key: string }>((from, to) => sb.from("market_series").select("series_key").order("series_key", { ascending: true }).range(from, to), { cap: 2_000_000 });
  let keys = [...new Set(seriesRows.map((r) => r.series_key).filter(Boolean))];
  if (input.limit) {
    ef = ef.slice(0, input.limit);
    keys = keys.slice(0, input.limit);
  }
  const counts: Record<string, number> = { emission_factors: ef.length, market_series: keys.length };
  if (input.dry) return { counts, outcome: "ok", notes: ["dry: nothing authored"] };
  const efCounts = await deps.authors.authorCarbonIntensityEdges(ef, { rows: ef }, { sb });
  const seriesCounts = await deps.authors.authorMarketSeriesDeltaEdges(keys, "apply", { sb });
  for (const [k, v] of Object.entries(efCounts)) counts[`ef_${k}`] = v;
  for (const [k, v] of Object.entries(seriesCounts)) counts[`series_${k}`] = v;
  const errored = (efCounts.errored ?? 0) + (seriesCounts.errored ?? 0);
  const authored = (efCounts.authored ?? 0) + (seriesCounts.authored ?? 0);
  return { counts, outcome: errored === 0 ? "ok" : authored > 0 ? "partial" : "failed", notes: errored ? [`${errored} figure(s) errored`] : [] };
}
