import { notFound } from "next/navigation";

import { buildSeriesBoard, type SeriesRow } from "@/features/market/lib/series-board";
import type { SourceRating } from "@/features/market/lib/provenance";
import type { MarketRead } from "@/features/market/read";
import { MarketView } from "@/features/market/ui/MarketView";
import type { Resource } from "@/core/types";

// The UX smoke mounts the Market page here (tests/ux/market-smoke.mjs) from fixed data, `?state=failed` with every part's read failed. A 404 unless the env flag is set (the CI parity job and the local smoke run only); under /privacy so the
// proxy treats it as a public path. The data is generic fixture data, not a customer's.
export const dynamic = "force-dynamic";
const NOW = "2026-10-16T12:00:00.000Z";

const day = (n: number) => new Date(Date.UTC(2026, 9, 16 - n)).toISOString().slice(0, 10);
const point = (key: string, label: string, n: number, base: number, over: Partial<SeriesRow> = {}): SeriesRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${key}@${i}`, series_key: key, label, reference_period: day((n - 1 - i) * 7), as_at_date: day((n - 1 - i) * 7), value_numeric: base + i * 3, unit: "EUR/1000L", currency: "EUR", derivation: "observed", origin_class: "official", source_key: "ec_weekly_oil_bulletin", source_ref: `Weekly Oil Bulletin, week of ${day((n - 1 - i) * 7)}`, ...over }));
const SERIES: SeriesRow[] = [
  ...point("eu-oil-bulletin:automotive-diesel", "Automotive diesel (EU average, before taxes)", 60, 1400),
  ...point("eu-oil-bulletin:eurosuper-95", "Euro-Super 95 (EU average, before taxes)", 60, 1500),
  ...point("eu-oil-bulletin:heavy-fuel-oil-3-5pct", "Heavy fuel oil 3.5%S (EU average, before taxes)", 20, 600),
  ...point("eia-v2:jet-fuel-kerosene-eer-epjk-pf4-rgc-dpg", "US Gulf Coast kerosene-type jet fuel spot price", 20, 2, { unit: "USD/GAL", currency: "USD", source_key: "eia", source_ref: "EIA Open Data API v2, petroleum spot series" }),
  ...point("ecb-fx:eur-usd", "EUR/USD", 20, 1.05, { unit: "USD/EUR", currency: "USD", source_key: "ecb", source_ref: "ECB euro foreign exchange reference rates" }),
  ...point("ecb-fx:eur-gbp", "EUR/GBP", 20, 0.84, { unit: "GBP/EUR", currency: "GBP", source_key: "ecb", source_ref: "ECB euro foreign exchange reference rates" }),
  ...Array.from({ length: 5 }, (_, i) => ({ id: `sbti-${i}`, series_key: `sbti:near-term-lead-time-sector-${i}`, label: `Sector ${i + 1}`, reference_period: day(0), as_at_date: day(0), value_numeric: 18 + i * 9, unit: "months", currency: null, derivation: "calculated", origin_class: "derived", source_key: "sbti_dashboard", n_observations: 40 + i })),
];
const rating = (sourceKey: string, name: string, url: string, tier: number): [string, SourceRating] => [sourceKey, { sourceKey, name, url, licence: "Open licence", attribution: name, tier, via: "class" }];
const RATINGS = Object.fromEntries([rating("ec_weekly_oil_bulletin", "European Commission, DG ENER", "https://energy.ec.europa.eu/data-and-analysis/weekly-oil-bulletin_en", 2), rating("eia", "US Energy Information Administration", "https://www.eia.gov/opendata/", 2), rating("ecb", "European Central Bank", "https://www.ecb.europa.eu/", 2)]);
const BANDS = ["CRITICAL", "HIGH", "HIGH", "HIGH", "MODERATE", "LOW", "LOW", "LOW"] as const;
const KINDS = ["action_required", "cost_alert", "window_closing", "competitive_edge", "monitoring"];
const ROWS: Resource[] = Array.from({ length: 36 }, (_, i) => ({
  id: `m${i + 1}`, cat: "ocean", sub: "", title: i === 4 ? "A very long signal title that has to wrap inside a phone-width row without squeezing into a column of single words" : `Fixture market signal number ${i + 1}`, url: "", note: "", type: "market_signal", priority: BANDS[i % BANDS.length] as Resource["priority"],
  added: day(i), reasoning: "", tags: [], whatIsIt: "Fixture", whyMatters: "Fixture", keyData: [], modes: [["ocean"], ["road"], ["air"]][i % 3] as string[], topic: "Fuel", jurisdiction: ["GLOBAL", "EU", "US"][i % 3] as string, jurisdictionIso: [["GLOBAL", "EU", "US"][i % 3] as string],
  severity: KINDS[i % KINDS.length] as string, sourceTier: 2 + (i % 3), timeline: [],
}));
const CORRIDORS = ["CNSHA-NLRTM:ocean", "USLAX-CNSHA:ocean", "NLRTM-DEHAM:road", "GBFXT-NLRTM:ocean"].map((name, i) => {
  const [route, mode] = name.split(":") as [string, string];
  const [origin, dest] = route.split("-") as [string, string];
  return { entityId: `cl:corridor:${String(i).padStart(16, "0")}`, canonicalName: name, displayName: null, label: `${origin} to ${dest}, ${mode}`, parsed: { origin, dest, mode }, jurisdictions: [{ entityId: `j${i}`, code: origin.slice(0, 2), name: null }] };
});
const ok = <T,>(data: T) => ({ ok: true as const, data });
const bad = { ok: false as const, error: "fixture: read failed" };

function readFor(state: string): MarketRead {
  if (state === "failed") return { signals: bad, series: bad, corridors: bad, panels: { oem: bad, reroute: bad, indexation: bad } };
  return {
    signals: ok({ rows: ROWS, aggregates: { totalItems: ROWS.length, byPriority: { CRITICAL: 5, HIGH: 14, MODERATE: 5, LOW: 12 }, byStatus: {}, byJurisdiction: { GLOBAL: 12, EU: 12, US: 12 }, totalJurisdictions: 3, lastUpdatedAt: null } }),
    series: ok({ board: buildSeriesBoard(SERIES), leadTime: SERIES.filter((s) => s.series_key.startsWith("sbti")), ratings: RATINGS, lineage: null }),
    corridors: ok(CORRIDORS.filter((c) => c.parsed !== null).map((c) => ({ entityId: c.entityId, label: c.label }))),
    panels: {
      oem: ok([{ roadmap_id: "o1", tech_category: "battery_electric_hgv", commercial_stage: "series_production", target_year: 2028, density_basis: "pack", confidence_admiralty: "B2", announced_at: day(30) }]),
      reroute: ok([{ reroute_id: "r1", baseline_corridor_id: CORRIDORS[0]?.entityId as string, reroute_corridor_id: CORRIDORS[1]?.entityId as string, cause: "Fixture chokepoint closure", fuel_burn_multiplier: 1.25, effective_from: day(10), effective_to: null }]),
      indexation: ok([]),
    },
  };
}

export default async function MarketFixturesPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.UI_FIXTURES !== "1") notFound();
  const state = (await searchParams).state ?? "ok";
  const chips = state === "failed" ? null : [{ themeId: "t1", href: "/research/t1", label: "Fixture theme across the corpus", itemTitle: "Fixture theme", memberCount: 6, pages: [{ surface: "market", label: "Market" }], hasBrief: true, stale: false, links: [] }];
  return <div data-fx="market"><MarketView read={readFor(state)} nowIso={NOW} coverage={state === "failed" ? { denominator: null, error: "fixture: read failed" } : { denominator: { surface: "market_intel", label: "market", numerator: 30, denominator: 54, verifiedBriefs: 54, href: "/dashboard/coverage?data_class=market_intel" }, error: null }} chips={chips} /></div>;
}
