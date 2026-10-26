"use client";

// New in P2-12: the Research and Operations screens mounted with fixtures for the UX smoke (`?screen=parts|research|operations`), no old counterpart. The lists are the real components over small in-memory data.
import { useState } from "react";

import type { Resource } from "@/core/types";
import type { OperationsFact, CoverageRow } from "@/features/operations/model/region-grid";
import { buildStatements } from "@/features/operations/model/statements";
import type { OperationsPageData } from "@/features/operations/read/operations-reads";
import { LabourChain } from "@/features/operations/ui/LabourChain";
import { OperationsList } from "@/features/operations/ui/OperationsList";
import { RegionMatrix } from "@/features/operations/ui/RegionMatrix";
import { AuxiliaryEnergyPanel, DerivedFigures, GridQueuePanel } from "@/features/operations/ui/Spec09Panels";
import { StatementsBlock } from "@/features/operations/ui/StatementsBlock";
import type { AssessmentView } from "@/features/research/model/assessment-view";
import type { ResearchPageData } from "@/features/research/read/research-reads";
import { AssessmentCard, AssessmentHistory, DissentPanel, SignpostList } from "@/features/research/ui/AssessmentRail";
import { CredibilityChips } from "@/features/research/ui/CredibilityChips";
import { ResearchList } from "@/features/research/ui/ResearchList";
import { ThemeFacetRow } from "@/features/research/ui/ThemeFacetRow";
import { ThemeBriefCard } from "@/features/research/ui/ThemeBriefCard";
import { ScrollProvider } from "@/ui/shell/scroll-container";

const NOW = "2026-10-15T00:00:00.000Z";
const PRIORITIES = ["CRITICAL", "HIGH", "HIGH", "MODERATE", "MODERATE", "MODERATE", "LOW", "LOW", "LOW", "LOW"] as const;
const TITLES = ["Zero-emission cargo bays for urban delivery", "Hydrogen trucks: a demonstration plant at scale", "A study of SAF feedstock supply and price", "Scope 3 accounting under ISO 14083", "EU ETS allowance prices and CBAM", "CSRD and ISSB S2 reporting convergence", "Reusable packaging under PPWR", "Cold-chain handling of fine art", "Port congestion outlook", "Electric heavy goods vehicle trials"];
const R = (i: number, over: Partial<Resource> = {}): Resource => ({ id: `r${i}`, cat: "ocean", sub: "", title: TITLES[i % TITLES.length] as string, url: "", note: "", type: "research_finding", priority: PRIORITIES[i % PRIORITIES.length] as Resource["priority"], added: "2026-10-10", reasoning: "", tags: [], whatIsIt: "", whyMatters: "", keyData: [], modes: i % 2 ? ["air"] : ["ocean"], jurisdiction: ["EU", "US", "GB", "GLOBAL"][i % 4] as string, jurisdictionIso: [["EU", "US", "GB", "GLOBAL"][i % 4] as string], ...over });
const ASSESS: AssessmentView = { id: "a1", itemId: "r0", supersedes: "a0", technical: { low: 6, high: 7, label: "TRL 6-7", method: "read from the item's own recorded text against the IEA-extended TRL 1-11 ladder" }, commercial: { low: 3, high: 3, label: "CRI 3", method: null }, horizon: { kind: "obligation", band: "NEAR", rule: "R1", confidence: "high", triggerNote: "binds on you at 2028-03-01 because FuelEU phase-in begins" }, refusalReason: null, evidenceScore: "robust", authority: { highAuthorityIndependent: 2, medium: 1, vendorFlagged: 1 }, anchored: true, lifecycleState: "strengthening", computedAt: "2026-10-01T00:00:00Z", forwardOutlook: { stance: "act_today", horizon: "1-2y" } };
const RESEARCH: ResearchPageData = {
  rows: Array.from({ length: 10 }, (_, i) => R(i, i === 0 ? { theme: "last_mile_electrification", severity: "action_required" } : {})),
  rowsFailed: false, aggregates: null, coverage: [{ transportMode: "ocean", jurisdictionIso: "EU", sourceCount: 12 }, { transportMode: "air", jurisdictionIso: "US", sourceCount: 7 }],
};
const DENOMINATOR = { denominator: { surface: "research", label: "research", numerator: 4, denominator: 9, verifiedBriefs: 3, href: "/dashboard/coverage?data_class=research" }, error: null, surfacePath: "/research" };
const CHIPS = [{ themeId: "t1", href: "/research/r0", label: "Maritime decarbonisation: the IMO net-zero arc", itemTitle: "Item", memberCount: 4, pages: [{ surface: "research", label: "Research" }], hasBrief: true, stale: false, links: [{ title: "IMO Net-Zero Framework", href: "/regulations/x" }, { title: "Joint Office of Energy and Transportation: Industry Alignment for EV Charging and Refueling Infrastructure Deployment Across Regions", href: "/research/y" }] }];

const REGIONS = ["EU", "US", "UK", "ASIA", "UAE", "BR"].map((code, i) => ({ id: `id-${code}`, code, label: ["European Union", "United States", "United Kingdom", "Asia", "UAE", "Brazil"][i] as string, displayOrder: i + 1, isoCodes: [code] }));
const F = (regionCode: string, dimension: string, factLabel: string, over: Partial<OperationsFact> = {}): OperationsFact => ({
  regionCode, dimension, factLabel, value: "", status: null, trend: null, sourceName: "Eurostat", sourceUrl: "https://ec.europa.eu/eurostat", sourceTier: 1, sourceNote: null, lastUpdated: "2026-01-01", freshness: "current", valueNumeric: 40.4, unit: "EUR/hour", currency: "EUR",
  derivation: "observed", originClass: "official", sourceKey: "eurostat", sourceRef: "lc", nObservations: null, methodVersion: "v1", asAtDate: "2025-01-01", referencePeriod: "2025", ...over,
});
const LABOUR = ["Base wage hourly median", "Employer social contributions", "Leave and absence", "Turnover and recruitment", "Shift premium"].map((l, i) => F("EU", "labor_markets", `EU - ${l}`, { valueNumeric: [20, 5, 2, 1, 2][i] as number }));
const FACTS: OperationsFact[] = [
  ...LABOUR, F("EU", "labor_markets", "EU - Productive hours per year", { valueNumeric: 1600, unit: "hours", currency: null }),
  F("US", "labor_markets", "US - Base wage annual median", { valueNumeric: 60000, unit: "USD/year", currency: "USD", sourceName: "BLS" }), F("US", "labor_markets", "US - Base wage hourly median", { valueNumeric: 28.8, unit: "USD/hour", currency: "USD", sourceName: "BLS" }),
  F("UK", "operational_cost", "UK - Electricity price", { valueNumeric: 0.31, unit: "GBP/kWh", currency: "GBP", sourceRef: "nrg_pc_205:geo=EU27_2020,siec=E7000,currency=EUR,unit=KWH,consom=4161903" }), F("EU", "operational_cost", "EU - Electricity price", { valueNumeric: 0.2, unit: "EUR/kWh", sourceRef: "nrg_pc_205:geo=EU27_2020,siec=E7000,currency=EUR,unit=KWH,consom=4161903" }), F("EU", "infrastructure", "EU - Charging density", { valueNumeric: null, unit: null, value: "Constrained", sourceName: null, sourceUrl: null, sourceTier: null, sourceNote: "Operator note · https://example.org/x · 2026-03-17", derivation: null, originClass: null }),
];
const COVERAGE: CoverageRow[] = [{ regionCode: "EU", dimension: "labor_markets", state: "populated", factCount: 6, notes: null }];
const OPERATIONS: OperationsPageData = {
  rows: REGIONS.map((r, i) => R(i, { id: `o${i}`, title: `${r.label} Regional Operations Profile`, type: "regional_data", jurisdiction: r.code, jurisdictionIso: [r.code] })), rowsFailed: false, aggregates: null,
  roster: REGIONS, coverage: COVERAGE, facts: FACTS, stateCosts: [], linkedRegulations: { EU: 12, US: 4 }, derived: [{ valueId: "d1", title: "One-week movement · EUR/USD", value: 0.05, unit: "USD/EUR", currency: "USD", originClass: "Derived", lifecycle: "verified", confidence: 0.9, computedAt: "2026-10-15T12:00:00Z", previous: 0.03, inputs: [{ label: "EUR/USD", period: "2026-10-15", sourceName: "European Central Bank", tier: 1 }], tier: 1 }],
};

export function SurfaceFixtures({ screen: requested }: { screen: string }) {
  // The list writes its own query string (replace), which drops `?screen=`: the screen is fixed at the first render.
  const [screen] = useState(requested);
  const [theme, setTheme] = useState<string | null>(null);
  const wide = (n: number) => REGIONS.slice(0, n).map((r) => ({ key: r.code, label: r.label }));
  const dims = [{ db: "labor_markets", name: "Labor markets", num: 3 }, { db: "operational_cost", name: "Operational cost", num: 6 }, { db: "infrastructure", name: "Infrastructure capacity", num: 5 }] as never[];
  const statements = buildStatements({ facts: FACTS, regions: REGIONS.map((r) => ({ code: r.code, label: r.label, displayOrder: r.displayOrder })), dimensions: ["labor_markets", "operational_cost"] });
  return (
    <ScrollProvider>
      <div style={{ background: "var(--page)", padding: "16px 0" }}>
        {screen === "research" && <div data-fx="research"><ResearchList data={RESEARCH} nowIso={NOW} chips={CHIPS} denominator={DENOMINATOR} /></div>}
        {screen === "operations" && <div data-fx="operations"><OperationsList data={OPERATIONS} nowIso={NOW} chips={CHIPS} denominator={{ ...DENOMINATOR, surfacePath: "/operations" }} /></div>}
        {screen === "parts" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "0 16px", maxWidth: 1032 }}>
            <section data-fx="research-parts" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <ThemeFacetRow themes={[{ key: "fuels_saf", count: 3, newCount: 1 }, { key: "last_mile_electrification", count: 2, newCount: 0 }]} selected={theme} onSelect={setTheme} unclassifiedCount={2} />
              <CredibilityChips assessment={ASSESS} biasTags={[{ dimension: "funding", tag: "industry-funded", confidence: 0.8 }]} />
              <CredibilityChips />
              <AssessmentCard assessment={ASSESS} failed={false} />
              <AssessmentCard assessment={null} failed={false} />
              <DissentPanel assessment={ASSESS} />
              <SignpostList signposts={[{ entityId: "s1", watches: "w", watchesLabel: "FuelEU Maritime", direction: "confirms", predicate: { kind: "movement_by_date", by: "2027-01-01", metric: null, gte: null, relation: null, n: null }, firedAt: null }]} />
              <AssessmentHistory bundle={{ history: [{ id: "a1", supersedes: "a0", computedAt: "2026-10-01T00:00:00Z", isCurrent: true, lifecycleState: null, technicalLabel: "TRL 6-7", commercialLabel: null, horizonBand: "NEAR", anchored: true }], historyComplete: false }} />
              <ThemeBriefCard brief={{ title: "Maritime decarbonisation", memberCount: 4, stale: true }} />
            </section>
            <section data-fx="matrix-six" style={{ width: "min(1024px, 100%)" }} data-guard-strip="true">
              <RegionMatrix regions={wide(6)} dimensions={dims} facts={FACTS} coverageRows={COVERAGE} crossRefCounts={{ EU: 12 }} profileHrefByRegion={{ EU: "/operations/o0" }} />
            </section>
            <section data-fx="matrix-five" style={{ width: "min(1024px, 100%)" }} data-guard-strip="true">
              <RegionMatrix regions={wide(5)} dimensions={dims} facts={FACTS} crossRefCounts={null} />
            </section>
            <section data-fx="operations-parts" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <StatementsBlock statements={statements.statements} droppedVerdicts={1} dimensionNames={{ labor_markets: "D3 Labor markets", operational_cost: "D6 Operational cost" }} />
              <LabourChain facts={LABOUR.slice(0, 3)} regionLabel="European Union" />
              <DerivedFigures figures={OPERATIONS.derived} />
              <DerivedFigures figures={null} />
              <AuxiliaryEnergyPanel rows={[{ profile_id: "p1", load_type: "cold_room", kw_draw: 12, duty_cycle: 0.6, hours_typical: 48, setpoint_c: 16, setpoint_rh_pct: 50, grid_intensity_source: null }]} intensity={{ gco2ePerKwh: 120, sourceName: "NESO", period: "2026-10" }} retryHref="/operations" />
              <GridQueuePanel rows={[{ queue_id: "q1", dso_name: "UK Power Networks", capacity_band_mw: "10-50", queue_months_p50: 18, queue_months_p90: 30, as_of: "2026-09-01", substation_name: null, demand_firm_mw: null, demand_available_mw: null, demand_constraint: null, demand_constraint_limiting_factor: null }]} retryHref="/operations" />
            </section>
          </div>
        )}
      </div>
    </ScrollProvider>
  );
}
