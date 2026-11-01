// Ported from old_repo/scripts/producers/regional/neso-carbon-intensity-producer.mjs (lines 12-176)
// NESO Carbon Intensity API: the last 14 complete days of GB daily-average grid intensity into regional_data_facts (dimension grid_intensity), envelope first
// (coordinator ruling A, 2026-10-08). Blocks must be midnight-to-midnight; a misaligned block is skipped by name. Armed 2026-10-23 (the licence gate and the kill switch still decide a write).
import { fetchAllRows, type Db } from "@/core/db";
import type { ParseOut, ProducerCtx, ProducerSpec } from "@/core/producers/runner";
import { KEYS, type Rec } from "@/core/producers/upsert-plan";

import { buildEnvelopeRow, ENVELOPE_PAYLOAD_KEYS, latestPerNaturalKey, stampSource } from "./regional-envelope";

const omit = (r: Rec, k: string): Rec => Object.fromEntries(Object.entries(r).filter(([x]) => x !== k));
const SOURCE_KEY = "neso_carbon_intensity";
const REGION_CODE = "UK";
const DIMENSION = "grid_intensity";
const FACT_LABEL = "GB grid carbon intensity, daily average (NESO Carbon Intensity API)";
const SOURCE_URL = "https://carbonintensity.org.uk/";
const SOURCE_NAME = "National Energy System Operator (NESO) Carbon Intensity API";
const API = "https://api.carbonintensity.org.uk";
const DAY = 86_400_000;
const STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})Z$/;

/** The 14 complete days before `now`, as the API's stats URL (daily blocks). The clock is the caller's. */
function buildUrl(now: Date): string {
  const day0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return `${API}/intensity/stats/${iso(day0 - 14 * DAY)}T00:00Z/${iso(day0 - DAY)}T23:59Z/24`;
}

function parseNesoStats(doc: unknown): { observations: Rec[]; warnings: string[] } {
  const d = doc as { data?: Array<{ from?: string; to?: string; intensity?: { average?: unknown } }> } | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.data)) throw new Error("parseNesoStats: not a Carbon Intensity stats document (no data array)");
  const observations: Rec[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  d.data.forEach((e, i) => {
    const f = STAMP.exec(String(e?.from ?? ""));
    const t = STAMP.exec(String(e?.to ?? ""));
    if (!f || !t) return void warnings.push(`block ${i}: from/to are not YYYY-MM-DDTHH:MMZ stamps, skipped`);
    if (!(f[2] === "00" && f[3] === "00" && Date.parse(e.to as string) - Date.parse(e.from as string) === DAY)) return void warnings.push(`block ${i}: ${e.from} to ${e.to} is not one midnight to midnight day, skipped`);
    const avg = e.intensity?.average;
    if (typeof avg !== "number" || !Number.isFinite(avg) || avg < 0) return void warnings.push(`block ${i}: ${e.from} has no numeric non-negative average (got ${JSON.stringify(avg)}), skipped`);
    if (seen.has(e.from as string)) return void warnings.push(`block ${i}: duplicate period ${e.from}, first kept`);
    seen.add(e.from as string);
    observations.push({ region_code: REGION_CODE, dimension: DIMENSION, fact_label: FACT_LABEL, value_numeric: avg, unit: "gCO2/kWh", currency: null, derivation: "observed", origin_class: "official", source_key: SOURCE_KEY, source_ref: `carbonintensity.org.uk:/intensity/stats/${e.from}/${e.to}/24`, method_version: "neso-carbon-intensity-stats-parser@1", as_at_date: t[1], reference_period: f[1], n_observations: null });
  });
  return { observations, warnings };
}

export const nesoCarbonIntensity: ProducerSpec = {
  name: "neso-carbon-intensity",
  table: "regional_data_facts",
  licenceKey: "neso_carbon_intensity",
  enabled: true,
  enabledRuling: "operator 2026-10-23: population hold lifted for the structured-data producers (ADR-023 code change; rulings file 2026-10-23 and 2026-10-24)",
  killSwitchEnv: "REGIONAL_PRODUCER_NESO_CARBON_INTENSITY_ENABLED",
  async fetchDoc(ctx: ProducerCtx) {
    return { text: await (await ctx.get(buildUrl(ctx.now()), { headers: { accept: "application/json" } })).text() };
  },
  parse(doc): ParseOut<Rec> {
    let json: unknown;
    try {
      json = JSON.parse(doc.text ?? "");
    } catch (e) {
      throw new Error(`response is not JSON (${(e as Error).message}); first 120 chars: ${JSON.stringify(String(doc.text).slice(0, 120))}`);
    }
    const { observations, warnings } = parseNesoStats(json);
    return { rows: latestPerNaturalKey(observations.map(buildEnvelopeRow)), warnings, counts: { observations: observations.length } };
  },
  /** Apply only: the data_sources row and the UK region must exist (never guessed), and the NESO source is rated by the class table and stamped on each row. */
  async resolve(ctx, rows) {
    const sb = ctx.sb as Db;
    const ds = await sb.from("data_sources").select("source_key").eq("source_key", SOURCE_KEY);
    if (ds.error) throw new Error(`reading data_sources failed: ${ds.error.message}`);
    if (!(ds.data ?? []).length) throw new Error(`data_sources has no row for source_key ${SOURCE_KEY}: apply its migration first (regional_data_facts.source_key is a foreign key to it)`);
    const reg = await sb.from("regions").select("id").eq("code", REGION_CODE).maybeSingle();
    if (reg.error) throw new Error(`reading regions failed: ${reg.error.message}`);
    if (!reg.data) throw new Error(`region code ${REGION_CODE} not found in regions (a region id is never guessed)`);
    return { rows: await stampSource(sb, { url: SOURCE_URL, title: SOURCE_NAME }, rows.map((row) => ({ ...omit(row, "region_code"), region_id: (reg.data as { id: string }).id }))), refused: [] };
  },
  plan: {
    read: (sb) => fetchAllRows<Rec>((from, to) => sb.from("regional_data_facts").select(["id", "region_id", "dimension", "fact_label", ...ENVELOPE_PAYLOAD_KEYS].join(", ")).eq("source_key", SOURCE_KEY).order("id", { ascending: true }).range(from, to) as never, { cap: 50_000 }),
    key: KEYS.regionDimensionLabel,
    patchable: ENVELOPE_PAYLOAD_KEYS,
    pk: "id",
  },
};
