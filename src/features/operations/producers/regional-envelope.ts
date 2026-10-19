// Ported from old_repo/scripts/producers/regional/run-envelope-producer.mjs (lines 1-100)
// Ported from old_repo/src/lib/regional/regional-facts-envelope.mjs (lines 1-125)
// Ported from old_repo/scripts/producers/regional/bls-oews-producer.mjs (lines 13-51)
// Ported from old_repo/src/lib/regional/bls-oews-parser.mjs (lines 1-115)
// Ported from old_repo/scripts/producers/regional/eurostat-lc-lci-lev-producer.mjs (lines 12-63)
// Ported from old_repo/src/lib/regional/eurostat-lc-lci-lev-parser.mjs (lines 1-108)
// Ported from old_repo/scripts/producers/regional/eurostat-nrg-pc-205-producer.mjs (lines 12-35)
// Ported from old_repo/src/lib/regional/eurostat-nrg-pc-205-parser.mjs (lines 1-104)
// regional_data_facts is a CURRENT-STATE table (INV-244): observations become envelope rows, only the latest per (region, dimension, label) is planned, the value text is
// derived mechanically from value_numeric and unit, and a region code absent from `regions` fails the run (never guessed). Three dataset specs share it: BLS OEWS wages,
// Eurostat labour cost (mean over six member states), Eurostat non-household electricity price. Rows carry no derivation edges (ADR-043).
import { fetchAllRows, type Db } from "@/core/db";
import { regionCodes } from "@/core/entities";
import { NetworkError, StructureError, type ParseOut, type ProducerCtx, type ProducerSpec } from "@/core/producers/runner";
import { KEYS, type Rec } from "@/core/producers/upsert-plan";

export const ENVELOPE_PAYLOAD_KEYS = ["value", "value_numeric", "unit", "currency", "derivation", "origin_class", "source_key", "source_ref", "n_observations", "method_version", "as_at_date", "reference_period"] as const;
export const EUROSTAT_BASE = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";

export const formatDisplayValue = (valueNumeric: unknown, unit: unknown): string => {
  if (typeof valueNumeric !== "number" || !Number.isFinite(valueNumeric)) throw new Error(`formatDisplayValue: value_numeric must be a finite number, got ${JSON.stringify(valueNumeric)}`);
  if (typeof unit !== "string" || !unit) throw new Error("formatDisplayValue: unit is required (a value_numeric with no unit is a malformed envelope).");
  return `${valueNumeric} ${unit}`;
};

/** An observation to its envelope row. Every identity and envelope field is required; a missing one throws naming it. */
export function buildEnvelopeRow(obs: Rec): Rec {
  for (const k of ["region_code", "dimension", "fact_label", "value_numeric", "unit", "derivation", "origin_class", "source_key", "source_ref", "method_version", "as_at_date", "reference_period"]) {
    if (obs?.[k] === undefined || obs?.[k] === null || obs?.[k] === "") throw new Error(`buildEnvelopeRow: missing required field "${k}" (obs: ${JSON.stringify(obs)})`);
  }
  return { region_code: obs.region_code, dimension: obs.dimension, fact_label: obs.fact_label, value: formatDisplayValue(obs.value_numeric, obs.unit), value_numeric: obs.value_numeric, unit: obs.unit, currency: obs.currency ?? null, derivation: obs.derivation, origin_class: obs.origin_class, source_key: obs.source_key, source_ref: obs.source_ref, n_observations: obs.n_observations ?? null, method_version: obs.method_version, as_at_date: obs.as_at_date, reference_period: obs.reference_period };
}

/** The latest observation per (region, dimension, fact_label) by as_at_date, then reference_period. */
export function latestPerNaturalKey(candidates: readonly Rec[]): Rec[] {
  const latest = new Map<string, Rec>();
  for (const c of candidates) {
    const k = `${c.region_code}|${c.dimension}|${c.fact_label}`;
    const p = latest.get(k);
    if (!p || String(c.as_at_date) > String(p.as_at_date) || (String(c.as_at_date) === String(p.as_at_date) && String(c.reference_period) > String(p.reference_period))) latest.set(k, c);
  }
  return [...latest.values()];
}

// ---- JSON-stat (Eurostat) ----
export function decodeJsonStat(js: Rec): Array<{ coords: Record<string, string>; value: number }> {
  const { id, size, dimension, value } = (js ?? {}) as { id?: string[]; size?: number[]; dimension?: Record<string, { category?: { index?: Record<string, number> } }>; value?: Record<string, number | null> | Array<number | null> };
  if (!Array.isArray(id) || !Array.isArray(size) || !dimension || !value) throw new StructureError("not a JSON-stat 2.0 document (missing id/size/dimension/value).");
  const byPos = id.map((d) => {
    const idx = dimension[d]?.category?.index;
    if (!idx) throw new StructureError(`dimension "${d}" has no category.index.`);
    const out: string[] = [];
    for (const [code, pos] of Object.entries(idx)) out[pos] = code;
    return out;
  });
  const strides = new Array<number>(id.length).fill(1);
  for (let i = id.length - 2; i >= 0; i -= 1) strides[i] = (strides[i + 1] as number) * (size[i + 1] as number);
  const out: Array<{ coords: Record<string, string>; value: number }> = [];
  for (const [k, v] of Array.isArray(value) ? value.map((x, i) => [String(i), x] as const) : Object.entries(value)) {
    if (v === null || v === undefined) continue;
    let rem = Number(k);
    const coords: Record<string, string> = {};
    id.forEach((d, i) => {
      const pos = Math.floor(rem / (strides[i] as number));
      rem -= pos * (strides[i] as number);
      coords[d] = (byPos[i] as string[])[pos] as string;
    });
    out.push({ coords, value: Number(v) });
  }
  return out;
}
const firstCode = (js: Rec, dim: string): string | null => {
  const idx = ((js?.dimension as Record<string, { category?: { index?: Record<string, number> } }> | undefined)?.[dim]?.category?.index) ?? null;
  return idx ? (Object.keys(idx)[0] ?? null) : null;
};

export const OEWS_OCCUPATIONS = [{ socCode: "53-3032", title: "Heavy and Tractor-Trailer Truck Drivers" }, { socCode: "53-7062", title: "Laborers and Freight, Stock, and Material Movers, Hand" }, { socCode: "53-1047", title: "First-Line Supervisors of Transportation and Material-Moving Machine and Vehicle Operators" }] as const;
const MEASURES = { annual: { datatype: "13", unit: "USD/year", suffix: "annual median wage" }, hourly: { datatype: "08", unit: "USD/hour", suffix: "hourly median wage" } } as const;
export function buildOewsSeriesId(socCode: string, datatype: string = MEASURES.annual.datatype): string {
  const occ = String(socCode).replace(/-/g, "");
  if (!/^\d{6}$/.test(occ)) throw new Error(`buildOewsSeriesId: socCode must be 6 digits (dash optional), got "${socCode}"`);
  if (!/^\d{2}$/.test(String(datatype))) throw new Error(`buildOewsSeriesId: datatype must be 2 digits, got "${datatype}"`);
  return `OEUN0000000000000${occ}${datatype}`;
}
/** BLS OEWS: the latest annual (period A01) numeric value per catalogued series; a series with no usable observation is an honest gap. A non-success status (including a rate limit) throws with BLS's own message. */
export function parseOewsResponse(js: Rec, o: { regionCode?: string; dimension?: string } = {}): Rec[] {
  const { regionCode = "US", dimension = "labor_markets" } = o;
  if (!js || typeof js !== "object") throw new StructureError("response required.");
  if (js.status && js.status !== "REQUEST_SUCCEEDED") throw new StructureError(`BLS API did not succeed (status=${js.status}, message=${JSON.stringify(js.message ?? [])})`);
  const series = (js.Results as { series?: Array<{ seriesID: string; data?: Array<{ period: string; value: unknown; year: string }> }> } | undefined)?.series;
  if (!Array.isArray(series)) throw new StructureError("Results.series missing or not an array.");
  const idx = new Map(OEWS_OCCUPATIONS.flatMap((occ) => Object.values(MEASURES).map((m) => [buildOewsSeriesId(occ.socCode, m.datatype), { occ, m }] as const)));
  const out: Rec[] = [];
  for (const s of series) {
    const hit = idx.get(s.seriesID);
    const usable = (s.data ?? []).filter((r) => r.period === "A01" && /^-?\d+(\.\d+)?$/.test(String(r.value ?? "").trim())).sort((a, b) => Number(b.year) - Number(a.year));
    const latest = usable[0];
    if (!hit || !latest) continue;
    out.push({ region_code: regionCode, dimension, fact_label: `${regionCode} — ${hit.occ.title} ${hit.m.suffix} (OEWS)`, value_numeric: Number(latest.value), unit: hit.m.unit, currency: "USD", derivation: "observed", origin_class: "official", source_key: "bls", source_ref: s.seriesID, method_version: "bls-oews-parser@1", as_at_date: `${latest.year}-05-01`, reference_period: String(latest.year), n_observations: null });
  }
  return out;
}

export const EU_MEMBER_GEO_CODES = ["DE", "NL", "BE", "FR", "IT", "ES"] as const;
const LC_FILTER = { unit: "EUR", lcstruct: "D1_D4_MD5", nace_r2: "B-N" } as const;
/**
 * Mean of the latest labour-cost value over the member states that answered; one derived row (calculated) naming the geos and years used. A geo that failed is excluded, never imputed, and the LABEL names the geos that
 * were averaged, so a changed composition is a different fact (its own natural key and as-of) and a six-state mean is never read as the EU (register surfaces:16).
 */
export function aggregateLcLciLevForRegion(jsByGeo: Record<string, Rec>, o: { geoCodes?: readonly string[]; regionCode: string; dimension?: string }): Rec[] {
  const per: Array<{ geo: string; value: number; year: string; unit: string; currency: string | null }> = [];
  for (const geo of o.geoCodes ?? EU_MEMBER_GEO_CODES) {
    const js = jsByGeo?.[geo];
    if (!js) continue;
    const best = decodeJsonStat(js).filter((c) => c.coords.geo === geo).sort((a, b) => Number(b.coords.time) - Number(a.coords.time))[0];
    const unitCode = firstCode(js, "unit");
    if (best) per.push({ geo, value: best.value, year: String(best.coords.time), unit: unitCode === "EUR" ? "EUR/hour" : (unitCode ?? "unknown"), currency: unitCode === "EUR" ? "EUR" : null });
  }
  if (!per.length) return [];
  const years = [...new Set(per.map((f) => f.year))].sort();
  const latestYear = years[years.length - 1] as string;
  return [{ region_code: o.regionCode, dimension: o.dimension ?? "labor_markets", fact_label: `${o.regionCode} — Labour cost, business economy (EUR/hour), unweighted mean of ${per.length} member states: ${per.map((f) => f.geo).sort().join(", ")} (Eurostat lc_lci_lev)`, value_numeric: Math.round((per.reduce((s, f) => s + f.value, 0) / per.length) * 100) / 100, unit: (per[0] as { unit: string }).unit, currency: (per[0] as { currency: string | null }).currency, derivation: "calculated", origin_class: "derived", source_key: "eurostat", source_ref: `lc_lci_lev:unit=${LC_FILTER.unit};lcstruct=${LC_FILTER.lcstruct};nace_r2=${LC_FILTER.nace_r2};geo_mean_of=${per.map((f) => f.geo).sort().join(",")};years=${years.join(",")}`, method_version: "eurostat-lc-lci-lev-parser@1", as_at_date: `${latestYear}-01-01`, reference_period: latestYear, n_observations: per.length }];
}

/** Eurostat nrg_pc_205: one observation per consumption band and half-year; an unrecognised time code is skipped rather than given a guessed date. */
export function parseNrgPc205(js: Rec, o: { geo: string; regionCode: string; dimension?: string }): Rec[] {
  const unitCode = firstCode(js, "unit");
  const currency = firstCode(js, "currency");
  const labels = (js?.dimension as Record<string, { category?: { label?: Record<string, string> } }> | undefined)?.nrg_cons?.category?.label ?? {};
  const out: Rec[] = [];
  for (const { coords, value } of decodeJsonStat(js).filter((c) => c.coords.geo === o.geo)) {
    const m = /^(\d{4})-S([12])$/.exec(String(coords.time));
    if (!m) continue;
    out.push({ region_code: o.regionCode, dimension: o.dimension ?? "operational_cost", fact_label: `${o.regionCode} — Electricity price for non-household consumers, ${labels[coords.nrg_cons as string] ?? coords.nrg_cons} (all taxes and levies)`, value_numeric: value, unit: currency && unitCode === "KWH" ? `${currency}/kWh` : (unitCode ?? "unknown"), currency: currency ?? null, derivation: "observed", origin_class: "official", source_key: "eurostat", source_ref: `nrg_pc_205:geo=${o.geo};nrg_cons=${coords.nrg_cons};time=${coords.time}`, method_version: "eurostat-nrg-pc-205-parser@1", as_at_date: m[2] === "1" ? `${m[1]}-01-01` : `${m[1]}-07-01`, reference_period: coords.time, n_observations: null });
  }
  return out;
}

const ENVELOPE_SELECT = ["id", "region_id", "dimension", "fact_label", ...ENVELOPE_PAYLOAD_KEYS].join(", ");
/** Region codes to ids; a code absent from `regions` throws (INV-244: refused, never guessed). The rows then carry region_id and no region_code. */
async function resolveRegions(ctx: ProducerCtx, rows: Rec[]): Promise<{ rows: Rec[]; refused: string[] }> {
  const regions = await regionCodes(ctx.sb as Db);
  const byCode = new Map(regions.map((r) => [r.code, r.id]));
  const missing = [...new Set(rows.map((r) => String(r.region_code)))].filter((c) => !byCode.has(c));
  if (missing.length) throw new Error(`region code(s) not found in the live regions table: ${missing.join(", ")}`);
  return { rows: rows.map(({ region_code, ...rest }) => ({ ...rest, region_id: byCode.get(String(region_code)) })), refused: [] };
}

function envelopeSpec(o: { name: string; licenceKey: string; killSwitchEnv: string; sourceKey: string; fetchDoc: ProducerSpec["fetchDoc"]; parseDoc(text: string, ctx: ProducerCtx): Promise<Rec[]> | Rec[] }): ProducerSpec {
  return {
    name: o.name, table: "regional_data_facts", licenceKey: o.licenceKey, enabled: false, enabledRuling: "operator 2026-10-04: no data population before every build layer is complete", killSwitchEnv: o.killSwitchEnv,
    fetchDoc: o.fetchDoc,
    async parse(doc, ctx): Promise<ParseOut<Rec>> {
      const observations = await o.parseDoc(doc.text ?? "", ctx);
      const all = observations.map(buildEnvelopeRow);
      const rows = latestPerNaturalKey(all);
      return { rows, warnings: all.length !== rows.length ? [`${all.length - rows.length} superseded period(s) dropped (current-state table)`] : [], counts: { observations: all.length } };
    },
    resolve: resolveRegions,
    plan: {
      read: (sb) => fetchAllRows<Rec>((from, to) => sb.from("regional_data_facts").select(ENVELOPE_SELECT).eq("source_key", o.sourceKey).order("id", { ascending: true }).range(from, to) as never, { cap: 50_000 }),
      key: KEYS.regionDimensionLabel,
      patchable: ENVELOPE_PAYLOAD_KEYS,
      pk: "id",
    },
  };
}

const json = (text: string): Rec => JSON.parse(text) as Rec;
export const blsOews = envelopeSpec({
  name: "bls-oews", licenceKey: "bls", killSwitchEnv: "REGIONAL_PRODUCER_BLS_OEWS_ENABLED", sourceKey: "bls",
  async fetchDoc(ctx) {
    const seriesid = OEWS_OCCUPATIONS.flatMap((o) => Object.values(MEASURES).map((m) => buildOewsSeriesId(o.socCode, m.datatype)));
    return { text: await (await ctx.get("https://api.bls.gov/publicAPI/v2/timeseries/data/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seriesid }) })).text() };
  },
  parseDoc: (text) => parseOewsResponse(json(text), { regionCode: "US", dimension: "labor_markets" }),
});
export const eurostatLabourCost = envelopeSpec({
  name: "eurostat-lc-lci-lev", licenceKey: "eurostat", killSwitchEnv: "REGIONAL_PRODUCER_EUROSTAT_LC_LCI_LEV_ENABLED", sourceKey: "eurostat",
  /** One fetch per member state; a state that fails is excluded from the mean (and named in the document), never imputed. */
  async fetchDoc(ctx) {
    const byGeo: Record<string, unknown> = {};
    for (const geo of EU_MEMBER_GEO_CODES) {
      try {
        byGeo[geo] = await (await ctx.get(`${EUROSTAT_BASE}/lc_lci_lev?format=JSON&lang=EN&geo=${geo}&unit=${LC_FILTER.unit}&lcstruct=${LC_FILTER.lcstruct}&nace_r2=${LC_FILTER.nace_r2}`)).json();
      } catch (e) {
        if (!(e instanceof NetworkError)) throw e;
      }
    }
    return { text: JSON.stringify(byGeo) };
  },
  parseDoc: (text) => aggregateLcLciLevForRegion(json(text) as Record<string, Rec>, { regionCode: "EU", dimension: "labor_markets" }),
});
export const eurostatElectricity = envelopeSpec({
  name: "eurostat-nrg-pc-205", licenceKey: "eurostat", killSwitchEnv: "REGIONAL_PRODUCER_EUROSTAT_NRG_PC_205_ENABLED", sourceKey: "eurostat",
  async fetchDoc(ctx) {
    return { text: await (await ctx.get(`${EUROSTAT_BASE}/nrg_pc_205?format=JSON&lang=EN&geo=EU27_2020&unit=KWH&currency=EUR&tax=I_TAX`)).text() };
  },
  parseDoc: (text) => parseNrgPc205(json(text), { geo: "EU27_2020", regionCode: "EU" }),
});
