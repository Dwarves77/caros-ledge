// Ported from old_repo/src/lib/supabase-server.ts (lines 3315-3594)
// Ported from old_repo/src/lib/supabase-server.ts (lines 2268-2270)
// Ported from old_repo/src/app/operations/page.tsx (lines 19-32)
// Ported from old_repo/src/app/operations/[slug]/page.tsx (lines 108-226)
// The Operations readers, on the query kit (tables read: regions, region_dimension_coverage, regional_data_facts, state_cost_facts, derived_values, market_series, emission_factors, data_sources, intelligence_items,
// auxiliary_energy_profiles, grid_connection_queues). The facts the producers wrote, the roster and the coverage, the derived values the flywheel recomputed from them. Each read has its own failed state (null);
// a failure is never an empty matrix, a zero or "no coverage" (INV-263). The old tree selected severity (a dead field), read the source fetch status and dropped every error: all gone.
import { admitItems } from "@/core/derived/admissible";
import { boundedRead, fetchAllByIdChunks, fetchAllRows, type Db } from "@/core/db";
import { readWhyMatters } from "@/features/flywheel/radar/read";
import { stalenessOf } from "@/core/contracts";
import { canonicalJurisdictionCode, entityId } from "@/core/entities";
import { surfaceOf } from "@/core/routing";
import { hostOf } from "@/core/shared";
import { log } from "@/core/shared/log";
import { classTierForHost, customerTierOf } from "@/core/sources";
import type { Resource } from "@/core/types";
import { readCategory, readSurfaceCounts, type WorkspaceAggregates } from "@/features/lists";

import { regionalFactLine, stateCostLine } from "../ask-context";
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
async function readCoverage(db: Db, rosterP: readonly OperationsRegion[] | Promise<readonly OperationsRegion[] | null>): Promise<CoverageRow[]> {
  const [rows, roster] = await Promise.all([fetchAllRows<{ id: string; region_id: string; dimension: string; state: string; fact_count: number | null; notes: string | null }>((from, to) => db.from("region_dimension_coverage").select("id, region_id, dimension, state, fact_count, notes").order("id", { ascending: true }).range(from, to) as never, { cap: 50_000 }), rosterP]);
  const byId = new Map((roster ?? []).map((r) => [r.id, r.code]));
  return roster ? rows.filter((r) => byId.has(r.region_id)).map((r) => ({ regionCode: byId.get(r.region_id) as string, dimension: r.dimension, state: r.state, factCount: r.fact_count, notes: r.notes })) : (null as never);
}

/** Each fact with its two "Why this matters" lines: the regulation tied to its entity with the next dated obligation and penalty, and the item tied to it (the facts join). */
async function withWhy(db: Db, facts: OperationsFact[], nowIso: string): Promise<OperationsFact[]> {
  const why = await readWhyMatters(db, "regional_data_facts", facts.flatMap((f) => (f.id ? [{ id: f.id, subject: f.factLabel }] : [])), nowIso);
  return facts.map((f) => ({ ...f, why: why.get(f.id ?? "") ?? [] }));
}

/** Every regional fact the producers wrote, with the registered source's customer tier and freshness derived from the row's own date against `nowIso` (no instant, no judgement: freshness is unknown). */
async function readFacts(db: Db, rosterP: readonly OperationsRegion[] | Promise<readonly OperationsRegion[] | null>, nowIso?: string): Promise<OperationsFact[]> {
  type Row = Record<string, unknown> & { id: string; region_id: string; sources: SourceEmbed | SourceEmbed[] | null };
  const [rows, roster] = await Promise.all([fetchAllRows<Row>((from, to) => db.from("regional_data_facts").select("id, region_id, dimension, fact_label, value, status, trend, source_note, last_updated, value_numeric, unit, currency, derivation, origin_class, source_key, source_ref, n_observations, method_version, as_at_date, reference_period, sources(name, url, base_tier, effective_tier, tier_override)").order("id", { ascending: true }).range(from, to) as never, { cap: 100_000 }), rosterP]);
  const byId = new Map((roster ?? []).map((r) => [r.id, r.code]));
  return roster ? rows.filter((r) => byId.has(r.region_id)).map((r) => {
    const src = embed(r.sources);
    const last = (r.last_updated as string | null) ?? null;
    const text = (k: string): string | null => (typeof r[k] === "string" ? (r[k] as string) : null);
    // Freshness is judged against the cadence the fact's own producer registered (data/cadence.json, keyed by method version, as Market does) and the fact's own date; a fact whose producer registered none, or that carries
    // no date, is unknown. A constant cadence made every fact read "current" for a year (register surfaces:12).
    const cadence = CADENCE[text("method_version") ?? ""] ?? null;
    const asAt = (text("as_at_date") ?? last)?.slice(0, 10) ?? null;
    const fresh = cadence && asAt && nowIso ? stalenessOf({ as_of: { event_date: asAt, source_published_at: asAt }, expected_refresh: cadence }, nowIso.slice(0, 10)) : "unknown";
    return {
      id: r.id, regionCode: byId.get(r.region_id) as string, dimension: r.dimension as string, factLabel: r.fact_label as string, value: String(r.value ?? ""), status: text("status"), trend: ["up", "down", "flat"].includes(String(r.trend)) ? (r.trend as "up" | "down" | "flat") : null,
      sourceName: src?.name ?? null, sourceUrl: src?.url ?? null, sourceTier: customerTierOf(src), sourceNote: text("source_note"), lastUpdated: last, freshness: (FRESH.has(fresh) ? fresh : "unknown") as Freshness,
      valueNumeric: num(r.value_numeric), unit: text("unit"), currency: text("currency"), derivation: text("derivation"), originClass: text("origin_class"), sourceKey: text("source_key"), sourceRef: text("source_ref"),
      nObservations: num(r.n_observations), methodVersion: text("method_version"), asAtDate: text("as_at_date"), referencePeriod: text("reference_period"),
    };
  }) : (null as never);
}

async function readStateCosts(db: Db): Promise<StateCostFact[]> {
  type Row = { id: string; state_code: string; state_label: string | null; fact_label: string; value: string; unit: string | null; trend: string | null; statute_citation: string | null; effective_date: string | null; sources: SourceEmbed | SourceEmbed[] | null };
  const rows = await fetchAllRows<Row>((from, to) => db.from("state_cost_facts").select("id, state_code, state_label, fact_label, value, unit, trend, statute_citation, effective_date, sources(name, url, base_tier, effective_tier, tier_override)").order("state_code", { ascending: true }).order("id", { ascending: true }).range(from, to) as never, { cap: 50_000 });
  return rows.map((r) => ({ stateCode: r.state_code, stateLabel: r.state_label, factLabel: r.fact_label, value: r.value, unit: r.unit, trend: ["up", "down", "flat"].includes(String(r.trend)) ? r.trend : null, statuteCitation: r.statute_citation, sourceName: embed(r.sources)?.name ?? null, effectiveDate: r.effective_date }));
}

/** Regulations per region: the verified, non-archived items the routing table sends to Regulations, counted into every region their jurisdictions fall in. Reported beside coverage, never folded into it. */
async function readLinkedRegulations(db: Db, rosterP: readonly OperationsRegion[] | Promise<readonly OperationsRegion[] | null>): Promise<Record<string, number>> {
  type Row = { id: string; item_type: string | null; domain: number | null; jurisdictions: string[] | null; jurisdiction_iso: string[] | null };
  const [rows, roster] = await Promise.all([fetchAllRows<Row>((from, to) => admitItems(db.from("intelligence_items").select("id, item_type, domain, jurisdictions, jurisdiction_iso")).order("id", { ascending: true }).range(from, to) as never, { cap: 100_000 }), rosterP]);
  if (!roster) return null as never;
  const counts: Record<string, number> = Object.fromEntries(roster.map((r) => [r.code, 0]));
  for (const row of rows) {
    if (surfaceOf(row.item_type, row.domain) !== "regulations") continue;
    for (const code of regionsForItem(roster, { jurisdictions: row.jurisdictions, jurisdictionIso: row.jurisdiction_iso })) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

/** The places a profile is about: the jurisdiction entities of its ISO codes, jurisdictions and regions, and the roster regions it falls in. */
export interface ProfileScope {
  entityIds: ReadonlySet<string>;
  regionIds: ReadonlySet<string>;
}
export function profileScope(item: ItemJurisdictions, roster: readonly OperationsRegion[]): ProfileScope {
  const regions = roster.filter((r) => regionsForItem(roster, item).includes(r.code));
  const codes = [...(item.jurisdictionIso ?? []), ...(item.jurisdictions ?? []), item.jurisdiction ?? "", ...regions.map((r) => r.code)].map(canonicalJurisdictionCode).filter((c): c is string => !!c);
  return { entityIds: new Set(codes.map((c) => entityId("jurisdiction", c))), regionIds: new Set(regions.map((r) => r.id)) };
}

/**
 * The recomputed figures that rest on Operations inputs: current rows only (a row an input change made stale is not shown), with each input named, dated and rated by its publisher's class. A profile (`scope`) sees the figures whose
 * jurisdictioned inputs are all its own (a series' entity, a factor's jurisdiction, a fact's region); a figure none of whose inputs names a jurisdiction is global and shows everywhere; the list (`scope` null) spans all regions. A recalculation
 * that came out equal to the value it replaced is not a notice.
 */
export async function readDerivedFigures(db: Db, scope: ProfileScope | null, limit = 8, nowIso?: string): Promise<DerivedFigure[]> {
  const read = await boundedRead<DerivedRow>((n) => db.from("derived_values_admissible").select("value_id, method_id, value, unit, currency, origin_class, lifecycle, base_confidence, computed_at, supersedes, inputs").order("computed_at", { ascending: false }).order("value_id", { ascending: true }).limit(n) as never, { limit: 200 });
  if (read.error) throw new Error(read.error.message);
  const rows = read.data.filter(isOperationsFigure);
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
  type M = { id: string; label: string | null; reference_period: string | null; source_key: string | null; entity_id: string | null };
  type F = { factor_id: string; mode: string | null; jurisdiction: string | null; quantity_basis: string | null; as_at_date: string | null; source_key: string | null };
  type R = { id: string; region_id: string; fact_label: string; reference_period: string | null; source_key: string | null; sources: SourceEmbed | SourceEmbed[] | null };
  const supersededIds = rows.map((r) => r.supersedes).filter((x): x is string => !!x);
  const [series, factors, facts, supersededRows] = await Promise.all([
    chunk<M>("market_series", "id", "id, label, reference_period, source_key, entity_id"), chunk<F>("emission_factors", "factor_id", "factor_id, mode, jurisdiction, quantity_basis, as_at_date, source_key"),
    chunk<R>("regional_data_facts", "id", "id, region_id, fact_label, reference_period, source_key, sources(name, url, base_tier, effective_tier, tier_override)"),
    fetchAllByIdChunks(supersededIds, async (slice) => {
      const { data, error } = await db.from("derived_values").select("value_id, value").in("value_id", slice);
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ value_id: string; value: number | string | null }>;
    }),
  ]);
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
  // Whether an input is the profile's own (true), another place's (false), or names no place (null: global).
  const own = (ref: { table: string; pk: string }): boolean | null => {
    const m = series.get(ref.pk), f = factors.get(ref.pk), r = facts.get(ref.pk);
    if (ref.table === "market_series" && m) return m.entity_id ? scope?.entityIds.has(m.entity_id) ?? true : null;
    if (ref.table === "emission_factors" && f) { const code = canonicalJurisdictionCode(f.jurisdiction); return code ? scope?.entityIds.has(entityId("jurisdiction", code)) ?? true : null; }
    if (ref.table === "regional_data_facts" && r) return scope?.regionIds.has(r.region_id) ?? true;
    return null;
  };
  const before = new Map(supersededRows.map((v) => [v.value_id, num(v.value)] as const));
  const kept = rows.flatMap((r) => {
    const refs = inputRefs(r.inputs).filter((i) => OPERATIONS_INPUT_TABLES.includes(i.table));
    const figure = toDerivedFigure(r, refs.map(resolve), r.supersedes ? (before.get(r.supersedes) ?? null) : null);
    return refs.every((i) => own(i) !== false) && !(figure.previous !== null && figure.previous === figure.value) ? [{ figure, first: refs[0] }] : [];
  }).slice(0, limit);
  // "Why this matters" for each figure: the items tied to its first input row (one join per input table)
  const why = new Map<string, string[]>();
  for (const table of OPERATIONS_INPUT_TABLES) {
    const asked = kept.flatMap((k) => (k.first?.table === table ? [{ id: k.first.pk, subject: k.figure.inputs[0]?.label ?? k.figure.title }] : []));
    if (nowIso) for (const [pk, lines] of await readWhyMatters(db, table, asked, nowIso)) why.set(`${table}/${pk}`, lines);
  }
  return kept.map(({ figure, first }) => ({ ...figure, why: why.get(`${first?.table}/${first?.pk}`) ?? [] }));
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
  const rosterP = settle("the region roster", () => readRoster(db));
  const [roster, category, aggregates, coverage, facts, stateCosts, linkedRegulations, derived] = await Promise.all([
    rosterP, readCategory(db, orgId ? "get_operations_items" : "get_operations_items_public", orgId), readSurfaceCounts(db, orgId, "operations"),
    settle("coverage", () => readCoverage(db, rosterP)), settle("facts", () => readFacts(db, rosterP, nowIso).then((facts) => withWhy(db, facts, nowIso))),
    settle("state cost facts", () => readStateCosts(db)), settle("linked regulations", () => readLinkedRegulations(db, rosterP)), settle("recomputed figures", () => readDerivedFigures(db, null, 8, nowIso)),
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
  /** The profile's own queue rows that carry a queue time (p50 or p90); null when the read failed. */
  grid: GridQueueRow[] | null;
  /** How many of the profile's substations carry headroom figures but no queue time; null when the read failed. */
  gridHeadroomOnly: number | null;
  /** The latest sourced grid intensity of the profile's region; null when there is none, and `intensityFailed` says the read failed rather than found nothing. */
  intensity: GridIntensity | null;
  intensityFailed: boolean;
}
const SPEC09_LIMIT = 25;
const GCO2_PER_KWH = /^\s*gCO2e?\s*\/\s*kWh\s*$/i;

/** The profile's panels: the workspace's auxiliary loads, the grid connection queue rows of the profile's own jurisdiction and the sourced grid intensity of the region the profile is about (the conversion the old card only named). */
export async function readSpec09(db: Db, orgId: string | null, scope: ProfileScope): Promise<Spec09Data> {
  let intensity: GridIntensity | null = null;
  let intensityFailed = false;
  const [aux, queue] = await Promise.all([
    orgId ? settle("auxiliary loads", async () => {
      const { data, error } = await db.from("auxiliary_energy_profiles").select("profile_id, load_type, kw_draw, duty_cycle, hours_typical, setpoint_c, setpoint_rh_pct, grid_intensity_source").eq("org_id", orgId).order("created_at", { ascending: false }).order("profile_id", { ascending: true }).limit(SPEC09_LIMIT);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as AuxiliaryEnergyRow[];
    }) : Promise.resolve([]),
    settle("grid queue", async () => {
      // Only the profile's own jurisdiction (the table is per jurisdiction entity); a row with a queue time is a queue entry, one with only headroom figures is counted, not drawn as a queue.
      const ids = [...scope.entityIds];
      const [timed, noTime] = await Promise.all([
        db.from("grid_connection_queues").select("queue_id, dso_name, capacity_band_mw, queue_months_p50, queue_months_p90, as_of, substation_name, demand_firm_mw, demand_available_mw, demand_constraint, demand_constraint_limiting_factor").in("jurisdiction_id", ids).or("queue_months_p50.gte.0,queue_months_p90.gte.0").order("demand_available_mw", { ascending: true, nullsFirst: true }).order("as_of", { ascending: false }).order("queue_id", { ascending: true }).limit(SPEC09_LIMIT),
        db.from("grid_connection_queues").select("queue_id", { count: "exact", head: true }).in("jurisdiction_id", ids).is("queue_months_p50", null).is("queue_months_p90", null),
      ]);
      if (timed.error) throw new Error(timed.error.message);
      if (noTime.error) throw new Error(noTime.error.message);
      return { rows: (timed.data ?? []) as unknown as GridQueueRow[], headroomOnly: noTime.count ?? 0 };
    }),
    (async () => {
      try {
        const ids = [...scope.regionIds];
        if (ids.length === 0) return;
        const { data, error } = await db.from("regional_data_facts").select("id, value_numeric, unit, as_at_date, reference_period, sources(name, url, base_tier, effective_tier, tier_override)").eq("dimension", "grid_intensity").in("region_id", ids).not("value_numeric", "is", null).order("as_at_date", { ascending: false }).order("id", { ascending: true }).limit(20);
        if (error) throw new Error(error.message);
        const hit = ((data ?? []) as unknown as Array<{ value_numeric: number | string; unit: string | null; as_at_date: string | null; reference_period: string | null; sources: SourceEmbed | SourceEmbed[] | null }>).find((f) => GCO2_PER_KWH.test(f.unit ?? "") && num(f.value_numeric) !== null);
        if (hit) intensity = { gco2ePerKwh: num(hit.value_numeric) as number, sourceName: embed(hit.sources)?.name ?? null, period: hit.reference_period ?? hit.as_at_date };
      } catch (e) { warn("grid intensity", e); intensityFailed = true; }
    })(),
  ]);
  return { aux, grid: queue?.rows ?? null, gridHeadroomOnly: queue?.headroomOnly ?? null, intensity, intensityFailed };
}

/**
 * The Operations lines the Assistant answers with: the regional facts of the regions the hits' jurisdictions fall in and the per-state cost facts, one plain line each with its source, read live, with no freshness judged since no line states one (the roster, the
 * facts and the state costs are the same reads the Operations page draws). No region named, or a roster that holds none of them, is no lines: nothing is invented. A failed read throws; the caller says so.
 */
export async function readOperationsAskLines(db: Db, input: { jurisdictions: readonly string[] }): Promise<string[]> {
  const roster = await readRoster(db);
  const codes = new Set(regionsForItem(roster, { jurisdictions: input.jurisdictions }));
  if (codes.size === 0) return [];
  const [facts, stateCosts] = await Promise.all([readFacts(db, roster), readStateCosts(db)]);
  return [...facts.filter((f) => codes.has(f.regionCode)).map(regionalFactLine), ...stateCosts.map(stateCostLine)];
}
