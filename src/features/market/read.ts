// Ported from old_repo/src/lib/supabase-server.ts (lines 2260-2262)
// Ported from old_repo/src/lib/supabase-server.ts (lines 2272-2376)
// Ported from old_repo/src/lib/supabase-server.ts (lines 3596-3758)
// Ported from old_repo/src/lib/data.ts (lines 969-1032)
// Ported from old_repo/src/app/market/[slug]/page.tsx (lines 128-315)
// Ported from old_repo/src/components/market/IndexationPanel.tsx (lines 7-26)
// ONE reader for the Market surface, on the caller's client. Every part is a Section: a failed read is `{ ok: false }` and the page says so with Retry, never an empty list or a zero (INV-263). Each series figure comes WITH the
// rating of the source it cites (INV-262): the registry row of the source's host when one exists, else the institution class table. Tables read: intelligence_items (through the public RPC), market_series, data_sources,
// licence_clear_sources, sources, emission_factors, entities and entity_scope (corridors), published_price_statistics, market_series_items, oem_tech_roadmaps, reroute_events, indexation_clauses, derivation_edges (lineage, service client).
import { boundedRead, fetchAllByIdChunks, fetchAllRows, rowsByIds, type Db } from "@/core/db";
import { corridorScopes } from "@/core/entities";
import { classTierForHost, customerTierOf, readSourceByUrl } from "@/core/sources";
import { hostOf, log, resolveItemUuid } from "@/core/shared";
import type { Resource } from "@/core/types";
import { readCategory, readSurfaceCounts, type WorkspaceAggregates } from "@/features/lists";

import { addDaysIso } from "./producers/published-price-statistics";
import { buildCarbonCostOverlays, candidatesFromCorridorEntities, type CarbonOverlayEntry, type CorridorCandidate, type FactorRow } from "./lib/carbon";
import type { LeadTimeRow } from "./lib/lead-time";
import { prefixOf, producerFor } from "./lib/registry";
import { buildSeriesBoard, type SeriesBoard, type SeriesDisplayRow, type SeriesRow } from "./lib/series-board";
import type { SourceRating } from "./lib/provenance";

export type Section<T> = { ok: true; data: T } | { ok: false; error: string };
/** Run one part of the page: a thrown read becomes a named failure for that part alone, logged with its cause. */
export async function section<T>(name: string, run: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.warn(`[market] ${name} read failed: ${error}`);
    return { ok: false, error };
  }
}

const SERIES_COLS = "id, series_key, label, value_numeric, unit, currency, derivation, origin_class, source_key, source_ref, n_observations, method_version, as_at_date, reference_period";
/** The history a series needs: the year-over-year change and the one-year trend, plus a margin. */
const WINDOW_DAYS = 400;

/** Per series, the rows within the window counted back from ITS OWN latest period (never the clock); the latest row is always kept, so a quiet series is still on the board. */
export function perSeriesWindow(rows: readonly SeriesRow[]): SeriesRow[] {
  const latest = new Map<string, string>();
  for (const r of rows) if (r.reference_period && r.reference_period > (latest.get(r.series_key) ?? "")) latest.set(r.series_key, r.reference_period);
  return rows.filter((r) => {
    const top = latest.get(r.series_key);
    const cutoff = top && /^\d{4}-\d{2}-\d{2}/.test(top) ? addDaysIso(top.slice(0, 10), -WINDOW_DAYS) : null;
    return !cutoff || !r.reference_period || r.reference_period >= cutoff;
  });
}

/** Every market_series row (a total order, a cap that throws, never a silent truncation), reduced to each series' window. */
export async function readSeriesRows(db: Db): Promise<SeriesRow[]> {
  const rows = await fetchAllRows<SeriesRow>((from, to) => db.from("market_series").select(SERIES_COLS).order("id", { ascending: true }).range(from, to) as never, { cap: 100_000 });
  return perSeriesWindow(rows);
}

interface DataSourceRow {
  source_key: string;
  name: string | null;
  url: string | null;
}
interface LicenceRow {
  source_key: string;
  licence: string | null;
  attribution: string | null;
}
interface RegistryTierRow {
  id: string;
  name: string | null;
  base_tier: number | null;
  effective_tier: number | null;
  tier_override: number | null;
}

/**
 * The rating of each data source: customerTierOf the registry row of its host (override, then effective, then base), else the institution class table's tier for the host; licence and attribution only from the licence gate
 * (a source that does not permit redistribution carries none). A read error throws.
 */
export async function readSourceRatings(db: Db, sourceKeys: Iterable<string | null | undefined>): Promise<Record<string, SourceRating>> {
  const keys = [...new Set([...sourceKeys].filter((k): k is string => !!k))];
  if (!keys.length) return {};
  const [sources, licences] = await Promise.all([rowsByIds<DataSourceRow>(db, "data_sources", "source_key, name, url", keys, "source_key", "source_key"), rowsByIds<LicenceRow>(db, "licence_clear_sources", "source_key, licence, attribution", keys, "source_key", "source_key")]);
  const urls = [...new Set(sources.map((s) => s.url).filter((u): u is string => !!u))];
  const registry = new Map((await Promise.all(urls.map(async (url) => [url, (await readSourceByUrl(db, url))?.id] as const))).filter((e): e is readonly [string, string] => !!e[1]));
  const tiers = new Map((await rowsByIds<RegistryTierRow>(db, "sources", "id, name, base_tier, effective_tier, tier_override", registry.values())).map((r) => [r.id, r]));
  const licenceOf = new Map(licences.map((l) => [l.source_key, l]));
  return Object.fromEntries(
    sources.map((s): [string, SourceRating] => {
      const row = s.url && registry.has(s.url) ? tiers.get(registry.get(s.url) as string) : undefined;
      const registered = customerTierOf(row);
      const tier = registered ?? classTierForHost(hostOf(s.url), s.name);
      const lic = licenceOf.get(s.source_key);
      return [s.source_key, { sourceKey: s.source_key, name: s.name, url: s.url, licence: lic?.licence ?? null, attribution: lic?.attribution ?? null, tier, via: registered !== null ? "registry" : tier !== null ? "class" : null }];
    }),
  );
}

/** The series ids whose change has a derivation recorded: the lineage of every 1-week change shown (INV-045). Needs the service client (the edges are not readable by a member); a read error throws. */
export async function readDeltaEdges(db: Db, seriesIds: readonly string[]): Promise<Set<string>> {
  const edges = await fetchAllByIdChunks<{ from_pk: string }>(
    seriesIds,
    async (slice) => {
      const { data, error } = await db.from("derivation_edges").select("from_pk").eq("from_table", "market_series").in("from_pk", slice);
      if (error) throw new Error(`derivation_edges read failed: ${error.message}`);
      return (data ?? []) as Array<{ from_pk: string }>;
    },
    { manyPerId: true },
  );
  return new Set(edges.map((e) => e.from_pk));
}

export interface MarketSeries {
  board: SeriesBoard;
  leadTime: LeadTimeRow[];
  ratings: Record<string, SourceRating>;
  /** Series rows whose latest 1-week change has a recorded derivation; null when the lineage could not be checked (no service client). */
  lineage: Set<string> | null;
}
export async function readMarketSeries(db: Db, o: { edgeDb?: Db | null } = {}): Promise<MarketSeries> {
  const rows = await readSeriesRows(db);
  const board = buildSeriesBoard(rows);
  const shown = board.groups.flatMap((g) => g.series).concat(board.unregistered);
  const [ratings, lineage] = await Promise.all([readSourceRatings(db, rows.map((r) => r.source_key)), o.edgeDb ? readDeltaEdges(o.edgeDb, shown.map((s) => s.id).filter((i): i is string => !!i)) : Promise.resolve(null)]);
  return { board, leadTime: rows.filter((r) => prefixOf(r.series_key) === "sbti"), ratings, lineage };
}
/** The rating of one board row's source (null when it names none or the source is not in the licence register). */
export const ratingOf = (ratings: Record<string, SourceRating>, row: Pick<SeriesDisplayRow, "sourceKey">): SourceRating | null => (row.sourceKey ? (ratings[row.sourceKey] ?? null) : null);

const FACTOR_COLS = "factor_id, mode, vehicle_class, jurisdiction, quantity_basis, ttw_co2e, wtt_co2e, wtw_co2e, source_key, tier, derivation, origin_class, method_version, n_observations, as_at_date, pedigree";
/** The modal-default factors in force (superseded ones excluded). */
export async function readModalFactors(db: Db): Promise<FactorRow[]> {
  const r = await boundedRead<FactorRow>((n) => db.from("emission_factors").select(FACTOR_COLS).eq("tier", "modal_default").is("superseded_by", null).order("factor_id", { ascending: true }).limit(n) as never, { limit: 200 });
  if (r.error) throw new Error(`emission_factors read failed: ${r.error.message}`);
  return r.data;
}

export interface OemRow {
  roadmap_id: string;
  tech_category: string;
  commercial_stage: string;
  target_year: number | null;
  density_basis: string | null;
  confidence_admiralty: string | null;
  announced_at: string;
}
export interface RerouteRow {
  reroute_id: string;
  baseline_corridor_id: string;
  reroute_corridor_id: string;
  cause: string;
  fuel_burn_multiplier: number;
  effective_from: string;
  effective_to: string | null;
}
export interface IndexationRow {
  clause_id: string;
  contract_ref: string | null;
  corridor_id: string | null;
  index_id: string;
  base_value: number;
  base_date: string;
  passthrough_pct: number;
  cap_pct: number | null;
  floor_pct: number | null;
  review_cadence: string;
  rounding_rule: string;
}
const PANEL_ROWS = 25;
async function panel<T>(read: Promise<{ data: T[] | null; error: { message: string } | null }>, what: string): Promise<T[]> {
  const { data, error } = await read;
  if (error) throw new Error(`${what} read failed: ${error.message}`);
  return data ?? [];
}

export interface MarketPanels {
  oem: Section<OemRow[]>;
  reroute: Section<RerouteRow[]>;
  indexation: Section<IndexationRow[]>;
}
/** The three spec 09 panels. Indexation is the viewer's organisation only (and none for a viewer with no organisation). */
export async function readPanels(db: Db, orgId: string | null): Promise<MarketPanels> {
  const [oem, reroute, indexation] = await Promise.all([
    section("oem roadmaps", () => panel<OemRow>(db.from("oem_tech_roadmaps").select("roadmap_id, tech_category, commercial_stage, target_year, density_basis, confidence_admiralty, announced_at").order("announced_at", { ascending: false }).limit(PANEL_ROWS) as never, "oem_tech_roadmaps")),
    section("reroute events", () => panel<RerouteRow>(db.from("reroute_events").select("reroute_id, baseline_corridor_id, reroute_corridor_id, cause, fuel_burn_multiplier, effective_from, effective_to").order("effective_from", { ascending: false }).limit(PANEL_ROWS) as never, "reroute_events")),
    section("indexation clauses", async () => (orgId ? panel<IndexationRow>(db.from("indexation_clauses").select("clause_id, contract_ref, corridor_id, index_id, base_value, base_date, passthrough_pct, cap_pct, floor_pct, review_cadence, rounding_rule").eq("org_id", orgId).order("created_at", { ascending: false }).limit(PANEL_ROWS) as never, "indexation_clauses") : [])),
  ]);
  return { oem, reroute, indexation };
}

export interface MarketRead {
  signals: Section<{ rows: Resource[]; aggregates: WorkspaceAggregates | null }>;
  series: Section<MarketSeries>;
  corridors: Section<CarbonOverlayEntry[]>;
  panels: MarketPanels;
}
/** The whole /market page, every part concurrent and independent. `edgeDb` (the service client, when configured) lets the series part check lineage. */
export async function readMarket(db: Db, o: { orgId?: string | null; edgeDb?: Db | null } = {}): Promise<MarketRead> {
  const [signals, series, corridors, panels] = await Promise.all([
    section("signals", async () => {
      const [list, aggregates] = await Promise.all([readCategory(db, "get_market_intel_items_public"), readSurfaceCounts(db, o.orgId ?? null, "market")]);
      if (list.failed) throw new Error("the public market list RPC failed");
      return { rows: list.resources, aggregates };
    }),
    section("series", () => readMarketSeries(db, { edgeDb: o.edgeDb ?? null })),
    section("corridors", async () => buildCarbonCostOverlays(await corridorScopes(db), await readModalFactors(db))),
    readPanels(db, o.orgId ?? null),
  ]);
  return { signals, series, corridors, panels };
}

export interface PriceStat {
  label: string;
  valueDisplay: string;
  unit: string | null;
  contextLine: string | null;
  severityTone: string | null;
  sourceTier: number | null;
  releasedAt: string | null;
  nextReleaseAt: string | null;
  nextReleaseLabel: string | null;
}
interface PriceRow {
  label: string;
  value_display: string;
  unit: string | null;
  context_line: string | null;
  severity_tone: string | null;
  source_tier: number | null;
  released_at: string | null;
  next_release_at: string | null;
  next_release_label: string | null;
}
export interface SeriesFigure {
  row: SeriesDisplayRow;
  rating: SourceRating | null;
  cadenceDays: number | null;
  sourceName: string | null;
}
export interface MarketDetailBundle {
  convergence: Section<{ independent_citers: number; confirmation_count: number } | null>;
  priceBoard: Section<PriceStat[]>;
  seriesFigure: Section<SeriesFigure | null>;
  carbon: Section<{ factors: FactorRow[]; ratings: Record<string, SourceRating>; corridorCandidates: CorridorCandidate[] }>;
  related: Section<Resource[]>;
}

/** The series ratified onto an item (the table the ratification writes), or null. */
async function ratifiedSeriesKey(db: Db, itemUuid: string): Promise<string | null> {
  const { data, error } = await db.from("market_series_items").select("series_key").eq("item_id", itemUuid).eq("status", "ratified").order("series_key", { ascending: true }).limit(1);
  if (error) throw new Error(`market_series_items read failed: ${error.message}`);
  return (data as Array<{ series_key: string }> | null)?.[0]?.series_key ?? null;
}

/** Everything the market detail page reads beyond the item itself, each part its own Section. */
export async function readMarketDetail(db: Db, item: { id: string; sourceId?: string | null }): Promise<MarketDetailBundle> {
  const uuid = await section("item identity", () => resolveItemUuid(db, item.id));
  const itemUuid = uuid.ok ? uuid.data : null;
  const fail = <T,>(): Section<T> => ({ ok: false, error: "the item could not be identified" });
  const [convergence, priceBoard, seriesFigure, carbon, related] = await Promise.all([
    section("convergence", async () => {
      if (!item.sourceId) return null;
      const { data, error } = await db.from("sources").select("independent_citers, confirmation_count").eq("id", item.sourceId).maybeSingle();
      if (error) throw new Error(`sources read failed: ${error.message}`);
      const row = data as { independent_citers: number | null; confirmation_count: number | null } | null;
      return row && typeof row.independent_citers === "number" && row.independent_citers > 0 ? { independent_citers: row.independent_citers, confirmation_count: row.confirmation_count ?? row.independent_citers } : null;
    }),
    itemUuid
      ? section("price board", async () => {
          const rows = await panel<PriceRow>(db.from("published_price_statistics").select("label, value_display, unit, context_line, severity_tone, source_tier, released_at, next_release_at, next_release_label, sort_order").eq("item_id", itemUuid).order("sort_order", { ascending: true }).limit(50) as never, "published_price_statistics");
          return rows.map((p): PriceStat => ({ label: p.label, valueDisplay: p.value_display, unit: p.unit, contextLine: p.context_line, severityTone: p.severity_tone, sourceTier: p.source_tier, releasedAt: p.released_at, nextReleaseAt: p.next_release_at, nextReleaseLabel: p.next_release_label }));
        })
      : Promise.resolve(fail<PriceStat[]>()),
    itemUuid
      ? section("series figure", async () => {
          const key = await ratifiedSeriesKey(db, itemUuid);
          if (!key) return null;
          const rows = await panel<SeriesRow>(db.from("market_series").select(SERIES_COLS).eq("series_key", key).order("reference_period", { ascending: false }).limit(120) as never, "market_series");
          const board = buildSeriesBoard(rows);
          const row = board.groups.flatMap((g) => g.series).concat(board.unregistered).find((s) => s.seriesKey === key);
          if (!row) return null;
          const producer = producerFor(prefixOf(key)) ?? null;
          const rating = row.sourceKey ? ((await readSourceRatings(db, [row.sourceKey]))[row.sourceKey] ?? null) : null;
          return { row, rating, cadenceDays: producer?.cadenceDays ?? null, sourceName: rating?.name ?? producer?.sourceName ?? null };
        })
      : Promise.resolve(fail<SeriesFigure | null>()),
    section("carbon factors", async () => {
      const factors = await readModalFactors(db);
      const [ratings, corridors] = await Promise.all([readSourceRatings(db, factors.map((f) => f.source_key)), panel<{ entity_id: string; canonical_name: string }>(db.from("entities").select("entity_id, canonical_name").eq("kind", "corridor").eq("status", "active").limit(500) as never, "entities")]);
      return { factors, ratings, corridorCandidates: candidatesFromCorridorEntities(corridors).candidates };
    }),
    section("related signals", async () => {
      const list = await readCategory(db, "get_market_intel_items_public");
      if (list.failed) throw new Error("the public market list RPC failed");
      return list.resources;
    }),
  ]);
  return { convergence, priceBoard, seriesFigure, carbon, related };
}
