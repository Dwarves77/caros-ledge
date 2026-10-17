"use client";

import { useState } from "react";

import { BAND_ORDER, bandOf, type UrgencyBand } from "@/core/lists";
import {
  Absence,
  ActionCard,
  BandChip,
  BandTile,
  BandTileRow,
  BiasChips,
  BiasLegend,
  Button,
  CardFoot,
  CoverageState,
  Dialog,
  FactCard,
  FilterChip,
  FilterChipGroup,
  GradeChip,
  ImpactMeter,
  ItemGroup,
  ListRow,
  ListRowHeader,
  Masthead,
  Menu,
  MilestoneTimeline,
  RailCard,
  RowTable,
  SectionCard,
  SectionHead,
  SectionIndex,
  StatBlock,
  StateNote,
  TabRow,
  TagChip,
  Timeline,
  Toast,
  TierChip,
  WatchToggle,
  WorkspaceTagPill,
} from "@/ui";
import { FiltersRailCard, LegendRailCard, ListSurface, SortRow, ThemeStrip } from "@/ui/list-surface";
import { ScrollProvider } from "@/ui/shell/scroll-container";
import { PageFrame } from "@/ui/shell/PageFrame";

const NOW = "2026-10-15T00:00:00.000Z";
const immediate = bandOf("immediate");
const action = bandOf("action");
const LONG = "Regulation (EU) 2023/956 establishing a carbon border adjustment mechanism for imported goods in the iron and steel sector";
const DIMS = ["funding", "methodology", "stakeholder"] as const;
const TAGS = ["industry-funded", "peer-reviewed", "regulator"];
const bias = (n: number) => Array.from({ length: n }, (_, i) => ({ dimension: DIMS[i % 3] as string, tag: TAGS[i % 3] as string, confidence: i === 0 ? 0.79 : 0.9 }));
const impact = { cost: 3, compliance: 2, client: 1, operational: 2 };
const timeline = (n: number) => Array.from({ length: n }, (_, i) => ({ date: `2026-${String((i % 9) + 1).padStart(2, "0")}-15`, label: `Milestone ${i + 1} filing window opens`, ...(i < 2 ? { status: "past" as const } : {}) }));
const rowProps = (i: number, band: UrgencyBand = BAND_ORDER[i % 4] as UrgencyBand) => ({
  href: `/regulations/fx-${i}`,
  band,
  jurisdiction: ["EU", "US", "GLOBAL", "GB"][i % 4] as string,
  title: i === 1 ? LONG : `Fixture regulation ${i}`,
  meta: "regulation · air, ocean · Carbon",
  kind: "Law",
  impact: i % 3 === 0 ? null : impact,
  due: i % 2 === 0 ? { label: "Jan 1, 2027", days: "78 days" } : null,
  timeline: timeline(i % 4 === 0 ? 0 : 3),
  tier: i % 5 === 0 ? null : 2,
  biasTags: bias(i % 4),
  itemGrade: i % 7 === 0 ? ("record" as const) : ("brief" as const),
  tags: i % 6 === 0 ? [{ id: "t1", name: "Q4 audit" }] : null,
  overflow: <WatchToggle variant="icon" watched={i % 2 === 0} loaded onToggle={() => {}} />,
});

export function PartsGallery() {
  const [dialog, setDialog] = useState(false);
  const [toast, setToast] = useState(true);
  const [tab, setTab] = useState("a");
  const [sel, setSel] = useState<string | null>(null);
  const groups = [{ key: "mode", label: "Mode", options: [{ value: "air", label: "Air", count: 12 }, { value: "ocean", label: "Ocean", count: 9 }], selected: sel, onSelect: setSel }];
  return (
    <ScrollProvider>
      <div className="cl-fx" style={{ background: "var(--page)", padding: "16px 0" }}>
        <PageFrame rail={<RailCard title="Rail card" headLink={{ label: "Open", href: "/regulations" }}><StatBlock label="Open items" value="1,320" note="across four surfaces" /></RailCard>}>
          <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
            <Masthead title="Fixture surface" dek="Every part, mounted with fixtures." dateLabel="Thursday, October 15, 2026" nowIso={NOW} commandBar={<div style={{ minHeight: 44 }} />} />
            <section data-fx="tiles">
              <BandTileRow>{BAND_ORDER.map((b) => <BandTile key={b.key} band={b} count={b.key === "awareness" ? null : 1135} href="/regulations" />)}</BandTileRow>
            </section>
            <section data-fx="rows">
              <SectionCard suppressRuleForBandGrouping>
                <ListRowHeader />
                {Array.from({ length: 100 }, (_, i) => <ListRow key={i} {...rowProps(i)} />)}
              </SectionCard>
            </section>
            <section data-fx="narrow" style={{ width: 330 }} className="cl-narrow-box">
              <SectionCard><ListRow {...rowProps(2)} /></SectionCard>
            </section>
            <section data-fx="chips" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <BandChip band={immediate} withWindow /><TierChip tier={2} /><TierChip tier={9} /><TagChip>Kind</TagChip><GradeChip itemGrade="record" />
              <WorkspaceTagPill name="Audit" onRemove={() => {}} /><Absence reason="not in primary source" /><Absence reason="pending" variant="dash" />
              <FilterChipGroup label="Mode"><FilterChip active>Air</FilterChip><FilterChip>Ocean</FilterChip></FilterChipGroup>
              <ImpactMeter scores={impact} /><ImpactMeter total={8} valueVisible /><ImpactMeter scores={null} valueVisible /><ImpactMeter scores={impact} variant="full" />
              <MilestoneTimeline entries={timeline(4)} bandHex={action.hex} />
            </section>
            <section data-fx="bias"><BiasChips tags={bias(0)} /><BiasChips tags={bias(5)} variant="detail" label="Primary source" /><BiasLegend /></section>
            <section data-fx="cards">
              <SectionCard><SectionHead title="Section head" aside="Aside text" rule padding="section" index="S1" /><CardFoot left="Left" right="Right" leftHref="/regulations" /></SectionCard>
              <StateNote band={action} action={{ label: "Retry", onClick: () => {} }}>A state note with a band tint and one action.</StateNote>
              <CoverageState state="not_covered" subject="Freight rates" requestRef="x" onRequest={() => {}} />
              <CoverageState state="error" subject="Rates" onRetry={() => {}} statusHref="/coverage" />
            </section>
            {[1, 4, 9].map((n) => <SectionCard key={n} padding="16px 20px"><div data-fx={`timeline-${n}`}><Timeline entries={timeline(n)} band={immediate} nowIso={NOW} fullScheduleHref="/regulations" moreMarkersHref="/regulations" /></div></SectionCard>)}
            <section data-fx="facts">
              <ItemGroup title="Scope and applicability" band={null}>
                <FactCard model={{ kind: "SCOPE", claim: [{ text: "Applies to " }, { text: "all importers", bold: true }, { text: " of steel." }], provenance: { tier: 2, source: "Source Name With Thirty Characters!", org: "Org", href: "https://example.org/x", accessed: "Accessed 2026-10-01" } }} />
                <FactCard model={{ kind: "DEADLINE", figureLead: "1 Jan 2027", figureSubLabel: "first report", claim: [{ text: "Declarations are due." }] }} />
                <FactCard model={{ kind: "ACTION REQUIRED", claim: [{ text: "Register as an authorised declarant." }], provenance: { tier: 1, source: "EUR-Lex" } }} />
                <FactCard model={{ kind: "ANALYTICAL INFERENCE", claim: [{ text: "Costs will pass through to shippers." }] }} />
                <FactCard density="matrix" fact={{ figure: "112", headline: "", claim: "Index of road haulage cost", prose: "Quarter on quarter.", indexVsBase: 112, sourceName: "Vervo Logistics", sourceUrl: "https://example.org", sourceTier: 3, period: "2025-09", provenance: "", written: "2026-05-28" }} />
              </ItemGroup>
            </section>
            <section data-fx="action">
              <ActionCard band={immediate} kindLabel="Regulation" nowIso={NOW} tier={2} biasTags={bias(3)} meta="Updated Oct 2026" tags={["Audit"]} onExport={() => {}} onShare={() => {}} watch={<WatchToggle watched={false} teamAvailable loaded onToggle={() => {}} />} onTag={() => {}} where={{ value: "EU ports" }} whoPays={{ value: null }} yourLanes={{ value: "Rotterdam to Hamburg and onward by road across the whole of the central corridor." }} timeline={timeline(4)} />
            </section>
            <section data-fx="controls" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <Button variant="primary" size="sm">Small primary</Button><Button variant="danger">Danger</Button><Button variant="ghost" size="lg">Ghost</Button>
              <TabRow ariaLabel="Tabs" semantics="tablist" tabs={[{ key: "a", label: "One", active: tab === "a", onClick: () => setTab("a") }, { key: "b", label: "Two", active: tab === "b", onClick: () => setTab("b") }]} />
              <Menu label="Row actions" items={[{ key: "x", label: "Do it", onSelect: () => {} }]} />
              <button type="button" id="fx-open-dialog" className="cl-btn cl-btn--secondary cl-btn--md" onClick={() => setDialog(true)}>Open dialog</button>
              <WatchToggle watched teamWatched teamAvailable loaded onToggle={() => {}} />
              <WatchToggle variant="row" watched={false} loaded failed onToggle={() => {}} />
            </section>
            <section data-fx="tables"><RowTable columns={[{ label: "Name", width: "1fr" }, { label: "Role", width: "90px" }]} rows={[{ key: "1", cells: ["Alex", "Owner"] }, { key: "2", cells: ["Sam", "Member"], onActivate: () => {}, activateLabel: "Open Sam" }]} /></section>
            <section data-fx="index"><SectionIndex sections={[{ id: "summary", shortName: "Summary", ord: 1 }, { id: "obligations", shortName: "Obligations", ord: 2 }]} depth="summary" onDepthChange={() => {}} /></section>
            <section data-fx="themes"><ThemeStrip chips={[{ themeId: "t", href: "/research/x", label: "A theme label that is quite long indeed", itemTitle: "Item", memberCount: 4, pages: [{ surface: "market", label: "Market" }], hasBrief: true, stale: true, links: [{ title: "Member one", href: "/market/a" }] }]} /></section>
          </div>
        </PageFrame>
        <div data-fx="surface">
          <ListSurface
            title="List surface" dateLabel="Thursday, October 15, 2026" nowIso={NOW} bandCounts={{ immediate: 15, action: 13, monitor: 1135, awareness: 7 }} selectedBand={null} onSelectBand={() => {}}
            facetGroups={groups} sortRow={<SortRow countLabel="40 items" controlLabel="Sort" options={[{ key: "a", label: "Next date" }, { key: "b", label: "Newest" }]} active="a" onSelect={() => {}} />}
            rowsByBand={BAND_ORDER.map((b, k) => ({ band: b, total: 12, rows: Array.from({ length: 3 }, (_, i) => ({ key: `${k}-${i}`, ...rowProps(k * 3 + i, b) })) }))} perBandCap={3} onExpandBand={() => {}}
            remainderFailed onRetryRemainder={() => {}} rail={<LegendRailCard />}
          />
        </div>
        <div style={{ display: "none" }}><FiltersRailCard groups={groups} /></div>
        <Toast message="Link copied" visible={toast} onDismiss={() => setToast(false)} duration={600000} />
        <Dialog open={dialog} onClose={() => setDialog(false)} title="Fixture dialog"><button type="button" className="cl-btn cl-btn--secondary cl-btn--md" onClick={() => setDialog(false)}>Inside</button></Dialog>
      </div>
    </ScrollProvider>
  );
}
