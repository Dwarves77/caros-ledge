"use client";

// Ported from old_repo/src/components/research/ResearchFindingDetailSurface.tsx (lines 34-437)
// The Research finding page on the shared detail architecture: the masthead with the action card and the connections, the section index (fixed ordinals: 01 Summary, 02 Findings, 05 Sources, 06 Related, then the
// cross-page sections), the stored findings by section (never the raw brief where sections exist), the record-grade verbatim facts, Sources with each registry rating, Related, and the rail: At a glance, impact,
// relevance, the horizon assessment, dissent, signposts, history, the cluster synthesis, the legend and the list position. Nothing reads the clock; a failed block says so.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import type { RecommendedAction } from "@/core/brief";
import { parseRecordSections, splitKeyDateFacts, stripSourcesSection } from "@/core/brief";
import type { SectionRow } from "@/core/detail/item-read";
import { withObligationEvents } from "@/core/detail/timeline";
import { CONNECTED_SECTION_ID, crossPageOrd, INFERENCES_SECTION_ID } from "@/core/detail/section-index";
import type { ObligationEventInput } from "@/ui/timeline-math";
import { sourceEntriesOf } from "@/core/detail/sources-parse";
import type { ConnectionRow } from "@/core/flywheel/view-model";
import { jurisLabelOf } from "@/core/jurisdictions";
import { bandFromPriority } from "@/core/lists";
import { formatDate, pluralize } from "@/core/shared";
import type { Resource } from "@/core/types";
import { ActionCard, ClaimTierProvider, DetailSubSection, downloadMarkdownBrief, GfmSection, GradeChip, SectionIndex, StateNote, TagChip, type ClaimTierMap } from "@/ui";
import { AtAGlanceCard, commonActionCardProps, CrossPageSection, crossPagePresence, DetailLayout, DetailMasthead, DetailPageWrapper, DetailRail, DetailSection, FactBlocks, ImpactRailCard, InThisListStat, ItemConnections, RecordFacts, RelevanceRailCard, SourcesGrid, topRecommendedAction, type CrossPageData } from "@/ui/detail";
import { NoticesRail } from "@/ui/figures";
import { LegendRailCard } from "@/ui/list-surface";
import { useItemRelevance } from "@/features/regulations/useItemRelevance";
import { DetailTagRow } from "@/features/workspace/ui/DetailTagRow";
import { DetailWatch } from "@/features/workspace/ui/DetailWatch";
import { itemTypeLabel } from "@/features/market/lib/item-type";

import { themeLabel, themeOf } from "../model/taxonomy";
import type { AssessmentBundle } from "../read/research-reads";
import type { RelatedResult } from "../read/related-items";

import { AssessmentCard, AssessmentHistory, DissentPanel, SignpostList } from "./AssessmentRail";
import { CredibilityChips } from "./CredibilityChips";
import styles from "./research.module.css";
import { ThemeBriefCard } from "./ThemeBriefCard";

export interface ResearchDetailProps {
  resource: Resource;
  sections: SectionRow[];
  claimTiers: ClaimTierMap;
  /** The claims or their suppressions could not be read: the stored sections and the brief are withheld (INV-270) and the page says so with Retry. */
  claimsDegraded: boolean;
  recommendedActions: RecommendedAction[];
  connectionRows: ConnectionRow[];
  crossPage: CrossPageData;
  related: RelatedResult;
  assessment: AssessmentBundle;
  events?: ObligationEventInput[];
  eventsFailed?: boolean;
  kindLabels?: Record<string, string>;
  nowIso: string;
}

/** The stored findings sections and the headings they render under. */
const HEADINGS: Readonly<Record<string, string>> = { "1": "What the research found", "2": "Why it matters operationally", "3": "Strategy & claims", "4": "Talking points", "5": "What does not resolve", "6": "Sources" };

export function ResearchDetail(p: ResearchDetailProps) {
  const { resource: r, nowIso } = p;
  const timeline = useMemo(() => withObligationEvents(r.timeline ?? [], p.events ?? [], p.kindLabels ?? {}), [r.timeline, p.events, p.kindLabels]);
  const router = useRouter();
  const relevance = useItemRelevance(r.id);
  const band = bandFromPriority(r.priority);
  const theme = themeOf(r);
  const isRecord = r.itemGrade === "record";
  const [depth, setDepth] = useState<"summary" | "full">("summary");
  const [tagOpen, setTagOpen] = useState(false);
  const jurisLabel = jurisLabelOf(r);
  const dek = [`Research${theme ? ` · ${themeLabel(theme)}` : ""}`, r.added ? `published ${formatDate(r.added)}` : null].filter(Boolean).join(" · ");
  const known = useMemo(() => p.sections.filter((s) => s.section_key in HEADINGS && (s.content_md || "").trim()), [p.sections]);
  const rows = useMemo(() => sourceEntriesOf(r), [r]);
  const parsed = useMemo(() => (isRecord ? parseRecordSections(p.sections, p.claimTiers) : null), [isRecord, p.sections, p.claimTiers]);
  const split = parsed ? splitKeyDateFacts(parsed.facts) : { dateFacts: [], otherFacts: [] };
  const summaryProse = r.whatIsIt || r.note || r.whyMatters || null;
  const unparsedBrief = !isRecord && known.length === 0 && r.fullBrief ? stripSourcesSection(r.fullBrief) : "";
  const presence = crossPagePresence(p.crossPage);
  const hasRelated = p.related.items.length > 0;
  const index = [
    { id: "summary", shortName: "Summary", ord: 1 },
    ...(isRecord ? [] : [{ id: "findings", shortName: "Findings", ord: 2 }]),
    { id: "sources", shortName: "Sources", ord: 5 },
    ...(hasRelated || p.related.failed ? [{ id: "related", shortName: "Related", ord: 6 }] : []),
    ...(presence.connected ? [{ id: CONNECTED_SECTION_ID, shortName: "Connected", ord: crossPageOrd("research", CONNECTED_SECTION_ID) }] : []),
    ...(presence.inferences ? [{ id: INFERENCES_SECTION_ID, shortName: "Inferences", ord: crossPageOrd("research", INFERENCES_SECTION_ID) }] : []),
  ];
  const trajectory = r.conversionTrigger || null;
  const actionCard = (
    <ActionCard
      bare
      band={band}
      kindLabel="Finding"
      nowIso={nowIso}
      extraChips={
        <>
          <GradeChip itemGrade={r.itemGrade} />
          {itemTypeLabel(r.type) && <TagChip>{itemTypeLabel(r.type)}</TagChip>}
          {theme && <TagChip>{themeLabel(theme)}</TagChip>}
          {r.modes && r.modes.length > 0 ? r.modes.slice(0, 2).map((m) => <TagChip key={m}>{m.toUpperCase()}</TagChip>) : <TagChip>All modes</TagChip>}
        </>
      }
      tier={typeof r.sourceTier === "number" ? r.sourceTier : null}
      biasTags={r.biasTags}
      meta={rows.length > 0 ? `${rows.length} source${rows.length === 1 ? "" : "s"}${p.connectionRows.length > 0 ? ` · ${p.connectionRows.length} ${pluralize(p.connectionRows.length, "connection")}` : ""}` : null}
      onExport={() => void downloadMarkdownBrief(r, { filenamePrefix: "research", metaRows: [r.jurisdiction ? `- Jurisdiction: ${r.jurisdiction}` : null, r.type ? `- Type: ${r.type}` : null, r.url ? `- Source: ${r.url}` : null] })}
      {...commonActionCardProps(r, { tagPopover: <DetailTagRow itemId={r.id} open={tagOpen} onOpenChange={setTagOpen} />, watch: <DetailWatch type="research" id={r.id} />, onTag: () => setTagOpen((v) => !v) })}
      timeline={timeline}
      where={{ value: jurisLabel }}
    />
  );
  const prose = (text: string) => <p className={styles.summaryProse}>{text}</p>;
  return (
    <ClaimTierProvider claimTiers={p.claimTiers}>
      <div style={{ paddingTop: 16 }}>
        <DetailPageWrapper band={band} action={topRecommendedAction(p.recommendedActions)} nowIso={nowIso}>
          <DetailMasthead title={r.title} band={band} surface="Research" jurisdiction={jurisLabel} dek={dek} placeholder="Ask about this finding, e.g. when does the largest deadline hit" nowIso={nowIso} actionSlot={actionCard} connectionsSlot={p.connectionRows.length > 0 ? <ItemConnections rows={p.connectionRows} /> : undefined} />
          {p.claimsDegraded && (
            <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
              The facts of this finding did not load, so none is shown. Nothing was changed; try again.
            </StateNote>
          )}
          {p.eventsFailed && (
            <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>
              The dated obligations failed to load, so the timeline shows only the stored milestones.
            </StateNote>
          )}
          <SectionIndex sections={index} depth={depth} onDepthChange={setDepth} />
          <DetailLayout
            rail={
              <DetailRail
                atAGlance={<AtAGlanceCard rows={[{ label: "Theme", value: theme ? themeLabel(theme) : null }, { label: "Topic", value: r.topic ?? null }]} />}
                impact={<ImpactRailCard scores={r.impactScores ?? null} />}
                relevance={<RelevanceRailCard state={relevance.phase === "ready" ? { phase: "ready", relevance: relevance.data.relevance } : relevance.phase === "failed" ? { phase: "failed", retry: relevance.retry } : { phase: "loading" }} />}
                designed={
                  <>
                    <AssessmentCard assessment={p.assessment.assessment} failed={p.assessment.failed} />
                    <DissentPanel assessment={p.assessment.assessment} />
                    <SignpostList signposts={p.assessment.signposts} />
                    <AssessmentHistory bundle={p.assessment} />
                    <ThemeBriefCard brief={p.crossPage.theme ?? null} />
                  </>
                }
                legend={<LegendRailCard />}
                undesigned={<InThisListStat backHref="/research" backLabel="Back to list" band={band} />}
              />
            }
          >
            <DetailSection id="summary" title="Summary" index={1}>
              {isRecord ? (
                <RecordFacts leadNote="This finding was captured directly from its source document rather than synthesized into a research summary. Every fact below is quoted verbatim." dateFacts={split.dateFacts} otherFacts={split.otherFacts} tags={r.tags} />
              ) : summaryProse ? (
                prose(summaryProse)
              ) : (
                <StateNote>The summary for this finding is not written yet; it needs the finding’s brief.</StateNote>
              )}
              {trajectory && <div style={{ marginTop: 12 }}>{prose(trajectory)}</div>}
              {depth === "full" && unparsedBrief && (
                <div className={styles.fullBrief}>
                  <GfmSection markdown={unparsedBrief} />
                </div>
              )}
              <div className={styles.credRow} style={{ marginTop: 12 }}>
                <CredibilityChips assessment={p.assessment.assessment} biasTags={r.biasTags ?? []} />
              </div>
            </DetailSection>
            {!isRecord && (
              <DetailSection id="findings" title="Substantive findings" index={2}>
                {known.length > 0 ? (
                  known.map((s, i) => (
                    <DetailSubSection key={s.section_key} title={HEADINGS[s.section_key] as string} first={i === 0}>
                      <FactBlocks markdown={s.content_md} />
                    </DetailSubSection>
                  ))
                ) : (
                  <StateNote>{p.claimsDegraded ? "Detailed sections for this finding are withheld until the facts load." : "Detailed sections for this finding are not written yet; they need the finding's brief."}</StateNote>
                )}
              </DetailSection>
            )}
            <DetailSection id="sources" title="Sources" index={5} aside={rows.length > 0 ? `${rows.length} · tier = provenance, never urgency` : undefined}>
              {rows.length > 0 ? <SourcesGrid rows={rows} /> : <StateNote>No sources are listed for this item.</StateNote>}
            </DetailSection>
            {(hasRelated || p.related.failed) && (
              <DetailSection id="related" title="Related" index={6} aside={p.related.reason === "match" ? "same theme" : p.related.reason === "source" ? "same source" : undefined}>
                {p.related.failed ? (
                  <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>Related findings did not load.</StateNote>
                ) : (
                  p.related.items.map((it) => (
                    <Link key={it.id} href={`/research/${encodeURIComponent(it.id)}`} className={styles.relatedRow}>
                      <p className={styles.relatedName}>{it.title}</p>
                      {it.summary && <p className={styles.fine}>{it.summary.length > 180 ? `${it.summary.slice(0, 177)}…` : it.summary}</p>}
                    </Link>
                  ))
                )}
              </DetailSection>
            )}
            <CrossPageSection surfaceKey="research" surfaceLabel="Research" crossPage={p.crossPage} onRetry={() => router.refresh()} />
            <NoticesRail />
          </DetailLayout>
        </DetailPageWrapper>
      </div>
    </ClaimTierProvider>
  );
}

