"use client";

// Ported from old_repo/src/components/operations/OperationsDetailSurface.tsx (lines 49-461)
// The Operations regional profile on the shared detail architecture: the masthead with the action card and the connections, the section index (fixed ordinals: 01 Summary, 02 Findings, 03 Auxiliary energy load,
// 04 Grid queue, 05 Sources; the spec-09 panels carry index entries, which the old index left out), the stored profile sections with the S3/S4 comparison gate and its omit note rendered in the section's place, the
// workspace's loads and the grid queue gate, the figures the flywheel recomputed, Sources with each registry rating, and the rail (At a glance, impact, relevance, related in region, legend, list position).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import type { RecommendedAction } from "@/core/brief";
import { stripSourcesSection } from "@/core/brief";
import type { SectionRow } from "@/core/detail/item-read";
import { CONNECTED_SECTION_ID, crossPageOrd, INFERENCES_SECTION_ID } from "@/core/detail/section-index";
import { sourceEntriesOf } from "@/core/detail/sources-parse";
import type { ConnectionRow } from "@/core/flywheel/view-model";
import { jurisLabelOf } from "@/core/jurisdictions";
import { bandFromPriority } from "@/core/lists";
import { formatDate, pluralize } from "@/core/shared";
import type { Resource } from "@/core/types";
import { regionGroupForLabel } from "@/core/workspace";
import { Absence, ActionCard, ClaimTierProvider, DetailSubSection, downloadMarkdownBrief, GfmSection, GradeChip, SectionCard, SectionIndex, StateNote, TagChip, type ClaimTierMap } from "@/ui";
import { AtAGlanceCard, commonActionCardProps, CrossPageSection, crossPagePresence, DetailLayout, DetailMasthead, DetailPageWrapper, DetailRail, DetailSection, FactBlocks, ImpactRailCard, InThisListStat, ItemConnections, RelevanceRailCard, SourcesGrid, topRecommendedAction, type CrossPageData } from "@/ui/detail";
import { NoticesRail } from "@/ui/figures";
import { LegendRailCard } from "@/ui/list-surface";
import { useItemRelevance } from "@/features/regulations/useItemRelevance";
import { DetailTagRow } from "@/features/workspace/ui/DetailTagRow";
import { DetailWatch } from "@/features/workspace/ui/DetailWatch";

import type { RelatedResult } from "../../research/read/related-items";
import type { DerivedFigure } from "../model/derived-view";
import { omitNote, type MatrixEligibility } from "../model/matrix-eligibility";
import { AUXILIARY_ENERGY_ASIDE, GRID_QUEUE_ASIDE, type AuxiliaryEnergyRow, type GridIntensity, type GridQueueRow } from "../model/spec09";

import styles from "./operations.module.css";
import { AuxiliaryEnergyPanel, DerivedFigures, GridQueuePanel } from "./Spec09Panels";

export interface OperationsDetailProps {
  resource: Resource;
  sections: SectionRow[];
  claimTiers: ClaimTierMap;
  /** The claims or their suppressions could not be read: the stored sections and the brief are withheld (INV-270) and the page says so with Retry. */
  claimsDegraded: boolean;
  recommendedActions: RecommendedAction[];
  connectionRows: ConnectionRow[];
  crossPage: CrossPageData;
  related: RelatedResult;
  eligibility: MatrixEligibility;
  spec09: { aux: AuxiliaryEnergyRow[] | null; grid: GridQueueRow[] | null; intensity: GridIntensity | null; intensityFailed: boolean };
  derived: DerivedFigure[] | null;
  nowIso: string;
}

const HEADINGS: Readonly<Record<string, string>> = { "1": "Operational cost baseline", "2": "Feasibility of operational choices", "3": "Cost vs alternatives", "4": "Cross-regional", "5": "Competitive positioning", "6": "Talking points", "7": "Upcoming changes", "8": "Sources" };
const GATED = new Set(["3", "4"]);

function RelatedRegionCard({ related, region, onRetry }: { related: RelatedResult; region: string; onRetry: () => void }) {
  if (related.failed) return <StateNote tone="error" action={{ label: "Retry", onClick: onRetry }}>Related items did not load.</StateNote>;
  if (related.items.length === 0) return null;
  return (
    <SectionCard padding="12px 16px 14px">
      <p className={styles.kicker}>{related.reason === "source" ? "Related by source" : `Related in ${region || "region"}`}</p>
      <div className={styles.derived}>
        {related.items.map((it) => (
          <Link key={it.id} href={`/operations/${encodeURIComponent(it.id)}`} className={styles.relatedLink}>
            <span aria-hidden="true" className={styles.relatedBar} />
            <span className={styles.relatedTitle}>{it.title}</span>
          </Link>
        ))}
      </div>
    </SectionCard>
  );
}

export function OperationsDetail(p: OperationsDetailProps) {
  const { resource: r, nowIso } = p;
  const router = useRouter();
  const relevance = useItemRelevance(r.id);
  const band = bandFromPriority(r.priority);
  const [depth, setDepth] = useState<"summary" | "full">("summary");
  const [tagOpen, setTagOpen] = useState(false);
  const jurisLabel = jurisLabelOf(r);
  const regionGroup = regionGroupForLabel(jurisLabel);
  const rows = useMemo(() => sourceEntriesOf(r), [r]);
  const known = useMemo(() => p.sections.filter((s) => s.section_key in HEADINGS), [p.sections]);
  const unparsedBrief = known.length === 0 && r.fullBrief ? stripSourcesSection(r.fullBrief) : "";
  const presence = crossPagePresence(p.crossPage);
  const dek = [`Operations · ${jurisLabel}`, r.sourceName, r.added ? `published ${formatDate(r.added)}` : null, r.modes && r.modes.length > 0 ? r.modes.map((m) => m.toUpperCase()).join(" · ") : null].filter(Boolean).join(" · ");
  const index = [
    { id: "summary", shortName: "Summary", ord: 1 },
    { id: "findings", shortName: "Findings", ord: 2 },
    { id: "auxiliary-energy", shortName: "Aux. energy", ord: 3 },
    { id: "grid-queue", shortName: "Grid queue", ord: 4 },
    { id: "sources", shortName: "Sources", ord: 5 },
    ...(presence.connected ? [{ id: CONNECTED_SECTION_ID, shortName: "Connected", ord: crossPageOrd("operations", CONNECTED_SECTION_ID) }] : []),
    ...(presence.inferences ? [{ id: INFERENCES_SECTION_ID, shortName: "Inferences", ord: crossPageOrd("operations", INFERENCES_SECTION_ID) }] : []),
  ];
  const retry = () => router.refresh();
  const here = `/operations/${encodeURIComponent(r.id)}`;
  const actionCard = (
    <ActionCard
      bare
      band={band}
      kindLabel="Regional profile"
      nowIso={nowIso}
      extraChips={
        <>
          <GradeChip itemGrade={r.itemGrade} />
          {(regionGroup || jurisLabel) && <TagChip>{regionGroup || jurisLabel}</TagChip>}
          {r.modes?.slice(0, 2).map((m) => <TagChip key={m}>{m.toUpperCase()}</TagChip>)}
          {r.topic && <TagChip>{r.topic}</TagChip>}
        </>
      }
      tier={typeof r.sourceTier === "number" ? r.sourceTier : null}
      biasTags={r.biasTags}
      meta={rows.length > 0 ? `${rows.length} source${rows.length === 1 ? "" : "s"}${p.connectionRows.length > 0 ? ` · ${p.connectionRows.length} ${pluralize(p.connectionRows.length, "connection")}` : ""}` : null}
      onExport={() => void downloadMarkdownBrief(r, { filenamePrefix: "operations", metaRows: [r.jurisdiction ? `- Region: ${r.jurisdiction}` : null, r.modes && r.modes.length > 0 ? `- Modes: ${r.modes.join(", ")}` : null, r.url ? `- Source: ${r.url}` : null] })}
      {...commonActionCardProps(r, { tagPopover: <DetailTagRow itemId={r.id} open={tagOpen} onOpenChange={setTagOpen} />, watch: <DetailWatch type="operations" id={r.id} />, onTag: () => setTagOpen((v) => !v) })}
      where={{ value: jurisLabel || null }}
    />
  );
  const finding = (s: SectionRow, i: number): ReactNode => {
    const heading = HEADINGS[s.section_key] as string;
    if (GATED.has(s.section_key)) {
      const open = s.section_key === "3" ? p.eligibility.s3Eligible : p.eligibility.s4Eligible;
      if (!open) return <DetailSubSection key={s.section_key} title={heading} first={i === 0}><StateNote>{omitNote(s.section_key as "3" | "4", p.eligibility)}</StateNote></DetailSubSection>;
    }
    if (!(s.content_md || "").trim()) return s.is_conditional ? null : <DetailSubSection key={s.section_key} title={heading} first={i === 0}><StateNote>No content is recorded for this section.</StateNote></DetailSubSection>;
    return <DetailSubSection key={s.section_key} title={heading} first={i === 0}><FactBlocks markdown={s.content_md} /></DetailSubSection>;
  };
  return (
    <ClaimTierProvider claimTiers={p.claimTiers}>
      <div style={{ paddingTop: 16 }}>
        <DetailPageWrapper band={band} action={topRecommendedAction(p.recommendedActions)} nowIso={nowIso}>
          <DetailMasthead title={r.title} band={band} surface="Operations" jurisdiction={regionGroup || jurisLabel} dek={dek} placeholder="Ask about this profile, e.g. when does the largest deadline hit" nowIso={nowIso} actionSlot={actionCard} connectionsSlot={p.connectionRows.length > 0 ? <ItemConnections rows={p.connectionRows} /> : undefined} />
          {r.conversionTrigger && <p className={styles.noteText}>{r.conversionTrigger}</p>}
          {p.claimsDegraded && (
            <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>
              The facts of this profile did not load, so none is shown. Nothing was changed; try again.
            </StateNote>
          )}
          {p.eligibility.unavailable && (
            <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>
              The regional coverage data did not load, so the cost and cross-regional comparisons are not available.
            </StateNote>
          )}
          <SectionIndex sections={index} depth={depth} onDepthChange={setDepth} />
          <DetailLayout
            rail={
              <DetailRail
                atAGlance={<AtAGlanceCard rows={[{ label: "Topic", value: r.topic ?? null }, { label: "Comparison", value: p.eligibility.unavailable ? "Not available" : p.eligibility.s3Eligible ? "Available" : `Building${p.eligibility.resolvedRegionCodes.length > 0 ? ` (${p.eligibility.resolvedRegionCodes.join(", ")})` : ""}` }]} />}
                impact={<ImpactRailCard scores={r.impactScores ?? null} />}
                relevance={<RelevanceRailCard state={relevance.phase === "ready" ? { phase: "ready", relevance: relevance.data.relevance } : relevance.phase === "failed" ? { phase: "failed", retry: relevance.retry } : { phase: "loading" }} />}
                designed={<><RelatedRegionCard related={p.related} region={regionGroup || jurisLabel} onRetry={retry} /><DerivedFigures figures={p.derived} retryHref={here} /></>}
                legend={<LegendRailCard />}
                undesigned={<InThisListStat backHref="/operations" backLabel="Back to list" band={band} />}
              />
            }
          >
            <DetailSection id="summary" title="Summary" index={1}>
              {r.whatIsIt || r.note || r.whyMatters ? <p className={styles.summaryProse}>{r.whatIsIt || r.note || r.whyMatters}</p> : <StateNote>The summary for this regional profile is not written yet; it needs the profile&apos;s brief.</StateNote>}
              {depth === "full" && unparsedBrief && <div className={styles.fullBrief}><GfmSection markdown={unparsedBrief} /></div>}
            </DetailSection>
            <DetailSection id="findings" title="Substantive findings" index={2}>
              {known.length > 0 ? known.map(finding) : <StateNote>{p.claimsDegraded ? "Detailed sections for this regional profile are withheld until the facts load." : "Detailed sections for this regional profile are not written yet; they need the profile's brief."}</StateNote>}
            </DetailSection>
            <DetailSection id="auxiliary-energy" title="Auxiliary energy load" aside={AUXILIARY_ENERGY_ASIDE} index={3}>
              {p.spec09.intensityFailed && <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>The grid intensity for this region did not load, so loads show kWh only.</StateNote>}
              <AuxiliaryEnergyPanel rows={p.spec09.aux} intensity={p.spec09.intensity} retryHref={here} />
            </DetailSection>
            <DetailSection id="grid-queue" title="Grid connection queue" aside={GRID_QUEUE_ASIDE} index={4}>
              <GridQueuePanel rows={p.spec09.grid} retryHref={here} />
            </DetailSection>
            <DetailSection id="sources" title="Sources" index={5} aside={rows.length > 0 ? `${rows.length} · tier = provenance, never urgency` : undefined}>
              {rows.length > 0 ? <SourcesGrid rows={rows} /> : <StateNote>No sources are listed for this item.</StateNote>}
            </DetailSection>
            <CrossPageSection surfaceKey="operations" surfaceLabel="Operations" crossPage={p.crossPage} onRetry={retry} />
            <NoticesRail />
          </DetailLayout>
        </DetailPageWrapper>
      </div>
    </ClaimTierProvider>
  );
}
