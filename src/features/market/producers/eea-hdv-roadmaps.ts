// Ported from old_repo/scripts/producers/oem/eea-hdv-csv.mjs (lines 118-208)
// Ported from old_repo/scripts/producers/oem/eea-hdv-map.mjs (lines 1-181)
// Ported from old_repo/scripts/producers/oem/eea-hdv-co2-producer.mjs (lines 19-180)
// EEA heavy-duty CO2 extract streamed, aggregated by (manufacturer, flags, fuels), classified, staged from the latest registration year and planned into
// oem_tech_roadmaps. Registrations evidence AVAILABILITY only (1-999 vehicles small_batch_fleet, 1000+ mass_series_production); the zero-emission fuel rules and
// manufacturer aliases are empty until a real run's residue shows the values (ruling 2026-10-08). HELD: enabled false.
import { z } from "zod";

import { limitBytes, readCsvStream } from "@/core/csv/stream";
import { entitiesByKind } from "@/core/entities";
import { registerCitedSource, resolveEntityByName } from "@/core/producers/rows-file";
import { StructureError, type ParseOut, type ProducerCtx, type ProducerSpec } from "@/core/producers/runner";
import { KEYS, type Rec } from "@/core/producers/upsert-plan";

import config from "./data/eea-hdv-classification.json";

const DATASET = {
  csv_url: "https://discomap.eea.europa.eu/App/CO2HDV/HDV_CO2Emission_VehicleExtract_24042025.csv",
  page_url: "https://www.eea.europa.eu/en/datahub/datahubitem-view/c52f7b51-c1cf-43e5-9a66-3eea19f6385a",
  source_name: "European Environment Agency: CO2 emissions from heavy-duty vehicles",
} as const;
const DRY_SAMPLE_BYTES = 8 * 1024 * 1024;
const EEA_HDV_COLUMNS = ["Match", "UniqueData", "OEM_ManufacturerName", "OEM_ZeroEmissionVehicle", "OEM_HybridElectricHDV", "OEM_DualFuelVehicle", "OEM_Engine_FuelType", "MS_FuelType", "MS_Electric", "MS_RegistrationCountry", "MS_RegistrationDateClean_YYYYMMDD"] as const;
const TECH = ["heavy_battery", "megawatt_charging", "hydrogen_fcell", "ammonia_engine", "methanol_dualfuel", "saf_refinery", "e_axle", "reefer_electrification"] as const;
const STAGES = ["announced", "pilot_demonstration", "small_batch_fleet", "mass_series_production"] as const;
const COVERED_COLUMNS = ["manufacturer_id", "tech_category", "commercial_stage", "source_id", "origin_class", "derivation", "confidence_admiralty"] as const;

const classification = z
  .object({
    notes: z.string().optional(),
    zev_tech_rules: z.array(z.object({ when: z.partialRecord(z.enum(["ms_fuel", "engine_fuel", "ms_electric"]), z.string()).refine((w) => Object.keys(w).length > 0, "when needs at least one key"), tech_category: z.enum(TECH) }).strict()).default([]),
    stage_rules: z.array(z.object({ min_units: z.number().int().min(1), stage: z.enum(STAGES) }).strict()).default([]).refine((r) => new Set(r.map((x) => x.min_units)).size === r.length, "duplicate min_units in stage_rules"),
    manufacturer_aliases: z.record(z.string(), z.string().trim().min(1)).default({}),
  })
  .strict();
export type Classification = z.infer<typeof classification>;
const validateClassification = (obj: unknown): Classification => {
  const c = classification.parse(obj);
  return { ...c, stage_rules: [...c.stage_rules].sort((a, b) => b.min_units - a.min_units) };
};
const CFG = validateClassification(config);

export interface HdvGroup {
  manufacturer: string; zev: string; hybrid: string; dual_fuel: string; engine_fuel: string; ms_fuel: string; ms_electric: string;
  units: number; units_by_year: Record<string, number>; undated_units: number; first_registration: string | null; last_registration: string | null; countries: string[];
}
export interface HdvAggregate {
  truncated: boolean;
  totals: { records: number; counted: number; excluded: Record<string, number>; malformed: number };
  groups: HdvGroup[];
}
/** Fold the extract into groups, streaming; `maxBytes` cuts the read and marks it truncated (the half record at the cut is dropped, never counted). */
async function aggregateHdvCsv(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array | string>, { maxBytes }: { maxBytes?: number | null } = {}): Promise<HdvAggregate> {
  const state = { truncated: false };
  const source = maxBytes ? limitBytes(chunks, maxBytes, state) : chunks;
  const totals = { records: 0, counted: 0, excluded: {} as Record<string, number>, malformed: 0 };
  const groups = new Map<string, Omit<HdvGroup, "countries"> & { countries: Set<string> }>();
  let header: string[] | null = null;
  let col: Record<string, number> = {};
  const exclude = (k: string) => (totals.excluded[k] = (totals.excluded[k] ?? 0) + 1);
  for await (const rec of readCsvStream(source, { dropTail: () => state.truncated })) {
    if (header === null) {
      header = rec;
      col = Object.fromEntries(EEA_HDV_COLUMNS.map((n) => [n, (header as string[]).indexOf(n)]));
      const missing = EEA_HDV_COLUMNS.filter((n) => col[n] === -1);
      if (missing.length) throw new StructureError(`the header has no column ${missing.join(", ")}: this is not the EEA HDV vehicle extract this producer reads`);
      continue;
    }
    totals.records += 1;
    if (rec.length !== header.length) {
      totals.malformed += 1;
      continue;
    }
    const at = (n: string) => rec[col[n] as number] as string;
    if (at("Match") !== "Match") {
      exclude(`Match=${at("Match")}`);
      continue;
    }
    if (at("UniqueData") !== "Yes") {
      exclude(`UniqueData=${at("UniqueData")}`);
      continue;
    }
    totals.counted += 1;
    const g = { manufacturer: at("OEM_ManufacturerName"), zev: at("OEM_ZeroEmissionVehicle"), hybrid: at("OEM_HybridElectricHDV"), dual_fuel: at("OEM_DualFuelVehicle"), engine_fuel: at("OEM_Engine_FuelType"), ms_fuel: at("MS_FuelType"), ms_electric: at("MS_Electric") };
    const key = Object.values(g).join("\u0000");
    const agg = groups.get(key) ?? { ...g, units: 0, units_by_year: {}, undated_units: 0, first_registration: null, last_registration: null, countries: new Set<string>() };
    groups.set(key, agg);
    agg.units += 1;
    const date = at("MS_RegistrationDateClean_YYYYMMDD");
    if (/^(19|20)\d{6}$/.test(date)) {
      const y = date.slice(0, 4);
      agg.units_by_year[y] = (agg.units_by_year[y] ?? 0) + 1;
      if (agg.first_registration === null || date < agg.first_registration) agg.first_registration = date;
      if (agg.last_registration === null || date > agg.last_registration) agg.last_registration = date;
    } else agg.undated_units += 1;
    if (at("MS_RegistrationCountry")) agg.countries.add(at("MS_RegistrationCountry"));
  }
  if (header === null) throw new StructureError("the body is empty: no header record");
  const list = [...groups.values()].map((a) => ({ ...a, countries: [...a.countries].sort() })).sort((a, b) => a.manufacturer.localeCompare(b.manufacturer) || a.zev.localeCompare(b.zev) || a.engine_fuel.localeCompare(b.engine_fuel) || a.ms_fuel.localeCompare(b.ms_fuel));
  return { truncated: state.truncated, totals, groups: list };
}

/** A tech category for a group, or the named residue reason. Hybrid, dual-fuel and conventional powertrains are not evidence of a roadmap technology. */
function classifyGroup(g: HdvGroup, cfg: Classification): { tech_category: string } | { residue: string } {
  if (g.zev === "Yes") {
    const rule = cfg.zev_tech_rules.find((r) => Object.entries(r.when).every(([k, v]) => (g as unknown as Record<string, string>)[k] === v));
    return rule ? { tech_category: rule.tech_category } : { residue: "zero_emission_unmapped" };
  }
  if (g.zev !== "No") return { residue: "zero_emission_flag_unreadable" };
  if (g.hybrid === "Yes") return { residue: "hybrid_powertrain" };
  return g.dual_fuel === "Yes" ? { residue: "dual_fuel_powertrain" } : { residue: "conventional_powertrain" };
}
const stageFor = (units: number, cfg: Classification): string | null => cfg.stage_rules.find((r) => units >= r.min_units)?.stage ?? null;

export interface Residue {
  byReason: Record<string, { groups: number; units: number }>;
  unresolvedManufacturers: Array<{ manufacturer: string; units: number }>;
}
/** Groups to roadmap rows: merged per (manufacturer, technology), staged from the LATEST registration year; every dropped group lands in the named residue. */
function mapGroupsToRows(groups: readonly HdvGroup[], o: { cfg: Classification; entities: ReadonlyArray<{ canonical_name: string; entity_id: string }>; sourceId: string | null }) {
  const residue: Residue = { byReason: {}, unresolvedManufacturers: [] };
  const add = (reason: string, groupsN: number, units: number) => {
    const r = (residue.byReason[reason] ??= { groups: 0, units: 0 });
    r.groups += groupsN;
    r.units += units;
  };
  const unresolved = new Map<string, number>();
  const merged = new Map<string, { manufacturerId: string; tech: string; units: number; groups: number; byYear: Record<string, number> }>();
  for (const g of groups) {
    const cls = classifyGroup(g, o.cfg);
    if ("residue" in cls) {
      add(cls.residue, 1, g.units);
      continue;
    }
    const id = resolveEntityByName(o.entities, o.cfg.manufacturer_aliases[g.manufacturer] ?? g.manufacturer);
    if (!id) {
      add("manufacturer_not_in_spine", 1, g.units);
      unresolved.set(g.manufacturer, (unresolved.get(g.manufacturer) ?? 0) + g.units);
      continue;
    }
    const m = merged.get(`${id}|${cls.tech_category}`) ?? { manufacturerId: id, tech: cls.tech_category, units: 0, groups: 0, byYear: {} };
    merged.set(`${id}|${cls.tech_category}`, m);
    m.units += g.units;
    m.groups += 1;
    for (const [y, n] of Object.entries(g.units_by_year)) m.byYear[y] = (m.byYear[y] ?? 0) + n;
  }
  const rows: Rec[] = [];
  for (const m of [...merged.values()].sort((a, b) => a.manufacturerId.localeCompare(b.manufacturerId) || a.tech.localeCompare(b.tech))) {
    const latest = Object.keys(m.byYear).sort().pop() ?? null;
    const stage = latest === null ? null : stageFor(m.byYear[latest] as number, o.cfg);
    if (stage === null) {
      add(latest === null ? "no_registration_year" : "no_stage_rule", m.groups, m.units);
      continue;
    }
    rows.push({ manufacturer_id: m.manufacturerId, tech_category: m.tech, commercial_stage: stage, target_year: null, energy_density_wh_kg: null, density_basis: null, c_rate_max: null, usable_kwh: null, announced_at: null, source_id: o.sourceId, origin_class: "official", derivation: "calculated", confidence_admiralty: null });
  }
  residue.unresolvedManufacturers = [...unresolved].map(([manufacturer, units]) => ({ manufacturer, units })).sort((a, b) => b.units - a.units || a.manufacturer.localeCompare(b.manufacturer));
  return { rows, residue };
}

const PATCH = COVERED_COLUMNS.filter((c) => !["manufacturer_id", "tech_category", "source_id"].includes(c));
const entitiesOf = async (ctx: ProducerCtx): Promise<Array<{ canonical_name: string; entity_id: string }>> => {
  if (Array.isArray(ctx.input.rowsFile)) return ctx.input.rowsFile as never;
  if (!ctx.sb) return [];
  return entitiesByKind(ctx.sb, "organisation");
};

export const eeaHdvRoadmaps: ProducerSpec = {
  name: "eea-hdv-co2",
  table: "oem_tech_roadmaps",
  licenceKey: "eea",
  enabled: false,
  enabledRuling: "operator 2026-10-04: no population before every build layer; plans 0 rows until a real run's residue fills the zero-emission rules (ruling 2026-10-08)",
  killSwitchEnv: "OEM_PRODUCER_EEA_HDV_ENABLED",
  async fetchDoc(ctx) {
    // A dry run reads a byte-limited sample (a Range request; a server that ignores it is cut at the same limit); an apply needs the whole file.
    const res = await ctx.get(DATASET.csv_url, ctx.apply ? { headers: { accept: "text/csv, application/octet-stream" } } : { range: [0, DRY_SAMPLE_BYTES - 1], headers: { accept: "text/csv, application/octet-stream" } });
    return { chunks: res.body as unknown as AsyncIterable<Uint8Array>, meta: { lastModified: res.headers.get("last-modified"), sample: !ctx.apply } };
  },
  async parse(doc, ctx): Promise<ParseOut<Rec>> {
    const chunks = doc.chunks ?? [doc.text ?? ""];
    const agg = await aggregateHdvCsv(chunks, { maxBytes: doc.meta?.sample ? DRY_SAMPLE_BYTES : null });
    const { rows, residue } = mapGroupsToRows(agg.groups, { cfg: CFG, entities: await entitiesOf(ctx), sourceId: null });
    const counts: Record<string, number> = { records: agg.totals.records, vehicles_counted: agg.totals.counted, vehicles_excluded: Object.values(agg.totals.excluded).reduce((a, b) => a + b, 0), malformed: agg.totals.malformed, groups: agg.groups.length };
    const warnings = [...Object.entries(residue.byReason).map(([r, v]) => `residue ${r}: ${v.groups} group(s), ${v.units} vehicle(s)`), ...residue.unresolvedManufacturers.slice(0, 20).map((m) => `manufacturer not in spine: ${m.manufacturer} (${m.units} vehicle(s))`)];
    return { rows, warnings, truncated: agg.truncated, counts };
  },
  /** Apply only: the EEA registers at its class-table tier; the row cites the real source id read back. A source that cannot be registered writes nothing. */
  async resolve(ctx, rows) {
    const src = await registerCitedSource({ url: DATASET.page_url, title: DATASET.source_name }, { sb: ctx.sb });
    if (src.refused) return { rows: [], refused: [`source not rated: ${src.reason}`] };
    return { rows: rows.map((r) => ({ ...r, source_id: src.source_id })), refused: [] };
  },
  plan: {
    async read(sb, rows) {
      const sourceId = rows[0]?.source_id;
      const { data, error } = await sb.from("oem_tech_roadmaps").select(["roadmap_id", "manufacturer_id", "tech_category", "source_id", ...PATCH].join(", ")).eq("source_id", sourceId as string).order("roadmap_id", { ascending: true }).limit(100_000);
      if (error) throw new Error(`reading oem_tech_roadmaps failed: ${error.message}`);
      return (data ?? []) as unknown as Rec[];
    },
    key: KEYS.manufacturerTechSource,
    patchable: PATCH,
    pk: "roadmap_id",
  },
};
