// Ported from old_repo/scripts/producers/market/carrier-ets-surcharge-producer.mjs (lines 19-134)
// Ported from old_repo/src/lib/market/carrier-ets-surcharge-envelope.mjs (lines 1-97)
// Carrier-published ETS/FuelEU surcharge notices (the EEX proxy). Each candidate is grounded verbatim in its own capture BEFORE its carrier host is rated by the
// class table; an ungrounded or unrated candidate is refused by name. One row per carrier per lane per period; the cross-carrier band is a real low/point/high,
// never a blend. HELD (enabled: false): ETS-PROXY decisions 1/2, EEX licence deferred, no apply path until a reviewed change.
import { z } from "zod";

import { groundCandidate } from "@/core/contracts";
import { loadRowsFile, registerCitedSource } from "@/core/producers/rows-file";
import type { ParseOut, ProducerCtx, ProducerSpec } from "@/core/producers/runner";
import type { Rec } from "@/core/producers/upsert-plan";
import { classTierForHost } from "@/core/sources";
import { hostOf, slugify } from "@/core/shared";

import { marketSeriesBase } from "./market-series-delta";

const candidate = z.object({
  carrierName: z.string().min(1),
  tradeLane: z.string().nullish(),
  currency: z.string().min(1),
  value: z.union([z.string(), z.number()]),
  unit: z.string().min(1),
  effectivePeriod: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  surchargeType: z.string().nullish(),
  sourceUrl: z.string().url(),
  span_text: z.string().nullish(),
});
export type EtsCandidate = z.infer<typeof candidate>;

const carrierSlug = (name: unknown): string => slugify(String(name ?? "").trim(), 200);
const sourceKeyFor = (host: string): string => `${host.replace(/\./g, "_")}_ets_notice`;

function buildCarrierEtsSurchargeRow(c: EtsCandidate, source: { source_key: string | null; tier?: number | null }): Rec {
  const lane = c.tradeLane ? `-${carrierSlug(c.tradeLane)}` : "";
  return {
    series_key: `carrier-ets:${carrierSlug(c.carrierName)}${lane}`,
    label: `${c.carrierName}, ${c.surchargeType ?? "EU ETS"} surcharge${c.tradeLane ? ` (${c.tradeLane})` : ""}`,
    value_numeric: Number(c.value), unit: c.unit, currency: c.currency, derivation: "observed", origin_class: "official", source_key: source.source_key,
    source_ref: `${c.carrierName} published surcharge notice, effective ${c.effectivePeriod}${typeof source.tier === "number" ? ` (institution tier T${source.tier})` : ""}`,
    n_observations: null, method_version: null, as_at_date: c.effectivePeriod, reference_period: c.effectivePeriod,
  };
}

export interface EtsBand {
  low: number;
  point: number;
  high: number;
  currency: unknown;
  n_carriers: number;
  derivation: "calculated";
  reference_period: unknown;
}
/** The cross-carrier band of ONE period in ONE currency: the real observed low, median and high. Fewer than two carriers is not a proxy (null); mixed currencies or periods throw. */
function buildEtsProxyBand(carrierRows: readonly Rec[] | null | undefined): EtsBand | null {
  const rows = (carrierRows ?? []).filter((r) => Number.isFinite(r.value_numeric));
  if (rows.length < 2) return null;
  const currencies = new Set(rows.map((r) => r.currency));
  if (currencies.size > 1) throw new Error(`buildEtsProxyBand: mixed currencies in one period's carrier rows (${[...currencies].join(", ")}); convert to one currency before banding, never blend across currencies`);
  const periods = new Set(rows.map((r) => r.reference_period));
  if (periods.size > 1) throw new Error(`buildEtsProxyBand: rows span multiple reference_period values (${[...periods].join(", ")}); group by period first`);
  const values = rows.map((r) => r.value_numeric as number).sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return { low: values[0] as number, point: values.length % 2 === 0 ? ((values[mid - 1] as number) + (values[mid] as number)) / 2 : (values[mid] as number), high: values[values.length - 1] as number, currency: rows[0]?.currency, n_carriers: rows.length, derivation: "calculated", reference_period: rows[0]?.reference_period };
}

export const carrierEtsSurcharge: ProducerSpec = {
  name: "carrier-ets-surcharge",
  ...marketSeriesBase("carrier-ets"),
  licenceKey: null,
  enabled: false,
  enabledRuling: "ETS-PROXY decisions 1/2 (2026-09-24/25): EEX licence deferred; the proxy is held until a reviewed change adds the apply path",
  killSwitchEnv: null,
  async fetchDoc() {
    throw new Error("the carrier ETS producer reads session-authored candidates; pass them as the input");
  },
  async parse(doc, ctx: ProducerCtx): Promise<ParseOut<Rec>> {
    const warnings: string[] = [];
    const rows: Rec[] = [];
    const hosts: Record<string, { url: string; title: string }> = {};
    const counts = { refused_ungrounded: 0, refused_unrated_source: 0 };
    for (const raw of loadRowsFile(doc.text ?? "", "ETS candidates")) {
      const parsed = candidate.safeParse(raw);
      if (!parsed.success) {
        warnings.push(`candidate refused: ${parsed.error.issues[0]?.message ?? "malformed"}`);
        continue;
      }
      const c = parsed.data;
      const id = `${c.carrierName}|${c.tradeLane ?? ""}|${c.effectivePeriod}`;
      const capture = await ctx.get(c.sourceUrl).then((r) => r.text(), () => null);
      const grounding = groundCandidate({ span_text: c.span_text ?? null }, capture);
      if (!grounding.ok) {
        counts.refused_ungrounded += 1;
        warnings.push(`${id}: refused_ungrounded: ${grounding.reason}`);
        continue;
      }
      const host = hostOf(c.sourceUrl) ?? "";
      const tier = classTierForHost(host, c.carrierName);
      if (tier == null) {
        counts.refused_unrated_source += 1;
        warnings.push(`${id}: refused_unrated_source: host "${host}" does not resolve to a codified class; ambiguous hosts are worklisted, never guessed a tier`);
        continue;
      }
      const row = buildCarrierEtsSurchargeRow(c, { source_key: sourceKeyFor(host), tier });
      rows.push(row);
      hosts[`${row.series_key}\u0000${row.reference_period}`] = { url: c.sourceUrl, title: c.carrierName };
    }
    ctx.state.hosts = hosts;
    const byPeriod = new Map<string, Rec[]>();
    for (const r of rows) byPeriod.set(String(r.reference_period), [...(byPeriod.get(String(r.reference_period)) ?? []), r]);
    const bands = [...byPeriod.values()].map((rs) => buildEtsProxyBand(rs)).filter((b) => b !== null);
    return { rows, warnings, counts: { ...counts, proxy_bands_built: bands.length } };
  },
  /** Apply only: register each carrier host through the registry at its class-table tier; a host the registry refuses drops its row, named. */
  async resolve(ctx, rows) {
    const hosts = (ctx.state.hosts ?? {}) as Record<string, { url: string; title: string }>;
    const kept: Rec[] = [];
    const refused: string[] = [];
    for (const r of rows) {
      const h = hosts[`${r.series_key}\u0000${r.reference_period}`];
      const res = h ? await registerCitedSource({ url: h.url, title: h.title }, { sb: ctx.sb }) : null;
      if (res && !res.refused) kept.push(r);
      else refused.push(`${String(r.series_key)}: ${res ? res.reason : "no source recorded for the row"}`);
    }
    return { rows: kept, refused };
  },
};
