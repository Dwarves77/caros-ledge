// Ported from old_repo/scripts/producers/market/author-market-series-delta.mjs (lines 1-157)
// Ported from old_repo/src/lib/market/write-market-series.mjs (lines 20-67)
// Rule 17 for every market_series writer: after the write, author the 1-week delta edge of each touched series, and fail CLOSED when rows changed but no edge was authored.
import { fetchAllRows, type Db } from "@/core/db";
import { authorEdges, type MethodRegistry } from "@/core/propagation";
import { MARKET_DELTA_METHOD_ID, MARKET_DELTA_METHOD_VERSION } from "@/core/propagation/methods";
import type { PlanSpec, ProducerCtx, ProducerSpec } from "@/core/producers/runner";
import type { Rec } from "@/core/producers/upsert-plan";
import { KEYS } from "@/core/producers/upsert-plan";

const LOOKBACK_DAYS = 21;
const SELECT = "id, series_key, reference_period, as_at_date, value_numeric, unit, currency, origin_class";

/** What the market surface lib supplies (P2-08 wires it): the delta arithmetic, and the registry with the market methods registered. */
export interface SeriesRowLite {
  id: string;
  series_key: string;
  reference_period: string | null;
  as_at_date: string | null;
  [k: string]: unknown;
}
export interface MarketSeriesDeps {
  registry: MethodRegistry;
  computeSeriesDeltas(rows: SeriesRowLite[]): { latest?: { date?: string | null; unit?: string | null; currency?: string | null } | null; delta1w?: { value?: number; unitMismatch?: boolean; insufficientHistory?: boolean; fromDate?: string } | null };
}
const marketDeps = (ctx: ProducerCtx): MarketSeriesDeps => {
  const m = (ctx.deps as unknown as { market?: MarketSeriesDeps }).market;
  if (!m) throw new Error("market_series edge authorship is not wired: deps.market (registry + computeSeriesDeltas) is missing, and a market write without its edges fails closed");
  return m;
};

export interface DeltaCounts {
  authored: number;
  skippedAlready: number;
  insufficientHistory: number;
  unitMismatch: number;
  refused: number;
  unknownMethod: number;
  errored: number;
}
const pointDate = (r: SeriesRowLite): string | null => r.reference_period ?? r.as_at_date ?? null;

/** Author the delta edges of every DISTINCT series key a run touched. Dry mode authors nothing. */
async function authorMarketSeriesDeltaEdges(sb: Db, seriesKeys: Iterable<string>, mode: "dry" | "apply", deps: MarketSeriesDeps & { now: () => Date; trace?: boolean }): Promise<{ counts: DeltaCounts; trace: string[] }> {
  const counts: DeltaCounts = { authored: 0, skippedAlready: 0, insufficientHistory: 0, unitMismatch: 0, refused: 0, unknownMethod: 0, errored: 0 };
  const trace: string[] = [];
  const t = (line: string) => deps.trace && trace.push(`market_series_delta: ${line}`);
  const keys = [...new Set(seriesKeys)].filter(Boolean);
  t(`keys received: [${keys.join(", ")}] mode=${mode}`);
  if (mode !== "apply" || !keys.length) return { counts, trace };
  const cutoffDate = new Date(deps.now().getTime());
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - LOOKBACK_DAYS);
  const cutoff = cutoffDate.toISOString().slice(0, 10);
  for (const seriesKey of keys) {
    try {
      const inWindow = await fetchAllRows<SeriesRowLite>((from, to) => sb.from("market_series").select(SELECT).eq("series_key", seriesKey).gte("reference_period", cutoff).order("id", { ascending: true }).range(from, to) as never, { cap: 5000 });
      // The comparator is the nearest observation at or before the window start (INV-252), however old: a series observed every few weeks has its prior outside any fixed window, and reading only the window made it look like a first observation (FIX-EDGES-1).
      const before = await sb.from("market_series").select(SELECT).eq("series_key", seriesKey).lt("reference_period", cutoff).order("reference_period", { ascending: false }).limit(1) as unknown as { data: SeriesRowLite[] | null; error: { message: string } | null };
      if (before.error) throw new Error(`market_series prior read failed for ${seriesKey}: ${before.error.message}`);
      const rows = [...(before.data ?? []), ...inWindow];
      t(`${seriesKey}: ${inWindow.length} row(s) in the ${LOOKBACK_DAYS}-day window (cutoff ${cutoff}) and ${before.data?.length ?? 0} prior to it`);
      if (rows.length < 2) {
        counts.insufficientHistory += 1;
        continue;
      }
      const deltas = deps.computeSeriesDeltas(rows);
      const d = deltas.delta1w;
      if (!d || d.insufficientHistory) {
        counts.insufficientHistory += 1;
        continue;
      }
      if (d.unitMismatch) {
        counts.unitMismatch += 1;
        continue;
      }
      const latest = rows.find((r) => pointDate(r) === deltas.latest?.date);
      const prior = rows.find((r) => pointDate(r) === d.fromDate);
      if (!latest || !prior) {
        counts.insufficientHistory += 1;
        continue;
      }
      const res = await authorEdges(sb, { table: "market_series", id: latest.id, entity: null, method: { id: MARKET_DELTA_METHOD_ID, version: MARKET_DELTA_METHOD_VERSION }, inputs: [{ table: "market_series", pk: latest.id }, { table: "market_series", pk: prior.id }] }, { now: deps.now, registry: deps.registry });
      if (!res.ok) {
        if (res.action === "unknown-method") counts.unknownMethod += 1;
        else counts.refused += 1;
        t(`${seriesKey}: authorEdges refused, action=${res.action} reason=${res.reason}`);
      } else if (res.action === "skipped-already-authored") counts.skippedAlready += 1;
      else counts.authored += 1;
    } catch (err) {
      counts.errored += 1;
      t(`${seriesKey}: ERROR ${(err as Error).message}`);
    }
  }
  return { counts, trace };
}

/** Fail closed: real rows landed but DAG authorship produced no edge (the defect that shipped silently for every producer run). Throws. */
function assertEdgesAuthored(o: { rowsChanged: number; edgesAuthored: number }): void {
  if (o.rowsChanged > 0 && o.edgesAuthored === 0) {
    throw new Error(`assertEdgesAuthored: this run wrote ${o.rowsChanged} row(s) to market_series but authored 0 derivation_edges; authorship was called and had no effect. Re-run with trace to see which outcome bucket each touched series_key landed in (insufficientHistory, unitMismatch, refused, unknownMethod, errored).`);
  }
}

/** The `after` hook every market_series producer uses: author the edges of the touched series, assert, and report the counts. A point older than the edge window (a dated backfill) has no week to compare and is counted as `edges_not_due`, never as a missing edge. */
export async function afterMarketWrite(ctx: ProducerCtx, written: { rows: Rec[]; created: Rec[]; updated: Rec[] }): Promise<Record<string, number>> {
  const m = marketDeps(ctx);
  const cutoff = new Date(ctx.now().getTime() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const due = (rs: Rec[]) => rs.filter((r) => String(r.reference_period ?? r.as_at_date ?? "") >= cutoff);
  const touched = due(written.rows);
  if (!touched.length && written.rows.length) return { edges_not_due: written.rows.length };
  const { counts } = await authorMarketSeriesDeltaEdges(ctx.sb as Db, touched.map((r) => String(r.series_key)), "apply", { ...m, now: ctx.now, trace: ctx.input.trace === true });
  assertEdgesAuthored({ rowsChanged: due(written.created).length + due(written.updated).length, edgesAuthored: counts.authored });
  return { edges_authored: counts.authored, edges_already: counts.skippedAlready, edges_insufficient_history: counts.insufficientHistory, edges_unit_mismatch: counts.unitMismatch, edges_refused: counts.refused, edges_unknown_method: counts.unknownMethod, edges_errored: counts.errored, edges_not_due: written.rows.length - touched.length };
}

/** The envelope and label fields a producer may refresh on an existing market_series row; identity and key fields are excluded. */
const REFRESHABLE_FIELDS = ["label", "value_numeric", "unit", "currency", "derivation", "origin_class", "source_key", "source_ref", "n_observations", "method_version", "as_at_date"] as const;

/** The keyed plan of a market_series producer: existing rows read by the producer's own key prefix (one bounded paginated read), keyed (series_key, reference_period). */
const marketPlan = (prefix: string): PlanSpec<Rec> => ({
  read: (sb) => fetchAllRows<Rec>((from, to) => sb.from("market_series").select(`id, series_key, reference_period, ${REFRESHABLE_FIELDS.join(", ")}`).like("series_key", `${prefix}:%`).order("id", { ascending: true }).range(from, to) as never, { cap: 200_000 }),
  key: KEYS.seriesPeriod,
  patchable: REFRESHABLE_FIELDS,
  pk: "id",
});

/** Fields every market_series spec shares: the table, the plan, the downstream. */
export const marketSeriesBase = (prefix: string): Pick<ProducerSpec, "table" | "plan" | "after"> => ({ table: "market_series", plan: marketPlan(prefix), after: afterMarketWrite });

/** Rows a registry entry describes carry its entity (never an ambient one): stamped at create time; existing rows are backfilled by the dedicated entity backfill. */
export const stampEntity = <R extends Rec>(rows: R[], ctx: ProducerCtx): R[] => (ctx.entityId ? rows.map((r) => ({ ...r, entity_id: r.entity_id ?? ctx.entityId })) : rows);
