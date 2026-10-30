"use client";

// Ported from old_repo/src/components/ui/SectionIndex.tsx (lines 28-136)
// Ported from old_repo/src/components/ui/SectionIndexLink.tsx (lines 12-39)
// Ported from old_repo/src/components/ui/section-index-styles.ts (lines 1-54)
// Ported from old_repo/src/lib/detail/use-section-scroll-spy.ts (lines 1-40)
import { useEffect, useState } from "react";

export interface SectionIndexEntry { id: string; shortName: string; ord?: number }
export type SectionIndexDepth = "summary" | "full";
type SectionTheme = "summary" | "obligations" | "operations" | "risk" | "connected" | "sources";

const THEME_BY_ID: Readonly<Record<string, SectionTheme>> = {
  summary: "summary", purpose: "summary", "what-it-is": "summary", notes: "summary", assignments: "summary",
  obligations: "obligations", "obligation-register": "obligations", "pending-events": "obligations", thresholds: "obligations",
  requirements: "operations", registration: "operations", operations: "operations", compliance: "operations", findings: "operations", "auxiliary-energy": "operations", "grid-queue": "operations", "product-status": "operations", exemptions: "operations",
  penalties: "risk", impact: "risk", "across-pages": "connected", inferences: "connected", related: "connected", alternatives: "connected", sources: "sources", guidance: "sources",
};

export const sectionThemeOf = (id: string): SectionTheme => THEME_BY_ID[id] ?? "summary";

export const SECTION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  summary: "Executive overview of what this item covers, key takeaways, and how its timeline and scope affect freight operations.",
  obligations: "Actionable compliance duties grouped by who is bound and what operational steps must be taken, backed by verbatim statutory citations.",
  requirements: "Technical thresholds, reporting standards, and substantive mandates required for statutory compliance.",
  registration: "Mandatory registration, authorization, and reporting procedures with competent regulatory authorities.",
  operations: "Day-to-day operational requirements, transport documentation, and shipment handling rules.",
  compliance: "End-to-end compliance chain responsibilities across shippers, carriers, forwarders, and consignees.",
  purpose: "The statutory objective, legal basis, and jurisdictional scope of this regulatory instrument.",
  "what-it-is": "Background context on why this regulation was enacted and which transport activities it governs.",
  guidance: "Official implementing guidance, agency interpretations, and administrative rulings.",
  "pending-events": "Upcoming delegated acts, review clauses, and pending regulatory milestones.",
  thresholds: "Applicability thresholds by tonnage, fleet size, revenue, or emissions volume.",
  "product-status": "Product-, fuel-, and commodity-specific compliance rules and classifications.",
  exemptions: "Statutory exemptions, derogations, de minimis thresholds, and transit edge cases.",
  alternatives: "Adjacent research, alternative compliance pathways, and technology substitutions.",
  penalties: "Statutory enforcement mechanisms, financial penalty schedules, and administrative sanctions for non-compliance.",
  findings: "Detailed analytical breakdown of operational drivers, cost baselines, mode impacts, and strategic talking points.",
  "auxiliary-energy": "Stationary auxiliary load energy draw (kWh) and grid-intensity emissions (gCO2e) across monitored regional assets.",
  "grid-queue": "Substation connection-queue lead times (p50/p90 months) evaluated against a 24-month infrastructure planning horizon.",
  sources: "Primary statutory, regulatory, and institutional sources backing this brief, rated by provenance tier and bias profile.",
  related: "Directly related intelligence items sharing the same regulatory instrument, regional scope, or market signal band.",
  "across-pages": "How this item connects across the Caro’s Ledge repository — related regulations, market signals, research findings, and operations profiles.",
  inferences: "Cross-corpus analytical inferences derived where multiple verified items compound across shared corridors or rules.",
  notes: "Private workspace notes shared only with members of your organisation.",
  assignments: "Workspace task assignments and ownership tracking for your team.",
};

/** The index of the section nearest the top of the viewport (the first one when none intersects). */
function useSectionScrollSpy(ids: string[]): number {
  const [active, setActive] = useState(0);
  const key = ids.join("|");
  useEffect(() => {
    const els = key.split("|").map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el != null);
    if (els.length === 0) return;
    const observer = new IntersectionObserver((entries) => {
      const first = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      const idx = first ? els.indexOf(first.target as HTMLElement) : -1;
      if (idx >= 0) setActive(idx);
    }, { rootMargin: "-64px 0px -70% 0px", threshold: 0 });
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [key]);
  return active;
}

/** The Summary | Full brief switch, inside the index bar so it sits at the same position on every detail page. */
function SummaryDepthSwitch({ depth, onChange }: { depth: SectionIndexDepth; onChange: (d: SectionIndexDepth) => void }) {
  const opt = (value: SectionIndexDepth, label: string) => <button key={value} type="button" aria-pressed={depth === value} onClick={() => onChange(value)} className="cl-depth-opt">{label}</button>;
  return <div role="group" aria-label="Summary depth" className="cl-depth-switch">{opt("summary", "Summary")}{opt("full", "Full brief")}</div>;
}

/** The detail section index bar: scroll-spy tabs that never truncate, the depth switch inside the same bordered card. Clicking a full-brief section while in summary depth expands to full brief and scrolls to it. */
export function SectionIndex({ sections, depth, onDepthChange }: { sections: SectionIndexEntry[]; depth?: SectionIndexDepth; onDepthChange?: (d: SectionIndexDepth) => void }) {
  const active = useSectionScrollSpy(sections.map((s) => s.id));
  if (sections.length === 0) return null;
  const onTabClick = (id: string) => {
    if (depth === "summary" && onDepthChange && typeof document !== "undefined" && !document.getElementById(id)) {
      onDepthChange("full");
      setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
    }
  };
  return (
    <nav aria-label="Section index" data-part="section-index" className="cl-section-index">
      <div data-guard-strip className="cl-section-index-strip">
        <div data-guard-strip className="cl-section-index-tabs">
          {sections.map((s, i) => (
            <a key={s.id} href={`#${s.id}`} onClick={() => onTabClick(s.id)} data-sec-theme={sectionThemeOf(s.id)} className="cl-section-index-link" aria-current={i === active ? "true" : undefined}>
              S{s.ord ?? i + 1} {s.shortName}
            </a>
          ))}
        </div>
        {depth && onDepthChange && <div className="cl-section-index-depth"><SummaryDepthSwitch depth={depth} onChange={onDepthChange} /></div>}
      </div>
    </nav>
  );
}
