// Ported from old_repo/scripts/spec09/oem-roadmap-producer.mjs (lines 15-112)
// Ported from old_repo/scripts/spec09/grid-queue-producer.mjs (lines 15-83)
// Ported from old_repo/scripts/spec09/reroute-producer.mjs (lines 23-109)
// Ported from old_repo/scripts/spec09/grid-queue-producer.mjs (lines 89-154)
// Three reviewed rows-file producers (OEM roadmaps, grid connection queues, reroute events) and the ONE driver they share. Every row carries a citation; the cited
// host is rated by the class table; a figure whose source cannot be rated is refused by name; an entity is resolved by exact canonical name and never minted. With no
// rows file the run records the gap and writes nothing (INV-121).
import { fetchAllRows, type Db } from "@/core/db";
import { entitiesByKind, entityId, planOrganisation, planOrganisationFkUpdates } from "@/core/entities";
import { acceptStoredQuote } from "@/core/producers/quote";
import { loadRowsFile, registerCitedSource, requireCitation, resolveEntityByName, RowsFileError, type Citation } from "@/core/producers/rows-file";
import type { ParseOut, ProducerCtx, ProducerSpec } from "@/core/producers/runner";
import { keyOf, type Rec } from "@/core/producers/upsert-plan";
import { classTierForHost } from "@/core/sources";
import { hostOf } from "@/core/shared";

type Entity = { entity_id: string; canonical_name: string };
export type ParsedRow = { refused: true; reason: string } | { refused: false; dbRow: Rec; citation: Citation };

export const need = (row: Rec, fields: string[], where: string, i: number): void => {
  for (const f of fields) if (row[f] === undefined || row[f] === null || row[f] === "") throw new RowsFileError(`${where}: row[${i}] missing required field "${f}".`);
};
const oneOf = (v: unknown, set: readonly string[], label: string, where: string, i: number): void => {
  if (!set.includes(String(v))) throw new RowsFileError(`${where}: row[${i}].${label} "${v}" is not one of ${set.join(", ")}.`);
};
export const refuse = (reason: string): ParsedRow => ({ refused: true, reason });

const TECH = ["heavy_battery", "megawatt_charging", "hydrogen_fcell", "ammonia_engine", "methanol_dualfuel", "saf_refinery", "e_axle", "reefer_electrification"];
const STAGES = ["announced", "pilot_demonstration", "small_batch_fleet", "mass_series_production"];
const ORIGINS = ["community", "community-corroborated", "modelled", "derived", "partner", "verified", "official"];
const DERIVATIONS = ["statutory_fixed", "statutory_formula", "observed", "transacted_index", "assessed", "calculated", "interpolated", "modelled", "estimated"];
const OBS_STATUS = ["A", "P", "E", "I", "F", "B", "D", "U", "V", "G", "M", "O", "L", "H", "Q", "N"];

function parseOemRoadmapRow(row: Rec, i: number, manufacturers: readonly Entity[]): ParsedRow {
  const where = "oem-roadmap-producer";
  const citation = requireCitation(row, i, where);
  need(row, ["manufacturer_name", "tech_category", "commercial_stage", "announced_at"], where, i);
  oneOf(row.tech_category, TECH, "tech_category", where, i);
  oneOf(row.commercial_stage, STAGES, "commercial_stage", where, i);
  if (row.density_basis != null) oneOf(row.density_basis, ["cell", "module", "pack"], "density_basis", where, i);
  if (row.energy_density_wh_kg != null && row.density_basis == null) return refuse(`row[${i}]: energy_density_wh_kg is set with no density_basis: spec 09 requires a stated basis, never mixed silently.`);
  const origin = (row.origin_class as string | undefined) ?? "community";
  oneOf(origin, ORIGINS, "origin_class", where, i);
  const derivation = (row.derivation as string | undefined) ?? "observed";
  oneOf(derivation, DERIVATIONS, "derivation", where, i);
  if (row.confidence_admiralty != null && !/^[A-F][1-6]$/.test(String(row.confidence_admiralty))) throw new RowsFileError(`${where}: row[${i}].confidence_admiralty "${row.confidence_admiralty}" must match ^[A-F][1-6]$.`);
  const known = resolveEntityByName(manufacturers, String(row.manufacturer_name));
  // A manufacturer named by its own rated citation host is minted on apply by the organisation path (mintOrganisation); any other unknown name is refused.
  const minted = !known && hostOf(citation.url) === String(row.manufacturer_name);
  const manufacturerId = known ?? (minted ? entityId("organisation", String(row.manufacturer_name)) : null);
  if (!manufacturerId) return refuse(`row[${i}]: manufacturer "${row.manufacturer_name}" not found in the live entities(kind='organisation') spine; minting one is out of this producer's write set.`);
  return {
    refused: false,
    citation,
    dbRow: { manufacturer_id: manufacturerId, tech_category: row.tech_category, commercial_stage: row.commercial_stage, target_year: row.target_year ?? null, energy_density_wh_kg: row.energy_density_wh_kg ?? null, density_basis: row.density_basis ?? null, c_rate_max: row.c_rate_max ?? null, usable_kwh: row.usable_kwh ?? null, announced_at: row.announced_at, source_id: null, origin_class: origin, derivation, confidence_admiralty: row.confidence_admiralty ?? null, ...(minted ? { __mint: citation.url } : {}) },
  };
}

function parseGridQueueRow(row: Rec, i: number, jurisdictions: readonly Entity[]): ParsedRow {
  const where = "grid-queue-producer";
  const citation = requireCitation(row, i, where);
  need(row, ["jurisdiction_name", "dso_name", "capacity_band_mw", "as_of"], where, i);
  const [p50, p90] = [row.queue_months_p50, row.queue_months_p90];
  if (p50 == null && p90 == null) throw new RowsFileError(`${where}: row[${i}] must carry at least one of queue_months_p50/queue_months_p90.`);
  for (const [k, v] of [["queue_months_p50", p50], ["queue_months_p90", p90]] as const) if (v != null && Number(v) < 0) throw new RowsFileError(`${where}: row[${i}].${k} must be >= 0.`);
  if (p50 != null && p90 != null && Number(p90) < Number(p50)) return refuse(`row[${i}]: queue_months_p90 (${p90}) < queue_months_p50 (${p50}): a queue cannot read faster at the worse-case percentile.`);
  const obs = (row.obs_status as string | undefined) ?? "A";
  if (!OBS_STATUS.includes(obs)) throw new RowsFileError(`${where}: row[${i}].obs_status "${obs}" is not a valid SDMX CL_OBS_STATUS code.`);
  const jurisdictionId = resolveEntityByName(jurisdictions, String(row.jurisdiction_name));
  if (!jurisdictionId) return refuse(`row[${i}]: jurisdiction "${row.jurisdiction_name}" not found in the live entities(kind='jurisdiction') spine; minting one is out of this producer's write set.`);
  return { refused: false, citation, dbRow: { jurisdiction_id: jurisdictionId, dso_name: String(row.dso_name), capacity_band_mw: String(row.capacity_band_mw), queue_months_p50: p50 ?? null, queue_months_p90: p90 ?? null, as_of: row.as_of, obs_status: obs, source_id: null } };
}

const ROUTES = ["suez", "cape_of_good_hope", "panama", "cape_horn", "arctic", "overland"];
/** A reroute is the same corridor sailed another way (corridor identity is ORIGIN-DEST:mode, so Suez and the Cape share it): route_via says which way, and the multiplier is derived later (derived_values), never typed here. */
function parseRerouteRow(row: Rec, i: number, corridors: readonly Entity[]): ParsedRow {
  const where = "reroute-producer";
  const citation = requireCitation(row, i, where);
  need(row, ["baseline_corridor_name", "route_via", "cause", "effective_from"], where, i);
  oneOf(row.route_via, ROUTES, "route_via", where, i);
  if (row.fuel_burn_multiplier != null) return refuse(`row[${i}]: a typed fuel_burn_multiplier (${row.fuel_burn_multiplier}) is refused: the multiplier is derived from the stated transit days or distance (derived_values), never typed.`);
  if (row.effective_to && String(row.effective_to) < String(row.effective_from)) throw new RowsFileError(`${where}: row[${i}].effective_to (${row.effective_to}) is before effective_from (${row.effective_from}).`);
  const toName = String(row.reroute_corridor_name ?? row.baseline_corridor_name);
  const baseline = resolveEntityByName(corridors, String(row.baseline_corridor_name));
  const reroute = resolveEntityByName(corridors, toName);
  if (!baseline || !reroute) return refuse(`row[${i}]: corridor(s) not found in the live entity spine (baseline "${row.baseline_corridor_name}" ${baseline ? "found" : "MISSING"}, reroute "${toName}" ${reroute ? "found" : "MISSING"}); minting a corridor entity is out of this producer's write set.`);
  return { refused: false, citation, dbRow: { baseline_corridor_id: baseline, reroute_corridor_id: reroute, route_via: row.route_via, cause: String(row.cause), distance_delta_nm: row.distance_delta_nm ?? null, transit_delta_days: row.transit_delta_days ?? null, effective_from: row.effective_from, effective_to: row.effective_to ?? null } };
}

export interface RowsFileDef {
  name: string;
  table: string;
  /** The kind of entity a row names by canonical name (read once per run); null for a file whose rows resolve nothing by name. */
  entityKind: "organisation" | "jurisdiction" | "corridor" | null;
  gap: string;
  killSwitchEnv: string;
  pk: string;
  keyFields: readonly string[];
  /** The table carries a source_id column: the registered source is stored on the row. */
  storesSource: boolean;
  parseRow(row: Rec, i: number, entities: readonly Entity[]): ParsedRow;
  /** Apply only, for a row whose citation passed: what the registered source and the verified capture add to the row, and the entities it names (a table with no source_id column keeps its provenance in the row). */
  settle?(sb: Db, row: Rec, proof: { source_id: string; capture_id: string; citation: Citation }, now: Date): Promise<Rec>;
}
async function readEntities(sb: Db | null, kind: string | null): Promise<Entity[]> {
  return sb && kind ? entitiesByKind(sb, kind) : [];
}

/** What one run has learned about its quotes: the text of each capture read and the capture each (url, quote) found, so the database is asked once per distinct (url, quote) and a capture is read once (FIX-QUOTE-1). */
type QuoteCache = { texts: Map<string, string>; found: Map<string, string | null> };

/** The quote and every further quote of a citation must stand verbatim on a stored capture of the cited URL: the capture id of the first, or the first refusal. */
async function checkQuotes(sb: Db, c: Citation, cache: QuoteCache): Promise<{ captureId: string } | { reason: string }> {
  let first = "";
  for (const quote of [c.quote, ...(c.also ?? [])]) {
    const v = await acceptStoredQuote(sb, { url: c.url, quote, verifiedAt: c.retrieved_at }, cache.texts, cache.found);
    if (!v.ok) return { reason: `${v.reason}: ${v.detail}` };
    first ||= v.captureId;
  }
  return { captureId: first };
}

/** The existing organisation path (planOrganisation: the entity and its HOST identifier, then the source row's organisation_entity_id) for a manufacturer whose name is its rated citation host; never a hand-typed entity row, and a second call finds it held. */
async function mintOrganisation(sb: Db, url: string, sourceId: string, now: Date): Promise<void> {
  const id = entityId("organisation", hostOf(url) as string);
  const [ents, idents] = await Promise.all([sb.from("entities").select("entity_id").eq("entity_id", id), sb.from("entity_identifiers").select("entity_id, scheme, value").eq("entity_id", id)]);
  for (const r of [ents, idents]) if (r.error) throw new Error(`reading the organisation ${id} failed: ${r.error.message}`);
  const plan = planOrganisation([url], { existingEntityIds: new Set((ents.data ?? []).map((e) => e.entity_id)), existingIdentifierKeys: new Set((idents.data ?? []).map((i) => `${i.entity_id}|${i.scheme}|${i.value}`)), assertedBy: "producer:rows-file", now });
  for (const [table, list] of [["entities", plan.entities], ["entity_identifiers", plan.identifiers]] as const) {
    const { error } = list.length ? await sb.from(table).insert(list as never) : { error: null };
    if (error) throw new Error(`insert into ${table} failed: ${error.message}`);
  }
  for (const u of planOrganisationFkUpdates([{ id: sourceId, url }], plan.byHost)) {
    const { error } = await sb.from("sources").update({ organisation_entity_id: u.organisation_entity_id }).eq("id", u.id).is("organisation_entity_id", null);
    if (error) throw new Error(`linking source ${u.id} to its organisation failed: ${error.message}`);
  }
}

/** The one rows-file driver: parse every row (a bad row is refused by name, never fatal to the others), rate the citation host, insert only rows not already present. */
export function rowsFileSpec(def: RowsFileDef): ProducerSpec {
  return {
    name: def.name,
    table: def.table,
    licenceKey: null,
    enabled: true,
    enabledRuling: "operator 2026-10-23: population hold lifted for the structured-data producers (ADR-023 code change; rulings file 2026-10-23 and 2026-10-24)",
    killSwitchEnv: def.killSwitchEnv,
    gap: def.gap,
    async fetchDoc() {
      return { text: "" };
    },
    async parse(doc, ctx: ProducerCtx): Promise<ParseOut<Rec>> {
      const rows = loadRowsFile(doc.text ?? "", def.name);
      const entities = await readEntities(ctx.sb, def.entityKind);
      const warnings: string[] = [];
      const out: Rec[] = [];
      const citations: Record<string, Citation> = {};
      rows.forEach((raw, i) => {
        let r: ParsedRow;
        try {
          r = def.parseRow(raw, i, entities);
        } catch (e) {
          r = refuse((e as Error).message);
        }
        const host = r.refused ? null : hostOf(r.citation.url);
        if (r.refused) warnings.push(`[refused] ${r.reason}`);
        else if (!host || classTierForHost(host, r.citation.title) == null) warnings.push(`[refused] row[${i}]: citation refused: host "${host ?? r.citation.url}" does not resolve to a codified class; ambiguous hosts are worklisted, never guessed a tier (SC-13)`);
        else {
          out.push(r.dbRow);
          citations[String(i)] = r.citation;
          (r.dbRow as Rec).__i = i;
        }
      });
      ctx.state.citations = citations;
      return { rows: out, warnings, counts: { rows_in_file: rows.length, refused_rows_parse: rows.length - out.length } };
    },
    /** Apply only: register each citation at its class-table tier; a refusal drops the row, named. */
    async resolve(ctx, rows) {
      const citations = ctx.state.citations as Record<string, Citation>;
      const kept: Rec[] = [];
      const refused: string[] = [];
      const cache: QuoteCache = { texts: new Map(), found: new Map() };
      for (const row of rows) {
        const { __i, __mint, ...dbRow } = row as Rec & { __i: number; __mint?: string };
        const c = citations[String(__i)] as Citation;
        const proof = await checkQuotes(ctx.sb as Db, c, cache);
        const reg = "reason" in proof ? null : await registerCitedSource({ url: c.url, title: c.title }, { sb: ctx.sb });
        if ("reason" in proof) refused.push(`row[${__i}]: citation refused: ${proof.reason}`);
        else if (reg?.refused) refused.push(`row[${__i}]: citation refused: ${reg.reason}`);
        else if (reg) {
          if (__mint) await mintOrganisation(ctx.sb as Db, __mint, reg.source_id, ctx.now());
          const row = def.storesSource ? { ...dbRow, source_id: reg.source_id } : dbRow;
          kept.push(def.settle ? await def.settle(ctx.sb as Db, row, { source_id: reg.source_id, capture_id: proof.captureId, citation: c }, ctx.now()) : row);
        }
      }
      return { rows: kept, refused };
    },
    plan: {
      read: (sb) => fetchAllRows<Rec>((from, to) => sb.from(def.table).select([def.pk, ...def.keyFields].join(", ")).order(def.pk, { ascending: true }).range(from, to) as never, { cap: 200_000 }),
      key: (r) => keyOf(def.keyFields.map((f) => r[f])),
      patchable: [],
      pk: def.pk,
    },
  };
}

export const oemRoadmapRows = rowsFileSpec({ name: "oem-roadmap-rows", table: "oem_tech_roadmaps", entityKind: "organisation", killSwitchEnv: "OEM_PRODUCER_ROWS_FILE_ENABLED", pk: "roadmap_id", keyFields: ["manufacturer_id", "tech_category", "commercial_stage", "announced_at"], storesSource: true, parseRow: parseOemRoadmapRow, gap: "no $0 structured feed for OEM commercial-stage announcements; the input is a reviewed rows file" });
export const gridQueueRows = rowsFileSpec({ name: "grid-queue-rows", table: "grid_connection_queues", entityKind: "jurisdiction", killSwitchEnv: "OPERATIONS_PRODUCER_GRID_QUEUE_ROWS_ENABLED", pk: "queue_id", keyFields: ["jurisdiction_id", "dso_name", "capacity_band_mw", "as_of"], storesSource: true, parseRow: parseGridQueueRow, gap: "no confirmed $0 feed for demand-side DSO connection-queue months; the input is a reviewed rows file" });
export const rerouteRows = rowsFileSpec({ name: "reroute-rows", table: "reroute_events", entityKind: "corridor", killSwitchEnv: "MARKET_PRODUCER_REROUTE_ROWS_ENABLED", pk: "reroute_id", keyFields: ["baseline_corridor_id", "route_via", "effective_from"], storesSource: true, parseRow: parseRerouteRow, gap: "no $0 structured feed for carrier and canal reroute notices; the input is a reviewed rows file" });
