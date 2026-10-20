// Ported from old_repo/src/lib/supabase-server.ts (lines 3315-3594)
// Ported from old_repo/src/lib/supabase-server.ts (lines 2268-2270)
// Ported from old_repo/src/app/operations/page.tsx (lines 19-32)
// Ported from old_repo/src/app/operations/[slug]/page.tsx (lines 108-226)
// The Operations readers, on the query kit (tables read: regions, region_dimension_coverage, regional_data_facts, state_cost_facts, derived_values, market_series, emission_factors, data_sources, intelligence_items,
// auxiliary_energy_profiles, grid_connection_queues). The facts the producers wrote, the roster and the coverage, the derived values the flywheel recomputed from them. Each read has its own failed state (null);
// a failure is never an empty matrix, a zero or "no coverage" (INV-263). The old tree selected severity (a dead field), read the source fetch status and dropped every error: all gone.
import { admitItems } from "@/core/derived/admissible";
import { boundedRead, fetchAllByIdChunks, fetchAllRows, type Db } from "@/core/db";
import { stalenessOf } from "@/core/contracts";
import { surfaceOf } from "@/core/routing";
import { hostOf } from "@/core/shared";
import { log } from "@/core/shared/log";
import { classTierForHost, customerTierOf } from "@/core/sources";
import type { Resource } from "@/core/types";
import { readCategory, readSurfaceCounts, type WorkspaceAggregates } from "@/features/lists";

import { inputRefs, isOperationsFigure, OPERATIONS_INPUT_TABLES, toDerivedFigure, type DerivedFigure, type DerivedRow, type ResolvedInput } from "../model/derived-view";
import { DIMENSIONS } from "../model/dimensions";
import { checkMatrixEligibility, eligibilityUnavailable, type MatrixEligibility } from "../model/matrix-eligibility";
import type { CoverageRow, Freshness, OperationsFact } from "../model/region-grid";
import { regionsForItem, type ItemJurisdictions } from "../model/region-resolve";
import type { AuxiliaryEnergyRow, GridIntensity, GridQueueRow } from "../model/spec09";

import cadenceJson from "./data/cadence.json";

const warn = (what: string, e: unknown): void => log.warn(`[operations-reads] ${what} failed:`, e instanceof Error ? e.message : String(e));
const settle = async <T>(what: string, read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (e) {
    warn(what, e);
    return null;
  }
};
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const FRESH = new Set<string>(["current", "ageing", "stale", "frozen"]);
/** Method version to the cadence name its producer registered (REFRESH_PERIOD_DAYS in the contracts vocabulary). */
const CADENCE: Readonly<Record<string, string>> = cadenceJson;

export interface OperationsRegion {
  id: string;
  code: string;
  label: string;
  displayOrder: number;
  isoCodes: string[];
}
export interface StateCostFact {
  stateCode: string;
  stateLabel: string | null;
  factLabel: string;
  value: string;
  unit: string | null;
  trend: string | null;
  statuteCitation: string | null;
  sourceName: string | null;
  effectiveDate: string | null;
}
interface SourceEmbed {
  name: string | null;
  url: string | null;
  base_tier: number | null;
  effective_tier: number | null;
  tier_override: number | null;
}
const embed = (s: SourceEmbed | SourceEmbed[] | null | undefined): SourceEmbed | null => (Array.isArray(s) ? (s[0] ?? null) : (s ?? null));

export async function readRoster(db: Db): Promise<OperationsRegion[]> {
  const { data, error } = await db.from("regions").select("id, code, label, display_order, iso_codes").order("display_order", { ascending: true }).order("id", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string; code: string; label: string; display_order: number; iso_codes: string[] | null }>).map((r) => ({ id: r.id, code: r.code, label: r.label, displayOrder: r.display_order, isoCodes: Array.isArray(r.iso_codes) ? r.iso_codes : [] }));
}

/** The stored coverage per (region, dimension), with its note (the note is shown on the profile and in the matrix). A row whose region is not on the roster is dropped, never given a placeholder code. */
export async function readCoverage(db: Db, roster: readonly OperationsRegion[]): Promise<CoverageRow[]> {
  const byId = new Map(roster.map((r) => [r.id, r.code]));
  const rows = await fetchAllRows<{ id: string; region_id: string; dimension: string; state: string; fact_count: number | null; notes: string | null }>((from, to) => db.from("region_dimension_coverage").select("id, region_id, dimension, state, fact_count, notes").order("id", { ascending: true }).range(from, to) as never, { cap: 50_000 });
  return rows.filter((r) => byId.has(r.region_id)).map((r) => ({ regionCode: byId.get(r.region_id) as string, dimension: r.dimension, state: r.state, factCount: r.fact_count, notes: r.notes }));
}

/** Every regional fact the producers wrote, with the registered source's customer tier and freshness derived from the row's own date against `nowIso`. */
export async function readFacts(db: Db, roster: readonly OperationsRegion[], nowIso: string): Promise<OperationsFact[]> {
  const byId = new Map(roster.map((r) => [r.id, r.code]));
  type Row = Record<string, unknown> & { id: string; region_id: string; sources: SourceEmbed | SourceEmbed[] | null };
  const rows = await fetchAllRows<Row>((from, to) => db.from("regional_data_facts").select("id, region_id, dimension, fact_label, value, status, trend, source_note, last_updated, value_numeric, unit, currency, derivation, origin_class, source_key, source_ref, n_observations, method_version, as_at_date, reference_period, sources(name, url, base_tier, effective_tier, tier_override)").order("id", { ascending: true }).range(from, to) as never, { cap: 100_000 });
  return rows.filter((r) => byId.has(r.region_id)).map((r) => {
    const src = embed(r.sources);
    const last = (r.last_updated as string | null) ?? null;
    const text = (k: string): string | null => (typeof r[k] === "string" ? (r[k] as string) : null);
    // Freshness is judged against the cadence the fact's own producer registered (data/cadence.json, keyed by method version, as Market does) and the fact's own date; a fact whose producer registered none, or that carries
    // no date, is unknown. A constant cadence made every fact read "current" for a year (register surfaces:12).
    const cadence = CADENCE[text("method_version") ?? ""] ?? null;
    const asAt = (text("as_at_date") ?? last)?.slice(0, 10) ?? null;
    const fresh = cadence && asAt ? stalenessOf({ as_of: { event_date: asAt, source_published_at: asAt }, expected_refresh: cadence }, nowIso.slice(0, 10)) : "unknown";
    return {
      regionCode: byId.get(r.region_id) as string, dimension: r.dimension as string, factLabel: r.fact_label as string, value: String(r.value ?? ""), status: text("status"), trend: ["up", "down", "flat"].includes(String(r.trend)) ? (r.trend as "up" | "down" | "flat") : null,
      sourceName: src?.name ?? null, sourceUrl: src?.url ?? null, sourceTier: customerTierOf(src), sourceNote: text("source_note"), lastUpdated: last, freshness: (FRESH.has(fresh) ? fresh : "unknown") as Freshness,
      valueNumeric: num(r.value_numeric), unit: text("unit"), currency: text("currency"), derivation: text("derivation"), originClass: text("origin_class"), sourceKey: text("source_key"), sourceRef: text("source_ref"),
      nObservations: num(r.n_observations), methodVersion: text("method_version"), asAtDate: text("as_at_date"), referencePeriod: text("reference_period"),
    };
  });
}

export async function readStateCosts(db: Db): Promise<StateCostFact[]> {
  type Row = { id: string; state_code: string; state_label: string | null; fact_label: string; value: string; unit: string | null; trend: string | null; statute_citation: string | null; effective_date: string | null; sources: SourceEmbed | SourceEmbed[] | null };
  const rows = await fetchAllRows<Row>((from, to) => db.from("state_cost_facts").select("id, state_code, state_label, fact_label, value, unit, trend, statute_citation, effective_date, sources(name, url, base_tier, effective_tier, tier_override)").order("state_code", { ascending: true }).order("id", { ascending: true }).range(from, to) as never, { cap: 50_000 });
  return rows.map((r) => ({ stateCode: r.state_code, stateLabel: r.state_label, factLabel: r.fact_label, value: r.value, unit: r.unit, trend: ["up", "down", "flat"].includes(String(r.trend)) ? r.trend : null, statuteCitation: r.statute_citation, sourceName: embed(r.sources)?.name ?? null, effectiveDate: r.effective_date }));
}

/** Regulations per region: the verified, non-archived items the routing table sends to Regulations, counted into every region their jurisdictions fall in. Reported beside coverage, never folded into it. */
export async function readLinkedRegulations(db: Db, roster: readonly OperationsRegion[]): Promise<Record<string, number>> {
  type Row = { id: string; item_type: string | null; domain: number | null; jurisdictions: string[] | null; jurisdiction_iso: string[] | null };
  const rows = await fetchAllRows<Row>((from, to) => admitItems(db.from("intelligence_items").select("id, item_type, domain, jurisdictions, jurisdiction_iso")).order("id", { ascending: true }).range(from, to) as never, { cap: 100_000 });
  const counts: Record<string, number> = Object.fromEntries(roster.map((r) => [r.code, 0]));
  for (const row of rows) {
    if (surfaceOf(row.item_type, row.domain) !== "regulations") continue;
    for (const code of regionsForItem(roster, { jurisdictions: row.jurisdictions, jurisdictionIso: row.jurisdiction_iso })) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

/** The recomputed figures that rest on Operations inputs: current rows only (a row an input change made stale is not shown), with each input named, dated and rated by its publisher's class. */
export async function readDerivedFigures(db: Db, limit = 8): Promise<DerivedFigure[]> {
  const read = await boundedRead<DerivedRow>((n) => db.from("derived_values_admissible").select("value_id, method_id, value, unit, currency, origin_class, lifecycle, base_confidence, computed_at, supersedes, inputs").order("computed_at", { ascending: false }).order("value_id", { ascending: true }).limit(n) as never, { limit: 200 });
  if (read.error) throw new Error(read.error.message);
  const rows = read.data.filter(isOperationsFigure).slice(0, limit);
  if (rows.length === 0) return [];
  const pks = (table: string): string[] => [...new Set(rows.flatMap((r) => inputRefs(r.inputs)).filter((i) => i.table === table).map((i) => i.pk))];
  const chunk = async <T>(table: string, idCol: string, cols: string): Promise<Map<string, T>> => {
    const got = await fetchAllByIdChunks(pks(table), async (slice) => {
      const { data, error } = await db.from(table).select(cols).in(idCol, slice);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as Array<Record<string, unknown>>;
    });
    return new Map(got.map((g) => [String(g[idCol]), g as T]));
  };
  type M = { id: string; label: string | null; reference_period: string | null; source_key: string | null };
  type F = { factor_id: string; mode: string | null; jurisdiction: string | null; quantity_basis: string | null; as_at_date: string | null; source_key: string | null };
  type R = { id: string; fact_label: string; reference_period: string | null; source_key: string | null; sources: SourceEmbed | SourceEmbed[] | null };
  const [series, factors, facts] = await Promise.all([chunk<M>("market_series", "id", "id, label, reference_period, source_key"), chunk<F>("emission_factors", "factor_id", "factor_id, mode, jurisdiction, quantity_basis, as_at_date, source_key"), chunk<R>("regional_data_facts", "id", "id, fact_label, reference_period, source_key, sources(name, url, base_tier, effective_tier, tier_override)")]);
  const keys = [...new Set([...series.values(), ...factors.values(), ...facts.values()].map((x) => x.source_key).filter((k): k is string => !!k))];
  const pub = new Map<string, { name: string; tier: number | null }>();
  for (const d of await fetchAllByIdChunks(keys, async (slice) => {
    const { data, error } = await db.from("data_sources").select("source_key, name, url").in("source_key", slice);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ source_key: string; name: string; url: string | null }>;
  })) pub.set(d.source_key, { name: d.name, tier: d.url ? classTierForHost(hostOf(d.url), d.name) : null });
  const resolve = (ref: { table: string; pk: string }): ResolvedInput => {
    const m = series.get(ref.pk), f = factors.get(ref.pk), r = facts.get(ref.pk);
    const p = (k: string | null | undefined) => (k ? pub.get(k) : undefined);
    if (ref.table === "market_series" && m) return { label: m.label ?? "a market series", period: m.reference_period, sourceName: p(m.source_key)?.name ?? null, tier: p(m.source_key)?.tier ?? null };
    if (ref.table === "emission_factors" && f) return { label: [f.mode, f.jurisdiction, f.quantity_basis].filter(Boolean).join(" · ") || "an emission factor", period: f.as_at_date, sourceName: p(f.source_key)?.name ?? null, tier: p(f.source_key)?.tier ?? null };
    if (ref.table === "regional_data_facts" && r) return { label: r.fact_label, period: r.reference_period, sourceName: embed(r.sources)?.name ?? p(r.source_key)?.name ?? null, tier: customerTierOf(embed(r.sources)) ?? p(r.source_key)?.tier ?? null };
    return { label: "an input that is no longer held", period: null, sourceName: null, tier: null };
  };
  const supersededIds = rows.map((r) => r.supersedes).filter((x): x is string => !!x);
  const before = new Map((await fetchAllByIdChunks(supersededIds, async (slice) => {
    const { data, error } = await db.from("derived_values").select("value_id, value").in("value_id", slice);
    if (error) throw new Error(error.message);
    return (data ?? []) as Array<{ value_id: string; value: number | string | null }>;
  })).map((v) => [v.value_id, num(v.value)] as const));
  return rows.map((r) => toDerivedFigure(r, inputRefs(r.inputs).filter((i) => OPERATIONS_INPUT_TABLES.includes(i.table)).map(resolve), r.supersedes ? (before.get(r.supersedes) ?? null) : null));
}

export interface OperationsPageData {
  rows: Resource[];
  rowsFailed: boolean;
  aggregates: WorkspaceAggregates | null;
  roster: OperationsRegion[] | null;
  coverage: CoverageRow[] | null;
  facts: OperationsFact[] | null;
  stateCosts: StateCostFact[] | null;
  linkedRegulations: Record<string, number> | null;
  derived: DerivedFigure[] | null;
}

/** Everything /operations draws, one pass: the public items, the corpus tallies, the roster with its coverage and facts, the state cost facts, the linked-regulation counts and the recomputed figures. */
export async function readOperationsPage(db: Db, nowIso: string, orgId: string | null): Promise<OperationsPageData> {
  const roster = await settle("the region roster", () => readRoster(db));
  const [category, aggregates, coverage, facts, stateCosts, linkedRegulations, derived] = await Promise.all([
    readCategory(db, orgId ? "get_operations_items" : "get_operations_items_public", orgId), readSurfaceCounts(db, orgId, "operations"),
    roster ? settle("coverage", () => readCoverage(db, roster)) : null, roster ? settle("facts", () => readFacts(db, roster, nowIso)) : null,
    settle("state cost facts", () => readStateCosts(db)), roster ? settle("linked regulations", () => readLinkedRegulations(db, roster)) : null, settle("recomputed figures", () => readDerivedFigures(db)),
  ]);
  return { rows: category.resources, rowsFailed: category.failed, aggregates, roster, coverage, facts, stateCosts, linkedRegulations, derived };
}

/** The S3/S4 gate for one profile: the roster and the sourced coverage over the item's whole jurisdiction list; either read failing closes the gate and says why (INV-233). */
export async function readMatrixEligibility(db: Db, item: ItemJurisdictions, known?: readonly OperationsRegion[]): Promise<MatrixEligibility> {
  try {
    const roster = known ?? (await readRoster(db));
    const { data, error } = await db.from("region_dimension_coverage").select("region_id, dimension, state").in("state", ["populated", "partial"]).in("dimension", DIMENSIONS.map((d) => d.db));
    if (error) throw new Error(error.message);
    const byId = new Map(roster.map((r) => [r.id, r.code]));
    const coverage = ((data ?? []) as Array<{ region_id: string; dimension: string; state: string }>).filter((c) => byId.has(c.region_id)).map((c) => ({ regionCode: byId.get(c.region_id) as string, dimension: c.dimension, state: c.state }));
    return checkMatrixEligibility({ roster: roster.map((r) => ({ code: r.code, isoCodes: r.isoCodes })), coverage, item });
  } catch (e) {
    warn("matrix eligibility", e);
    return eligibilityUnavailable("the coverage read failed");
  }
}

/** The item's own jurisdiction inputs for the gate and the related read: the whole `jurisdictions` list and the ISO set (the shared detail mapper keeps one value), and its source. */
export async function readItemRegionInputs(db: Db, itemUuid: string): Promise<ItemJurisdictions & { sourceId: string | null }> {
  const { data, error } = await admitItems(db.from("intelligence_items").select("jurisdictions, jurisdiction_iso, source_id").eq("id", itemUuid)).maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as { jurisdictions: string[] | null; jurisdiction_iso: string[] | null; source_id: string | null } | null;
  return { jurisdictions: row?.jurisdictions ?? [], jurisdictionIso: row?.jurisdiction_iso ?? [], sourceId: row?.source_id ?? null };
}

export interface Spec09Data {
  /** The workspace's own loads (org-scoped); null when the read failed. */
  aux: AuxiliaryEnergyRow[] | null;
  grid: GridQueueRow[] | null;
  /** The latest sourced grid intensity of the profile's region; null when there is none, and `intensityFailed` says the read failed rather than found nothing. */
  intensity: GridIntensity | null;
  intensityFailed: boolean;
}
const SPEC09_LIMIT = 25;
const GCO2_PER_KWH = /^\s*gCO2e?\s*\/\s*kWh\s*$/i;

/** The profile's panels: the workspace's auxiliary loads, the grid connection queue gate rows and the sourced grid intensity of the region the profile is about (the conversion the old card only named). */
export async function readSpec09(db: Db, orgId: string | null, regionCodes: readonly string[], known?: readonly OperationsRegion[]): Promise<Spec09Data> {
  const aux = orgId ? await settle("auxiliary loads", async () => {
    const { data, error } = await db.from("auxiliary_energy_profiles").select("profile_id, load_type, kw_draw, duty_cycle, hours_typical, setpoint_c, setpoint_rh_pct, grid_intensity_source").eq("org_id", orgId).order("created_at", { ascending: false }).order("profile_id", { ascending: true }).limit(SPEC09_LIMIT);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as AuxiliaryEnergyRow[];
  }) : [];
  const grid = await settle("grid queue", async () => {
    const { data, error } = await db.from("grid_connection_queues").select("queue_id, dso_name, capacity_band_mw, queue_months_p50, queue_months_p90, as_of, substation_name, demand_firm_mw, demand_available_mw, demand_constraint, demand_constraint_limiting_factor").order("demand_available_mw", { ascending: true, nullsFirst: true }).order("as_of", { ascending: false }).order("queue_id", { ascending: true }).limit(SPEC09_LIMIT);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as GridQueueRow[];
  });
  let intensity: GridIntensity | null = null;
  let intensityFailed = false;
  try {
    const roster = known ?? (await readRoster(db));
    const ids = roster.filter((r) => regionCodes.includes(r.code)).map((r) => r.id);
    if (ids.length > 0) {
      const { data, error } = await db.from("regional_data_facts").select("id, value_numeric, unit, as_at_date, reference_period, sources(name, url, base_tier, effective_tier, tier_override)").eq("dimension", "grid_intensity").in("region_id", ids).not("value_numeric", "is", null).order("as_at_date", { ascending: false }).order("id", { ascending: true }).limit(20);
      if (error) throw new Error(error.message);
      const hit = ((data ?? []) as unknown as Array<{ value_numeric: number | string; unit: string | null; as_at_date: string | null; reference_period: string | null; sources: SourceEmbed | SourceEmbed[] | null }>).find((f) => GCO2_PER_KWH.test(f.unit ?? "") && num(f.value_numeric) !== null);
      if (hit) intensity = { gco2ePerKwh: num(hit.value_numeric) as number, sourceName: embed(hit.sources)?.name ?? null, period: hit.reference_period ?? hit.as_at_date };
    }
  } catch (e) {
    warn("grid intensity", e);
    intensityFailed = true;
  }
  return { aux, grid, intensity, intensityFailed };
}
