// ENGINE-JOIN-1 (addendum A): the read-time join between the intelligence items and the structured tables that already carry entity refs, through entity_refs (direct, hop 0) and one entity_relations hop (both directions, hop 1).
// readEntityFacts(items) answers "which figures (a price series with its movement, an OEM roadmap, a reroute, a statutory computation, a regional or state fact, a grid queue, a corridor emission factor) are filed under the entities this item is filed under";
// readFactItems(table, rows) answers the reverse, "which regulations are filed under the entity of this figure, each with its next dated obligation and its penalty figure". The graph is the only ontology (ADR-053): joins are entity ids and relation rows,
// never a word. A bare mode, jurisdiction or organisation joins nothing on its own. Every read is a batched IN list of at most 500 ids under a total order; none is per item. The same primitives load the entity graph into discovery's signatures.
// The tables named in the brief that the schema does not hold are not read: series_observations (a market_series row IS one observation of its series_key), corridor_carbon_intensity (emission_factors carries corridor_id and the intensity),
// regional_operational_facts (regional_data_facts).
import type { Db } from "@/core/db";
import { fetchAllByIdChunks, fetchAllRows, qb, rowsByIds } from "@/core/db";
import { admitItems } from "@/core/derived/admissible";
import { SURFACE_LABELS, SURFACE_ORDER, surfaceOf } from "@/core/routing";

import { CONFIG } from "./config";
import { PATTERNS } from "./patterns/config";

export type FactSurface = "regulations" | "market" | "operations" | "research";
export interface EntityRef {
  id: string;
  kind: string;
  canonicalName: string;
}
/** The typed fields a surface needs to state the fact; nothing here is prose. */
export interface FactSummary {
  label?: string | undefined;
  value?: number | undefined;
  unit?: string | undefined;
  asOf?: string | undefined;
  /** Relative change of a series over the last week and month (0.248 is +24.8%). */
  delta?: { week?: number | undefined; month?: number | undefined } | undefined;
  /** The date the fact falls due or lands (YYYY-MM-DD). */
  date?: string | undefined;
  dutyHolder?: string[] | undefined;
  penalty?: { value: number; unit: string } | undefined;
  stage?: string | undefined;
}
export interface FactLink {
  refTable: string;
  refId: string;
  entity: EntityRef;
  relation?: string;
  hop: 0 | 1;
  surface: FactSurface;
  summary: FactSummary;
}
type Row = Record<string, unknown>;
export interface RefRow {
  ref_table: string;
  ref_id: string;
  entity_id: string;
  role: string;
}
export interface RelationRow {
  parent_entity_id: string;
  child_entity_id: string;
  relation: string;
}

const CHUNK = 200;
const DAY = 86_400_000;
const num = (v: unknown): number | undefined => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/** An id-list read in chunks of 200 (500 uuids url-encode past the 16 KB request-line limit) under a total order; a failed page throws. */
const chunked = <T>(ids: Iterable<string>, page: (slice: string[]) => (from: number, to: number) => unknown): Promise<T[]> =>
  fetchAllByIdChunks<T>(ids, (slice) => fetchAllRows<T>(page(slice) as never, { cap: 500_000 }), { chunk: CHUNK, manyPerId: true });

/** The refs filed under rows of one table. */
export const refsOfRows = (sb: Db, refTable: string, ids: Iterable<string>): Promise<RefRow[]> =>
  chunked<RefRow>(ids, (s) => (from, to) => qb(sb.from("entity_refs").select("ref_table, ref_id, entity_id, role")).eq("ref_table", refTable).in("ref_id", s).order("ref_id").order("entity_id").order("role").range(from, to));
/** The rows of the given tables filed under entities. */
const refsOfEntities = (sb: Db, entityIds: Iterable<string>, tables: readonly string[]): Promise<RefRow[]> =>
  chunked<RefRow>(entityIds, (s) => (from, to) => qb(sb.from("entity_refs").select("ref_table, ref_id, entity_id, role")).in("entity_id", s).in("ref_table", tables).order("ref_table").order("ref_id").order("entity_id").order("role").range(from, to));
/** Every relation row touching an entity, as parent or as child. */
export async function relationsAround(sb: Db, entityIds: Iterable<string>): Promise<RelationRow[]> {
  const ids = [...new Set(entityIds)];
  const side = (column: string) => chunked<RelationRow>(ids, (s) => (from, to) => qb(sb.from("entity_relations").select("parent_entity_id, child_entity_id, relation")).in(column, s).order("parent_entity_id").order("child_entity_id").order("relation").range(from, to));
  const all = [...(await side("parent_entity_id")), ...(await side("child_entity_id"))];
  return [...new Map(all.map((r) => [`${r.parent_entity_id}|${r.relation}|${r.child_entity_id}`, r])).values()];
}
/** The kind and name of entities: the name a reader reads (display_name where the graph holds one, as a corridor's "Shanghai (CN) → Genoa (IT), ocean"), else the canonical name. */
export async function entityRefs(sb: Db, ids: Iterable<string>): Promise<Map<string, EntityRef>> {
  const rows = await chunked<{ entity_id: string; kind: string; canonical_name: string; display_name?: string | null }>(ids, (s) => (from, to) => qb(sb.from("entities").select("entity_id, kind, canonical_name, display_name")).in("entity_id", s).order("entity_id").range(from, to));
  return new Map(rows.map((r) => [r.entity_id, { id: r.entity_id, kind: r.kind, canonicalName: r.display_name?.trim() || r.canonical_name }]));
}

export const classOfRole = (role: string): string => (role.startsWith("cites_") ? role.slice(6) : role);
/** A bare mode, jurisdiction or organisation (by the ref's role class or the id's kind) joins nothing on its own. */
export const isGenericEntity = (id: string, role = ""): boolean => PATTERNS.genericClasses.includes(classOfRole(role)) || PATTERNS.genericClasses.includes(/^cl:([a-z_]+):/.exec(id)?.[1] ?? "");
/** Each entity to the entities one relation away: [far, relation token, true when the entity is the relation's parent]. */
export function neighbours(rels: readonly RelationRow[]): Map<string, { entity: string; relation: string; asParent: boolean }[]> {
  const out = new Map<string, { entity: string; relation: string; asParent: boolean }[]>();
  for (const r of rels) {
    out.set(r.parent_entity_id, [...(out.get(r.parent_entity_id) ?? []), { entity: r.child_entity_id, relation: r.relation, asParent: true }]);
    out.set(r.child_entity_id, [...(out.get(r.child_entity_id) ?? []), { entity: r.parent_entity_id, relation: r.relation, asParent: false }]);
  }
  return out;
}

interface TableSpec {
  pk: string;
  cols: string;
  surface: FactSurface;
  summary(r: Row): FactSummary;
}
/** The structured tables that carry refs, with the columns each one's fact is stated from (read from the migrations and tests/_support/schema.json). */
const FACT_TABLES: Readonly<Record<string, TableSpec>> = {
  market_series: { pk: "id", cols: "id, series_key, label, value_numeric, unit, as_at_date", surface: "market", summary: (r) => ({ label: str(r.label), value: num(r.value_numeric), unit: str(r.unit), asOf: str(r.as_at_date) }) },
  oem_tech_roadmaps: { pk: "roadmap_id", cols: "roadmap_id, tech_category, commercial_stage, target_year, announced_at", surface: "market", summary: (r) => ({ label: str(r.tech_category), stage: str(r.commercial_stage), date: num(r.target_year) === undefined ? undefined : `${num(r.target_year)}-01-01`, asOf: str(r.announced_at)?.slice(0, 10) }) },
  reroute_events: { pk: "reroute_id", cols: "reroute_id, cause, transit_delta_days, effective_from", surface: "operations", summary: (r) => ({ label: str(r.cause), value: num(r.transit_delta_days), unit: "days", asOf: str(r.effective_from)?.slice(0, 10) }) },
  statutory_computations: { pk: "computation_id", cols: "computation_id, statute_citation, result, result_unit, computed_at", surface: "regulations", summary: (r) => ({ label: str(r.statute_citation), value: num(r.result), unit: str(r.result_unit), asOf: str(r.computed_at)?.slice(0, 10) }) },
  regional_data_facts: { pk: "id", cols: "id, fact_label, value_numeric, unit, as_at_date", surface: "operations", summary: (r) => ({ label: str(r.fact_label), value: num(r.value_numeric), unit: str(r.unit), asOf: str(r.as_at_date) }) },
  state_cost_facts: { pk: "id", cols: "id, fact_label, value_numeric, unit, effective_date", surface: "operations", summary: (r) => ({ label: str(r.fact_label), value: num(r.value_numeric), unit: str(r.unit), asOf: str(r.effective_date) }) },
  grid_connection_queues: { pk: "queue_id", cols: "queue_id, dso_name, demand_available_mw, as_of", surface: "operations", summary: (r) => ({ label: str(r.dso_name), value: num(r.demand_available_mw), unit: "MW", asOf: str(r.as_of)?.slice(0, 10) }) },
  emission_factors: { pk: "factor_id", cols: "factor_id, scope_kind, wtw_co2e, quantity_basis, as_at_date", surface: "operations", summary: (r) => ({ label: str(r.scope_kind), value: num(r.wtw_co2e), unit: str(r.quantity_basis), asOf: str(r.as_at_date) }) },
};
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** A series' latest observation and its relative movement over the last week and month, from the observations of the same series_key (the nearest one on or before the day). */
function seriesState(obs: readonly { id: string; as_at_date: string; value_numeric: number | null }[]): { latest: (typeof obs)[number]; delta: { week?: number | undefined; month?: number | undefined } } {
  const sorted = [...obs].sort((a, b) => a.as_at_date.localeCompare(b.as_at_date));
  const latest = sorted[sorted.length - 1] as (typeof obs)[number];
  const at = Date.parse(latest.as_at_date);
  const move = (days: number): number | undefined => {
    const prior = [...sorted].reverse().find((o) => Date.parse(o.as_at_date) <= at - days * DAY);
    const [now, then] = [num(latest.value_numeric), num(prior?.value_numeric)];
    return now === undefined || then === undefined || then === 0 ? undefined : (now - then) / Math.abs(then);
  };
  return { latest, delta: clean({ week: move(7), month: move(30) }) };
}

/** The facts the given refs point at: one per row, a series collapsed to its latest observation carrying its movement. Keyed `${table}|${id}`. */
async function readFacts(sb: Db, refs: readonly RefRow[]): Promise<Map<string, { surface: FactSurface; summary: FactSummary }>> {
  const out = new Map<string, { surface: FactSurface; summary: FactSummary }>();
  for (const [table, spec] of Object.entries(FACT_TABLES)) {
    const ids = refs.filter((r) => r.ref_table === table).map((r) => r.ref_id);
    if (!ids.length) continue;
    const rows = await rowsByIds<Row>(sb, table, spec.cols, ids, spec.pk, spec.pk);
    if (table !== "market_series") {
      for (const r of rows) out.set(`${table}|${String(r[spec.pk])}`, { surface: spec.surface, summary: clean(spec.summary(r)) });
      continue;
    }
    const keys = [...new Set(rows.map((r) => String(r.series_key)))];
    const obs = await rowsByIds<{ id: string; series_key: string; as_at_date: string; value_numeric: number | null }>(sb, table, "id, series_key, value_numeric, as_at_date", keys, "series_key", "id");
    for (const key of keys) {
      const mine = obs.filter((o) => o.series_key === key && o.as_at_date);
      const own = rows.find((r) => r.series_key === key);
      if (!mine.length || !own) continue;
      const { latest, delta } = seriesState(mine);
      const latestRow = rows.find((r) => String(r.id) === latest.id) ?? { ...own, ...latest };
      out.set(`${table}|${String(latestRow.id)}`, { surface: spec.surface, summary: clean({ ...spec.summary({ ...own, ...latestRow, value_numeric: latest.value_numeric, as_at_date: latest.as_at_date }), delta: Object.keys(delta).length ? delta : undefined }) });
    }
  }
  return out;
}

/** The specific entities each row is filed under, from its refs. */
const specificOwn = (refs: readonly RefRow[]): Map<string, Set<string>> => {
  const own = new Map<string, Set<string>>();
  for (const r of refs) if (!isGenericEntity(r.entity_id, r.role)) own.set(r.ref_id, (own.get(r.ref_id) ?? new Set()).add(r.entity_id));
  return own;
};
const union = (m: ReadonlyMap<string, ReadonlySet<string>>): Set<string> => new Set([...m.values()].flatMap((s) => [...s]));

/** The structured figures filed under the entities each item is filed under (hop 0) or one relation away (hop 1), nearest first. */
export async function readEntityFacts(sb: Db, itemIds: readonly string[]): Promise<Map<string, FactLink[]>> {
  const out = new Map<string, FactLink[]>(itemIds.map((id) => [id, []]));
  const own = specificOwn(await refsOfRows(sb, "intelligence_items", itemIds));
  const direct = union(own);
  if (!direct.size) return out;
  const near = neighbours(await relationsAround(sb, direct));
  const reached = new Set([...direct, ...[...direct].flatMap((e) => (near.get(e) ?? []).map((n) => n.entity))]);
  const filed = (await refsOfEntities(sb, reached, Object.keys(FACT_TABLES))).filter((r) => !isGenericEntity(r.entity_id, r.role));
  const facts = await readFacts(sb, filed);
  const byEntity = new Map<string, RefRow[]>();
  for (const r of filed) byEntity.set(r.entity_id, [...(byEntity.get(r.entity_id) ?? []), r]);
  const named = await entityRefs(sb, [...new Set(filed.map((r) => r.entity_id))]);
  for (const [item, entities] of own) {
    const links = new Map<string, FactLink>();
    const add = (entity: string, hop: 0 | 1, relation?: string): void => {
      for (const r of byEntity.get(entity) ?? []) {
        const f = facts.get(`${r.ref_table}|${r.ref_id}`);
        const ref = named.get(entity);
        const key = `${r.ref_table}|${r.ref_id}`;
        if (f && ref && !links.has(key)) links.set(key, { refTable: r.ref_table, refId: r.ref_id, entity: ref, ...(relation ? { relation } : {}), hop, surface: f.surface, summary: f.summary });
      }
    };
    for (const e of entities) add(e, 0);
    for (const e of entities) for (const n of near.get(e) ?? []) add(n.entity, 1, n.relation);
    out.set(item, [...links.values()].sort((a, b) => a.hop - b.hop || a.refTable.localeCompare(b.refTable) || a.refId.localeCompare(b.refId)));
  }
  return out;
}

/** The first column that states when an obligation falls due. */
export const dueOf = (o: Row): string | undefined => str(o.due_date) ?? str(o.first_deadline) ?? str(o.date_of_application);

/**
 * The live items filed under the entities of structured rows (hop 0), or one relation away (hop 1), each with its next dated obligation (on or after `now`) and the penalty figure the statutory computations hold for it.
 * `refTable` is a structured table (market_series, ...); the result is keyed by the row id, and each link names the joining entity.
 */
export async function readFactItems(sb: Db, refTable: string, refIds: readonly string[], now: Date): Promise<Map<string, FactLink[]>> {
  const out = new Map<string, FactLink[]>(refIds.map((id) => [id, []]));
  const own = specificOwn(await refsOfRows(sb, refTable, refIds));
  const direct = union(own);
  if (!direct.size) return out;
  const near = neighbours(await relationsAround(sb, direct));
  const reached = new Set([...direct, ...[...direct].flatMap((e) => (near.get(e) ?? []).map((n) => n.entity))]);
  const filed = (await refsOfEntities(sb, reached, ["intelligence_items"])).filter((r) => !isGenericEntity(r.entity_id, r.role));
  const itemIds = [...new Set(filed.map((r) => r.ref_id))];
  const items = new Map((await chunked<{ id: string; title: string; item_type: string | null; domain: number | null }>(itemIds, (s) => (from, to) => admitItems(qb(sb.from("intelligence_items").select("id, title, item_type, domain"))).in("id", s).order("id").range(from, to))).map((i) => [i.id, i]));
  const obligations = await chunked<Row>([...items.keys()], (s) => (from, to) => qb(sb.from("obligation_objects").select("obligation_id, instrument_item_id, due_date, first_deadline, date_of_application, duty_holder_class")).in("instrument_item_id", s).order("obligation_id").range(from, to));
  const computations = await chunked<Row>(obligations.map((o) => String(o.obligation_id)), (s) => (from, to) => qb(sb.from("statutory_computations").select("computation_id, obligation_id, result, result_unit, computed_at")).in("obligation_id", s).order("computation_id").range(from, to));
  const today = now.toISOString().slice(0, 10);
  const named = await entityRefs(sb, [...new Set(filed.map((r) => r.entity_id))]);
  const byEntity = new Map<string, string[]>();
  for (const r of filed) byEntity.set(r.entity_id, [...(byEntity.get(r.entity_id) ?? []), r.ref_id]);
  const stateOf = (item: string): FactSummary => {
    const mine = obligations.filter((o) => o.instrument_item_id === item);
    const next = mine.filter((o) => (dueOf(o) ?? "") >= today && dueOf(o)).sort((a, b) => String(dueOf(a)).localeCompare(String(dueOf(b))) || String(a.obligation_id).localeCompare(String(b.obligation_id)))[0];
    const pool = computations.filter((c) => mine.some((o) => o.obligation_id === c.obligation_id));
    const latest = (xs: Row[]): Row | undefined => [...xs].sort((a, b) => String(b.computed_at).localeCompare(String(a.computed_at)))[0];
    const pick = latest(next ? pool.filter((c) => c.obligation_id === next.obligation_id) : []) ?? latest(pool);
    const [value, unit] = [num(pick?.result), str(pick?.result_unit)];
    return clean({ label: items.get(item)?.title, date: next ? dueOf(next) : undefined, dutyHolder: Array.isArray(next?.duty_holder_class) ? (next?.duty_holder_class as string[]) : undefined, penalty: value !== undefined && unit ? { value, unit } : undefined });
  };
  for (const [row, entities] of own) {
    const links = new Map<string, FactLink>();
    const add = (entity: string, hop: 0 | 1, relation?: string): void => {
      for (const id of byEntity.get(entity) ?? []) {
        const item = items.get(id);
        const ref = named.get(entity);
        if (item && ref && !links.has(id)) links.set(id, { refTable: "intelligence_items", refId: id, entity: ref, ...(relation ? { relation } : {}), hop, surface: surfaceOf(item.item_type, item.domain) as FactSurface, summary: stateOf(id) });
      }
    };
    for (const e of entities) add(e, 0);
    for (const e of entities) for (const n of near.get(e) ?? []) add(n.entity, 1, n.relation);
    out.set(row, [...links.values()].sort((a, b) => a.hop - b.hop || a.refId.localeCompare(b.refId)));
  }
  return out;
}

/** What each surface would hold, as the noun a reader understands (a label, like SURFACE_LABELS; the engine matches nothing against these). */
const TRUTH: Readonly<Record<string, string>> = { regulations: "dated obligation", market: "price series", operations: "capacity or queue figure", research: "abatement-cost or maturity evaluation" };

/** What a surface lacks, in words a reader understands: "a Market Intel price series for e-methanol". Templates over typed fields (ADR-050); the entity is a canonical name. */
export const missingTruth = (surface: string, entityName: string | null): string => {
  const label = SURFACE_LABELS[surface] ?? surface;
  return `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label} ${TRUTH[surface] ?? "figure"} ${entityName ? `for ${entityName}` : "that ties these items together"}`;
};

export interface Missing {
  surface: FactSurface;
  truth: string;
  patternFamily: string;
}
/**
 * Candidate edges name the surface truth that would complete the pair (addendum C): the pattern family the pair could form is read from the CLASSES of the entities the two items are filed under (closed tokens, discovery.json), the surface is the first one that family
 * needs with no member in the pair's neighbourhood (the two items' own surfaces and the surfaces of the figures filed near them), else the first of the four with none. Null when all four surfaces are present.
 */
export function missingFor(a: ReadonlySet<string>, b: ReadonlySet<string>, present: ReadonlySet<string>, entityName: string | null): Missing | null {
  const both = new Set([...a, ...b]);
  const hit = (classes: readonly string[]) => classes.some((c) => both.has(c));
  const rule = CONFIG.missing.families.find((f) => (f.eachSide ? f.classes.every((cs) => cs.some((c) => a.has(c)) && cs.some((c) => b.has(c))) : f.classes.every(hit))) ?? CONFIG.missing.otherwise;
  const surface = [...rule.surfaces, ...SURFACE_ORDER].find((s) => !present.has(s));
  return surface ? { surface: surface as FactSurface, truth: missingTruth(surface, entityName), patternFamily: rule.family } : null;
}
