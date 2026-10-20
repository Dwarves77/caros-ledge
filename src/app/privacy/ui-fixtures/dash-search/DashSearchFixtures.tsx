"use client";

import { useEffect } from "react";

import { AskAssistant } from "@/features/assistant/ui/AskAssistant";
import { DashboardBrief } from "@/features/dashboard/ui/DashboardBrief";
import { DashboardMasthead } from "@/features/dashboard/ui/DashboardMasthead";
import type { BriefRow } from "@/features/dashboard/rows";
import { PortfolioDetailView } from "@/features/portfolio/ui/PortfolioDetailView";
import { PortfolioIndexView } from "@/features/portfolio/ui/PortfolioIndexView";
import { SearchResultsView } from "@/features/search/ui/SearchResultsView";
import type { SearchRow } from "@/features/search/types";
import type { NoticesRead } from "@/features/watchlist/read/notices";
import type { WatchlistItem, WatchlistRead } from "@/features/watchlist/read/watchlist";
import { WatchlistSurface } from "@/features/watchlist/ui/WatchlistSurface";
import type { PortfolioDetailView as Detail, PortfolioSummary } from "@/features/workspace/portfolio/types";
import { useBootstrapStore } from "@/ui/shell/use-bootstrap";

const NOW = "2026-10-15T12:00:00.000Z";
const DATE = "Thursday, October 15, 2026";
const IMPACT = { cost: 3, compliance: 3, client: 2, operational: 2 };
const row = (id: string, over: Partial<BriefRow> & { title: string }): BriefRow => ({ id, href: `/regulations/${id}`, priority: "HIGH", jurisdiction: "EU", meta: "regulation · ocean · emissions", impact: IMPACT, due: { label: "Nov 1, 2026", days: "17 days" }, timeline: [{ date: "2026-08-01", label: "Adopted", status: "past" }, { date: "2026-11-01", label: "Applies", status: "future" }], tier: 1, watchType: "reg", ...over });
const DUE: BriefRow[] = [
  row("d1", { title: "FuelEU Maritime: greenhouse gas intensity limits for ships calling at Union ports", priority: "CRITICAL", dueDays: 17 }),
  row("d2", { title: "ReFuelEU Aviation: sustainable aviation fuel supply mandate", priority: "HIGH", jurisdiction: "EU", due: { label: "Dec 31, 2026", days: "77 days" }, dueDays: 77 }),
  row("d3", { title: "California SB 253 climate corporate data accountability", jurisdiction: "US", priority: "MODERATE", due: { label: "Jan 5, 2027", days: "82 days" }, dueDays: 82, tier: 2 }),
];
const CHANGED: BriefRow[] = [
  row("c1", { title: "Euro 7 Standard", priority: "HIGH", isNew: true, changeDate: "2026-10-14", due: null, impact: null, tier: null, meta: "regulation · road · transport" }),
  row("c2", { title: "EU ETS for Shipping: surrender obligations and phase-in", priority: "CRITICAL", isUpdated: true, updatedField: "full_brief", changeDate: "2026-10-13" }),
  row("c3", { title: "A market signal with a very long title that has to wrap across more than one line on a phone without breaking the row", href: "/market/c3", watchType: "signal", priority: "MODERATE", isNew: true, changeDate: "2026-10-12", due: null, impact: null }),
];
const COUNTS = { regulations: { totalItems: 1320, byPriority: { CRITICAL: 15, HIGH: 14, MODERATE: 1135, LOW: 7 }, byStatus: {}, byJurisdiction: {}, totalJurisdictions: 62, lastUpdatedAt: null }, surfaces: { regulations: 1320, marketIntel: 54, research: 39, operations: 26 }, aggregates: { totalItems: 1439, byPriority: { CRITICAL: 15, HIGH: 14, MODERATE: 1135, LOW: 7 }, byStatus: {}, byJurisdiction: {}, totalJurisdictions: 62, lastUpdatedAt: null } };
const WATCH_ITEMS: WatchlistItem[] = [
  { id: "d1", type: "reg", scope: "personal", title: "FuelEU Maritime: greenhouse gas intensity limits for ships calling at Union ports", watchedAt: "2026-10-12T09:00:00Z", note: null, addedBy: null, dueDays: 17, fields: { id: "d1", href: "/regulations/d1", priority: "CRITICAL", jurisdiction: "EU", title: "FuelEU Maritime", meta: "regulation", impact: IMPACT, due: { label: "Nov 1, 2026", days: "17 days" }, timeline: null, tier: 1, watchType: "reg" } },
  { id: "s1", type: "market_series", scope: "team", title: "EUR/USD reference rate", watchedAt: "2026-10-10T09:00:00Z", note: "Quote basis for the Q4 tender", addedBy: "Pat Lee", dueDays: null, fields: null },
  { id: "src1", type: "source", scope: "team", title: "Official Journal of the European Union", watchedAt: "2026-10-09T09:00:00Z", note: null, addedBy: "Sam Ito", dueDays: null, fields: null },
  { id: "o9", type: "operations", scope: "personal", title: "Item no longer available", watchedAt: "2026-10-01T09:00:00Z", note: null, addedBy: null, dueDays: null, fields: null },
];
const WATCH: WatchlistRead = { items: WATCH_ITEMS, capped: false, ratingsFailed: false, timelinesFailed: false };
const NOTICES: NoticesRead = { since: "2026-09-15T12:00:00.000Z", notices: [{ entityId: "e1", entityLabel: "EU ETS allowance price", methodId: "m", oldMethodVersion: "1", oldValue: 61.2, oldValueLow: null, oldValueHigh: null, newValueId: "n1", newMethodVersion: "1", newValue: 64.8, newValueLow: null, newValueHigh: null, unit: "EUR/t", currency: null, oldValueId: "o1", supersededAt: "2026-10-10T08:00:00Z", triggeringEvent: null }] };
const SEARCH: SearchRow[] = ["EU Emissions Trading System (ETS) Extension to Maritime Transport", "Euro 7 Standard", "Regulation (EU) 2025/2083 of the European Parliament and of the Council of 8 October 2025 amending Regulation (EU) 2023/956 as regards simplifying and strengthening the carbon border adjustment mechanism (Text with EEA relevance)", "CountEmissions EU"].map((title, i) => ({ id: `s${i}`, title, item_type: "regulation", domain: 1, priority: i === 0 ? "CRITICAL" : "HIGH", jurisdictions: ["EU"], transport_modes: ["ocean"], topic: "emissions", tier: i === 3 ? null : 1 }));
const PORTFOLIOS: PortfolioSummary[] = [{ id: "p1", name: "Asia to Europe lanes", createdAt: "2026-10-01T00:00:00Z", memberCount: 7 }, { id: "p2", name: "A portfolio with a very long name that must wrap rather than overflow the table on a narrow phone screen", createdAt: "2026-09-12T00:00:00Z", memberCount: 1 }];
const heldRow = (uuid: string, ui: string, title: string, surface: "regulations" | "market", extra = {}) => ({ uiId: ui, itemUuid: uuid, title, priority: "HIGH", surface, dueDays: 17, originClass: "official", fields: { id: ui, href: `/${surface}/${ui}`, priority: "HIGH", jurisdiction: "EU", title, meta: "regulation · ocean", impact: IMPACT, due: { label: "Nov 1, 2026", days: "17 days" }, timeline: null, tier: 1, watchType: "reg" }, ...extra });
const DETAIL: Detail = {
  portfolio: { id: "p1", name: "Asia to Europe lanes", createdAt: "2026-10-01T00:00:00Z" },
  rollup: { total: 5, items: { members: 4, held: 3, notHeld: ["gone-1"] }, entities: { corridors: 1, other: 0 }, bySurface: { regulations: 2, market: 1, research: 0, operations: 0 }, otherSurface: 0, byPriority: { CRITICAL: 1, HIGH: 2, MODERATE: 0, LOW: 0, unscored: 0 }, nextDue: { itemId: "u1", days: 17 }, origin: { weakest: "official", classified: 3, unclassified: 0 } },
  groups: [{ surface: "regulations", rows: [heldRow("u1", "d1", "FuelEU Maritime", "regulations"), heldRow("u2", "d2", "ReFuelEU Aviation", "regulations")] }, { surface: "market", rows: [heldRow("u3", "m1", "EUR/USD reference rate", "market")] }],
  entityRows: [{ entityId: "cl:corridor:cnsha-nlrtm", kind: "corridor", entityKind: "corridor", label: "Shanghai (CN) → Rotterdam (NL), ocean" }],
  entitiesUnread: 0,
};
const ASK_EVENT = "open-ask-assistant";

/** One dashboard, watchlist, search, portfolio or Assistant screen per `?screen=`, with static props; the UX smoke (tests/ux/dash-search-smoke.mjs) mocks the backend it calls. */
export function DashSearchFixtures({ screen, titles }: { screen: string; titles: string[] }) {
  useEffect(() => {
    useBootstrapStore.setState({ data: { personalState: [], members: null, adminAttention: null, overrides: [], navCounts: null, assistantEnabled: true, degraded: [] }, status: "ready" });
  }, []);
  const parityRows: SearchRow[] = titles.map((title, i) => ({ id: `p${i}`, title, item_type: "regulation", domain: 1, priority: "HIGH", jurisdictions: ["EU"], transport_modes: ["ocean"], topic: "emissions", tier: null }));
  const brief = (over: Partial<Parameters<typeof DashboardBrief>[0]> = {}) => <DashboardBrief dueRows={DUE} dueWindow="By next binding date · week of Oct 15, reaching to Jan 5, 2027" changedRows={CHANGED} totalChanges={49} windowDays={90} auditDate="2026-10-14" rowsFailed={false} ratingsFailed={false} degraded={[]} counts={COUNTS} watchlist={WATCH_ITEMS} themes={[{ themeId: "t1", href: "/research", label: "Carbon pricing reaches shipping", itemTitle: "Carbon pricing reaches shipping", memberCount: 4, pages: [{ surface: "regulations", label: "Regulations" }, { surface: "research", label: "Research" }], hasBrief: false, stale: false, links: [] }]} {...over} />;
  return (
    <main data-fx="dash-search">
      {screen === "assistant" ? (
        <>
          <button type="button" id="fx-ask" className="cl-btn cl-btn--secondary cl-btn--md" onClick={() => window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: { question: "Regulation 2023/9999 reporting", anchor: { top: 120, left: 32, width: 640 } } }))}>
            Ask the Assistant
          </button>
          <AskAssistant />
        </>
      ) : null}
      {screen === "dashboard" || screen === "dashboard-failed" || screen === "dashboard-empty" ? (
        <>
          <div className="cl-list-surface-masthead">
            <DashboardMasthead firstName="Pat" orgName="Dietl / Rockit" sectors={["fine-art", "live-events"]} itemCount={screen === "dashboard-failed" ? null : 1439} jurisdictionCount={screen === "dashboard-failed" ? null : 62} dateLabel={DATE} nowIso={NOW} />
          </div>
          {screen === "dashboard" ? brief() : null}
          {screen === "dashboard-empty" ? brief({ dueRows: [], changedRows: [], totalChanges: 0, auditDate: "", watchlist: [], themes: [] }) : null}
          {screen === "dashboard-failed" ? brief({ dueRows: [], changedRows: [], rowsFailed: true, counts: null, watchlist: null, themes: [], auditDate: "" }) : null}
        </>
      ) : null}
      {screen === "watchlist" ? <WatchlistSurface watch={WATCH} notices={NOTICES} limit={250} dateLabel={DATE} nowIso={NOW} /> : null}
      {screen === "watchlist-empty" ? <WatchlistSurface watch={{ items: [], capped: false, ratingsFailed: false, timelinesFailed: false }} notices={{ notices: [], since: "2026-09-15T12:00:00.000Z" }} limit={250} dateLabel={DATE} nowIso={NOW} /> : null}
      {screen === "watchlist-failed" ? <WatchlistSurface watch={null} notices={null} limit={250} dateLabel={DATE} nowIso={NOW} /> : null}
      {screen === "search" ? <SearchResultsView q="emissions" outcome={{ ok: true, rows: SEARCH }} maxResults={20} dateLabel={DATE} nowIso={NOW} /> : null}
      {screen === "search-parity" ? <SearchResultsView q="emissions" outcome={{ ok: true, rows: parityRows }} maxResults={20} dateLabel={DATE} nowIso={NOW} /> : null}
      {screen === "search-failed" ? <SearchResultsView q="emissions" outcome={{ ok: false, reason: "unavailable" }} maxResults={20} dateLabel={DATE} nowIso={NOW} /> : null}
      {screen === "search-empty" ? <SearchResultsView q="zzzz" outcome={{ ok: true, rows: [] }} maxResults={20} dateLabel={DATE} nowIso={NOW} /> : null}
      {screen === "portfolio-index" ? <PortfolioIndexView portfolios={PORTFOLIOS} unavailable={false} readOnly={false} dateLabel={DATE} nowIso={NOW} /> : null}
      {screen === "portfolio-unavailable" ? <PortfolioIndexView portfolios={[]} unavailable readOnly dateLabel={DATE} nowIso={NOW} /> : null}
      {screen === "portfolio-detail" ? <PortfolioDetailView view={DETAIL} readOnly={false} dateLabel={DATE} nowIso={NOW} /> : null}
    </main>
  );
}
