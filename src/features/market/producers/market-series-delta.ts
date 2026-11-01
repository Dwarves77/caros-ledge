// Ported from old_repo/scripts/producers/market/author-market-series-delta.mjs (lines 1-157)
// Ported from old_repo/src/lib/market/write-market-series.mjs (lines 20-67)
// Rule 17 for every market_series writer: after the write, author the 1-week delta edge of each touched series, and fail CLOSED when rows changed but no edge was authored.
import { createHash } from "node:crypto";

import { fetchAllRows, type Db } from "@/core/db";
import { authorEdges, type MethodRegistry } from "@/core/propagation";
import { MARKET_DELTA_METHOD_ID, MARKET_DELTA_METHOD_VERSION } from "@/core/propagation/methods";
import type { PlanSpec, ProducerCtx, ProducerSpec } from "@/core/producers/runner";
import type { Rec } from "@/core/producers/upsert-plan";
import { KEYS } from "@/core/producers/upsert-plan";

import { isRatified, readSeriesItemMap } from "./market-series-items";

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
      // A one-week delta stands on a prior 5 to 9 days before the latest (lib/deltas.ts), so the window read is all the method can use; a series with no such prior has no one-week edge.
      const rows = inWindow;
      t(`${seriesKey}: ${rows.length} row(s) in the ${LOOKBACK_DAYS}-day window (cutoff ${cutoff})`);
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

/** Fail closed: real rows landed but DAG authorship produced no edge and either accounted for no series at all (the defect that shipped silently for every producer run) or refused or errored on one. A series with no prior 5 to 9 days back is a stated count (insufficientHistory), not a failure. Throws. */
function assertEdgesAuthored(o: { rowsChanged: number; edgesAuthored: number; accounted: number; failed: number }): void {
  if (o.rowsChanged > 0 && o.edgesAuthored === 0 && (o.accounted === 0 || o.failed > 0)) {
    throw new Error(`assertEdgesAuthored: this run wrote ${o.rowsChanged} row(s) to market_series but authored 0 derivation_edges; authorship was called and had no effect. Re-run with trace to see which outcome bucket each touched series_key landed in (insufficientHistory, unitMismatch, refused, unknownMethod, errored).`);
  }
}

/** The edge half of the `after` hook: author the edges of the touched series, assert, and report the counts. A point older than the edge window (a dated backfill) has no week to compare and is counted as `edges_not_due`, never as a missing edge. */
async function afterEdges(ctx: ProducerCtx, written: { rows: Rec[]; created: Rec[]; updated: Rec[] }): Promise<Record<string, number>> {
  const m = marketDeps(ctx);
  const cutoff = new Date(ctx.now().getTime() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const due = (rs: Rec[]) => rs.filter((r) => String(r.reference_period ?? r.as_at_date ?? "") >= cutoff);
  const touched = due(written.rows);
  if (!touched.length && written.rows.length) return { edges_not_due: written.rows.length };
  const { counts } = await authorMarketSeriesDeltaEdges(ctx.sb as Db, touched.map((r) => String(r.series_key)), "apply", { ...m, now: ctx.now, trace: ctx.input.trace === true });
  assertEdgesAuthored({ rowsChanged: due(written.created).length + due(written.updated).length, edgesAuthored: counts.authored, accounted: counts.authored + counts.skippedAlready + counts.insufficientHistory + counts.unitMismatch, failed: counts.refused + counts.unknownMethod + counts.errored });
  return { edges_authored: counts.authored, edges_already: counts.skippedAlready, edges_insufficient_history: counts.insufficientHistory, edges_unit_mismatch: counts.unitMismatch, edges_refused: counts.refused, edges_unknown_method: counts.unknownMethod, edges_errored: counts.errored, edges_not_due: written.rows.length - touched.length };
}

/** The declared transform that renders a structured-file row to its capture text (migration 0149, ruling 68). */
const SERIES_TRANSFORM = Object.freeze({ name: "xlsx-row-text", version: "1.0.0" });
/** A producer's rendering of one observation: the bulletin file it read, the one sentence the transform made of the row, and the locale of the number text in it. */
export interface SeriesCapture {
  url: string;
  text: string;
  locale: string;
}
/** The dedup key of a series capture (agent_run_searches.search_query, unique per item while transform is set). */
export const seriesCaptureQuery = (seriesKey: string, period: string): string => `series:${seriesKey}@${period}`;
interface CaptureCounts {
  /** Touched rows whose series is ratified onto an item. */
  ratified: number;
  /** Of those, (item, week) captures the producer rendered. */
  planned: number;
  filed: number;
  already: number;
}
const sha256 = (text: string): string => createHash("sha256").update(text.replace(/\s+/g, " ")).digest("hex");

/** Rule 17 for the figures: file ONE capture per (ratified item, series, week) a producer rendered, so a brief can quote the week's value verbatim (ADR-016). A re-run finds them by search_query and writes nothing; a changed text or URL updates the row. Dry plans and counts, writes nothing. */
async function fileSeriesCaptures(sb: Db, rows: Rec[], o: { dry: boolean; now: () => Date; captures: ReadonlyMap<string, SeriesCapture> }): Promise<CaptureCounts> {
  const itemOf = new Map((await readSeriesItemMap(sb)).filter(([, e]) => isRatified(e)).map(([k, e]) => [k, e.item_id as string]));
  const plan = new Map<string, { item: string; query: string; title: string; cap: SeriesCapture }>();
  let ratified = 0;
  for (const r of rows) {
    const item = itemOf.get(String(r.series_key));
    if (!item) continue;
    ratified += 1;
    const query = seriesCaptureQuery(String(r.series_key), String(r.reference_period));
    const cap = o.captures.get(query);
    if (cap) plan.set(`${item}|${query}`, { item, query, title: String(r.source_ref ?? query), cap });
  }
  const todo = [...plan.values()];
  const held = new Map<string, { id: string; result_url: string | null; result_content: string | null }>();
  for (let i = 0; i < todo.length; i += 100) {
    const queries = todo.slice(i, i + 100).map((t) => t.query);
    for (const x of await fetchAllRows<{ id: string; intelligence_item_id: string; search_query: string; result_url: string | null; result_content: string | null }>((from, to) => sb.from("agent_run_searches").select("id, intelligence_item_id, search_query, result_url, result_content").in("search_query", queries).order("id", { ascending: true }).range(from, to) as never, { cap: 100_000 })) held.set(`${x.intelligence_item_id}|${x.search_query}`, x);
  }
  const out: CaptureCounts = { ratified, planned: todo.length, filed: 0, already: 0 };
  const searchedAt = o.now().toISOString();
  const fresh: Rec[] = [];
  for (const t of todo) {
    const have = held.get(`${t.item}|${t.query}`);
    const fields = { result_url: t.cap.url, result_content: t.cap.text, content_hash: sha256(t.cap.text), number_locale: t.cap.locale };
    if (!have) fresh.push({ intelligence_item_id: t.item, search_query: t.query, result_title: t.title, result_index: 0, searched_at: searchedAt, capture_channel: "direct", transform: SERIES_TRANSFORM.name, transform_version: SERIES_TRANSFORM.version, ...fields });
    else if (have.result_url === t.cap.url && have.result_content === t.cap.text) out.already += 1;
    else if (!o.dry) {
      const { error } = await sb.from("agent_run_searches").update(fields as never).eq("id", have.id);
      if (error) throw new Error(`update of the series capture ${t.query} failed: ${error.message}`);
      out.filed += 1;
    }
  }
  for (let i = 0; i < fresh.length; i += 100) {
    const part = fresh.slice(i, i + 100);
    if (o.dry) continue;
    const { error } = await sb.from("agent_run_searches").insert(part as never);
    if (error) throw new Error(`insert of ${part.length} series capture(s) failed: ${error.message}`);
    out.filed += part.length;
  }
  return out;
}

/** Fail closed (INV-PC-4): rows changed for a series that is ratified onto an item, and no capture filed or already held. Throws. */
function assertCapturesFiled(o: { rowsChanged: number; ratified: number; filed: number; already: number }): void {
  if (o.rowsChanged > 0 && o.ratified > 0 && o.filed + o.already === 0) throw new Error(`assertCapturesFiled: this run wrote ${o.rowsChanged} row(s) for ${o.ratified} ratified series row(s) but filed 0 captures; the weekly figures could not be quoted by a brief. The producer rendered no capture text for them.`);
}

/** The `after` hook every market_series producer uses: the delta edges, then (for a producer that renders its rows as text) the captures a brief quotes. Both fail the run closed. */
export async function afterMarketWrite(ctx: ProducerCtx, written: { rows: Rec[]; created: Rec[]; updated: Rec[] }): Promise<Record<string, number>> {
  const edges = await afterEdges(ctx, written);
  const captures = ctx.state.seriesCaptures as ReadonlyMap<string, SeriesCapture> | undefined;
  if (!captures) return edges;
  const c = await fileSeriesCaptures(ctx.sb as Db, written.rows, { dry: !ctx.apply, now: ctx.now, captures });
  assertCapturesFiled({ rowsChanged: written.created.length + written.updated.length, ratified: c.ratified, filed: c.filed, already: c.already });
  return { ...edges, captures_filed: c.filed, captures_already: c.already, captures_planned: c.planned };
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
