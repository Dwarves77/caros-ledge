// Ported from old_repo/scripts/producers/market/eia-v2-petroleum-spot-producer.mjs (lines 33-141)
// EIA API v2 weekly petroleum spot prices (six products) into market_series. The key (the one documented free-key exception) is read by env NAME, sent as a
// query parameter, and redacted from every error message.
import { slugify } from "@/core/shared";
import { NetworkError, type ParseOut, type ProducerSpec } from "@/core/producers/runner";
import type { Rec } from "@/core/producers/upsert-plan";

import { marketSeriesBase, stampEntity } from "./market-series-delta";

export const EIA_KEY_ENV = "EIA_API_KEY";
const URL_BASE = "https://api.eia.gov/v2/petroleum/pri/spt/data/?frequency=weekly&data[0]=value&sort[0][column]=period&sort[0][direction]=desc&length=5000";
export const PRODUCTS: Readonly<Record<string, { slug: string; label: string }>> = Object.freeze({
  EPCWTI: { slug: "wti-crude", label: "WTI crude oil spot price" },
  EPCBRENT: { slug: "brent-crude", label: "Brent crude oil spot price" },
  EPD2F: { slug: "diesel-no2-low-sulfur", label: "No. 2 diesel, ultra-low sulfur, spot price" },
  EPJK: { slug: "jet-fuel-kerosene", label: "Kerosene-type jet fuel spot price" },
  EPMRR: { slug: "gasoline-rbob-regular", label: "RBOB regular gasoline spot price" },
  EPLLPA: { slug: "propane-mont-belvieu", label: "Propane, Mont Belvieu TX, spot price" },
});

/** Parse an EIA v2 envelope. An unknown product, a bad period, a missing unit and a duplicate (series, period) are each skipped with a named reason. */
export function parseEiaV2PetroleumSpot(json: unknown): { rows: Rec[]; warnings: string[]; total: number | null } {
  const none = (w: string) => ({ rows: [] as Rec[], warnings: [w], total: null });
  if (!json || typeof json !== "object") return none("not a JSON object: cannot be an EIA API v2 response");
  const j = json as { error?: unknown; response?: { data?: unknown; warnings?: unknown[]; total?: unknown } };
  if (j.error) return none(`EIA API error: ${String(j.error)}`);
  const data = j.response?.data;
  if (!Array.isArray(data)) return none("no response.data array: not a recognisable EIA API v2 petroleum/pri/spt payload");
  const warnings = (j.response?.warnings ?? []).map((w) => `[EIA API warning] ${typeof w === "string" ? w : JSON.stringify(w)}`);
  const rows: Rec[] = [];
  const seen = new Set<string>();
  data.forEach((raw, i) => {
    const row = (raw ?? {}) as Record<string, unknown>;
    const def = PRODUCTS[String(row.product)];
    const period = String(row.period ?? "");
    const value = Number(row.value);
    const unit = row.units;
    const seriesId = row.series ? slugify(String(row.series), 200) : slugify(`${row.duoarea ?? ""}-${row.process ?? ""}`, 200);
    const skip = (why: string) => warnings.push(`row ${i}: ${why}`);
    if (!def) return skip(`unrecognised product "${row.product}": row skipped (not a fabricated series)`);
    if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(period)) return skip(`bad period "${period}" for product "${row.product}": row skipped`);
    if (!Number.isFinite(value) || row.value === null || row.value === "") return skip(`non-numeric value "${row.value}" for product "${row.product}": row skipped`);
    if (!unit || typeof unit !== "string") return skip(`missing "units" for product "${row.product}": row skipped (never a guessed unit)`);
    if (!seriesId) return skip('could not derive a series identity (no "series", "duoarea", or "process" field): row skipped');
    const seriesKey = `eia-v2:${def.slug}-${seriesId}`;
    if (seen.has(`${seriesKey} ${period}`)) return skip(`duplicate (series_key, period) "${seriesKey} ${period}" in this response: first occurrence kept`);
    seen.add(`${seriesKey} ${period}`);
    rows.push({
      series_key: seriesKey, label: `${def.label} — ${row["area-name"] || row.duoarea || "unspecified area"}`, value_numeric: value, unit, currency: "USD", derivation: "observed", origin_class: "official", source_key: "eia",
      source_ref: `EIA Open Data API v2, petroleum/pri/spt, series ${row.series ?? seriesId}, period ${period}`, n_observations: null, method_version: null, as_at_date: period.length === 10 ? period : null, reference_period: period,
    });
  });
  const total = Number(j.response?.total);
  return { rows, warnings, total: Number.isFinite(total) ? total : null };
}

export const eiaPetroleumSpot: ProducerSpec = {
  name: "eia-v2-petroleum-spot",
  ...marketSeriesBase("eia-v2"),
  licenceKey: "eia",
  enabled: false,
  enabledRuling: "operator 2026-10-04: no data population before every build layer is complete (ADR-023: flipping this is a reviewed code change)",
  killSwitchEnv: "MARKET_PRODUCER_EIA_V2_ENABLED",
  keyEnv: EIA_KEY_ENV,
  async fetchDoc(ctx) {
    const key = ctx.deps.env[EIA_KEY_ENV];
    if (!key) throw new NetworkError(`no ${EIA_KEY_ENV} in the environment: cannot fetch live; pass a saved EIA API v2 response as the input`);
    const res = await ctx.get(`${URL_BASE}&api_key=${encodeURIComponent(key)}`, { headers: { accept: "application/json" } });
    return { text: await res.text() };
  },
  parse(doc, ctx): ParseOut<Rec> {
    let json: unknown;
    try {
      json = JSON.parse(doc.text ?? "");
    } catch (e) {
      return { rows: [], warnings: [`input was not valid JSON (${(e as Error).message})`] };
    }
    const out = parseEiaV2PetroleumSpot(json);
    // The response reports its own total: more rows than one page carried means the read was partial and apply refuses it.
    const truncated = out.total !== null && out.total > (((json as { response?: { data?: unknown[] } }).response?.data ?? []).length);
    return { rows: stampEntity(out.rows, ctx), warnings: truncated ? [...out.warnings, `response.total ${out.total} exceeds the rows returned: partial read`] : out.warnings, truncated };
  },
};
