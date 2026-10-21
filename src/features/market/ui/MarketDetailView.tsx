"use client";

// Ported from old_repo/src/components/pages/MarketSignalDetailSurface.tsx (lines 1-873)
// The /market/[slug] page on the detail architecture (P2-10): the masthead with the action card, the section index and the Summary | Full brief switch, the rail, S1 Summary (price board, series figure, the stored movement analysis),
// S2 Substantive findings (drivers and trajectory, carbon, cost by mode, do now, talking points), S5 Sources, S6 Related, the cross-page analysis and the recalculation notices. The loader's degraded blocks (claims that did
// not load, a refused market read) are said where they sit with Retry; nothing here reads the clock or a table.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import type { RecommendedAction } from "@/core/brief";
import { stripSourcesSection } from "@/core/brief";
import { withObligationEvents } from "@/core/detail/timeline";
import { CONNECTED_SECTION_ID, crossPageOrd, INFERENCES_SECTION_ID } from "@/core/detail/section-index";
import type { ObligationEventInput } from "@/ui/timeline-math";
import { sourceEntriesOf } from "@/core/detail/sources-parse";
import type { SectionRow } from "@/core/detail/item-read";
import type { ConnectionRow } from "@/core/flywheel";
import { jurisLabelOf } from "@/core/jurisdictions";
import { bandFromPriority } from "@/core/lists";
import { formatDate } from "@/core/shared";
import type { Resource } from "@/core/types";
import { joinSegments } from "@/features/regulations/meta";
import { useItemRelevance } from "@/features/regulations/useItemRelevance";
import { DetailTagRow } from "@/features/workspace/ui/DetailTagRow";
import { DetailWatch } from "@/features/workspace/ui/DetailWatch";
import { ActionCard, ClaimTierProvider, downloadMarkdownBrief, GfmSection, GradeChip, SectionIndex, StateNote, TagChip, type ClaimTierMap } from "@/ui";
import { AtAGlanceCard, commonActionCardProps, CrossPageSection, crossPagePresence, DetailLayout, DetailMasthead, DetailPageWrapper, DetailRail, DetailSection, FactBlocks, ImpactRailCard, InThisListStat, RelevanceRailCard, SourcesGrid, topRecommendedAction, type CrossPageData } from "@/ui/detail";
import { NoticesRail } from "@/ui/figures";
import { DetailSubSection } from "@/ui/ItemGroup";
import { LegendRailCard } from "@/ui/list-surface";

import { bandOf, BAND_LABEL, BAND_NUM } from "../lib/signal-band";
import { severityLabel } from "../lib/severity";
import { derivePromotionState } from "../lib/signal-promotion";
import type { MarketDetailBundle } from "../read";

import { CarbonFindings, PriceBoardBlock } from "./MarketSignalDetail";
import { TrajectoryBars } from "./TrajectoryBars";
import styles from "./market.module.css";

export interface MarketDetailViewProps {
  resource: Resource;
  sections: SectionRow[];
  claimTiers: ClaimTierMap;
  claimsDegraded: boolean;
  recommendedActions: RecommendedAction[];
  crossPage: CrossPageData;
  connectionRows: ConnectionRow[];
  bundle: MarketDetailBundle;
  events?: ObligationEventInput[];
  eventsFailed?: boolean;
  kindLabels?: Record<string, string>;
  nowIso: string;
}

const SHOWN = 3;

/** The connections of the item as the old rail card drew them: the relation and the surface it is on, the item, and why they are linked with the score; three shown, the rest behind "+N more". */
function ConnectionList({ rows }: { rows: ConnectionRow[] }) {
  const [all, setAll] = useState(false);
  const linked = rows.filter((r) => r.href);
  if (linked.length === 0) return null;
  return (
    <div data-part="item-connections">
      <p className="cl-detail-label">Connections</p>
      {(all ? linked : linked.slice(0, SHOWN)).map((r) => (
        <Link key={`${r.id}-${r.label}`} href={r.href as string} prefetch={false} className="cl-detail-link" title={r.title}>
          <p className="cl-detail-label" style={{ margin: 0 }}>
            {r.label}· {r.surface}
          </p>
          <p data-guard-title className="cl-detail-link-title">
            {r.title}
          </p>
          {r.basisSummary[0] ? (
            <p className={styles.muted}>
              {r.basisSummary[0].signal.replace(/_/g, " ")}
              {r.score != null ? ` · ${r.score.toFixed(2)}` : ""}
            </p>
          ) : null}
        </Link>
      ))}
      {linked.length > SHOWN && !all ? (
        <button type="button" onClick={() => setAll(true)} className={styles.moreButton}>
          +{linked.length - SHOWN} more
        </button>
      ) : null}
    </div>
  );
}

const WAITING = "appears here once the signal brief is generated.";

export function MarketDetailView({ resource: r, sections, claimTiers, claimsDegraded, recommendedActions, crossPage, connectionRows, bundle, events, eventsFailed, kindLabels, nowIso }: MarketDetailViewProps) {
  const timeline = useMemo(() => withObligationEvents(r.timeline ?? [], events ?? [], kindLabels ?? {}), [r.timeline, events, kindLabels]);
  const router = useRouter();
  const retry = () => router.refresh();
  const relevance = useItemRelevance(r.id);
  const band = bandFromPriority(r.priority);
  const signalBand = bandOf(r);
  const kind = severityLabel(r.severity);
  const bandLabel = signalBand ? `B${BAND_NUM[signalBand]} · ${BAND_LABEL[signalBand]}` : null;
  const isRecord = r.itemGrade === "record";
  const [depth, setDepth] = useState<"summary" | "full">("summary");
  const [tagOpen, setTagOpen] = useState(false);
  const map = useMemo(() => Object.fromEntries(claimsDegraded ? [] : sections.filter((s) => (s.content_md || "").trim()).map((s) => [s.section_key, s.content_md.trim()])), [sections, claimsDegraded]);
  const sourceRows = useMemo(() => sourceEntriesOf(r), [r]);
  const citers = bundle.convergence.ok ? (bundle.convergence.data?.independent_citers ?? null) : null;
  const promotion = derivePromotionState({ originClass: r.originClass ?? null, independentCiters: citers });
  const jurisLabel = jurisLabelOf(r);
  const hasRelated = connectionRows.length > 0;
  const presence = crossPagePresence(crossPage);
  const actions = [...recommendedActions].sort((a, b) => (a.timeframe_days ?? 1e9) - (b.timeframe_days ?? 1e9));
  const carbonItem = { jurisdictionIso: r.jurisdictionIso ?? [], modes: r.modes ?? [] };
  const hasCarbon = signalBand === "corridor";
  const carbonResolved = hasCarbon && bundle.carbon.ok && bundle.carbon.data.factors.length > 0;
  const showFindings = !isRecord || carbonResolved;
  const trajectory = signalBand === "price" && (r.trajectoryPoints?.points?.length ?? 0) > 0 ? r.trajectoryPoints : null;
  const index = [
    { id: "summary", shortName: "Summary", ord: 1 },
    ...(showFindings ? [{ id: "findings", shortName: "Findings", ord: 2 }] : []),
    { id: "sources", shortName: "Sources", ord: 5 },
    ...(hasRelated ? [{ id: "related", shortName: "Related", ord: 6 }] : []),
    ...(presence.connected ? [{ id: CONNECTED_SECTION_ID, shortName: "Connected", ord: crossPageOrd("market", CONNECTED_SECTION_ID) }] : []),
    ...(presence.inferences ? [{ id: INFERENCES_SECTION_ID, shortName: "Inferences", ord: crossPageOrd("market", INFERENCES_SECTION_ID) }] : []),
  ];
  const note = (what: string) => <StateNote>{claimsDegraded ? `${what} is withheld until the facts load.` : `${what} ${WAITING}`}</StateNote>;
  const meta = joinSegments([bandLabel, jurisLabel, r.sourceName, r.added ? formatDate(r.added) : null, citers !== null ? `${citers} independent source${citers === 1 ? "" : "s"} corroborate` : null]);
  const published = r.added ? formatDate(r.added) : null;
  const nextRelease = bundle.priceBoard.ok ? bundle.priceBoard.data.find((p) => p.nextReleaseAt)?.nextReleaseAt : null;

  const actionCard = (
    <ActionCard
      bare
      band={band}
      kindLabel="Signal"
      nowIso={nowIso}
      extraChips={
        <>
          <GradeChip itemGrade={r.itemGrade} />
          {kind ? <TagChip>{kind}</TagChip> : null}
          {r.topic ? <TagChip>{r.topic}</TagChip> : null}
          {bandLabel ? <TagChip>{bandLabel}</TagChip> : null}
        </>
      }
      tier={typeof r.sourceTier === "number" ? r.sourceTier : null}
      biasTags={r.biasTags}
      meta={sourceRows.length > 0 ? `${sourceRows.length} source${sourceRows.length === 1 ? "" : "s"}${citers !== null ? ` · ${citers} corroborating` : ""}` : null}
      onExport={() => void downloadMarkdownBrief(r, { filenamePrefix: "signal", metaRows: [r.jurisdiction ? `- Jurisdiction: ${r.jurisdiction}` : null, r.severity ? `- Severity: ${r.severity}` : null, r.signalBand ? `- Signal band: ${r.signalBand}` : null, r.url ? `- Source: ${r.url}` : null] })}
      {...commonActionCardProps(r, { tagPopover: <DetailTagRow itemId={r.id} open={tagOpen} onOpenChange={setTagOpen} />, watch: <DetailWatch type="signal" id={r.id} />, onTag: () => setTagOpen((v) => !v) })}
      timeline={timeline}
      where={{ value: jurisLabel }}
    />
  );

  return (
    <ClaimTierProvider claimTiers={claimTiers}>
      <div style={{ paddingTop: 16 }}>
        <DetailPageWrapper band={band} action={topRecommendedAction(recommendedActions)} nowIso={nowIso}>
          <DetailMasthead title={r.title} band={band} surface="Market Intel" jurisdiction={jurisLabel} dek={meta} placeholder="Ask about this signal, e.g. when does the largest deadline hit" nowIso={nowIso} actionSlot={actionCard} />
          {claimsDegraded && (
            <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>
              The facts of this signal did not load, so none is shown. Nothing was changed; try again.
            </StateNote>
          )}
          {eventsFailed && (
            <StateNote tone="error" action={{ label: "Retry", onClick: retry }}>
              The dated obligations failed to load, so the timeline shows only the stored milestones.
            </StateNote>
          )}
          <SectionIndex sections={index} depth={depth} onDepthChange={setDepth} />
          <DetailLayout
            rail={
              <DetailRail
                atAGlance={
                  <AtAGlanceCard
                    rows={[
                      { label: "Band", value: `${band.label} · ${band.window}` },
                      { label: "Kind", value: kind },
                      { label: "Corporate band", value: bandLabel },
                      { label: "Jurisdiction", value: jurisLabel },
                      { label: "Topic", value: r.topic },
                      { label: "Status", value: promotion.label },
                      { label: "Published", value: published },
                      { label: "Next release", value: nextRelease ? formatDate(nextRelease.slice(0, 10)) : null },
                    ]}
                  />
                }
                impact={<ImpactRailCard scores={r.impactScores ?? null} />}
                relevance={<RelevanceRailCard state={relevance.phase === "ready" ? { phase: "ready", relevance: relevance.data.relevance } : relevance.phase === "failed" ? { phase: "failed", retry: relevance.retry } : { phase: "loading" }} />}
                designed={<InThisListStat backHref="/market" backLabel="Back to list" band={band} />}
                legend={<LegendRailCard />}
              />
            }
          >
            <DetailSection id="summary" title="Summary" aside="Generated · 30-second read" index={1}>
              <PriceBoardBlock bundle={bundle} nowIso={nowIso} />
              {map["1"] ? <FactBlocks markdown={map["1"]} /> : note("The movement analysis")}
              {depth === "full" && !isRecord && !claimsDegraded && r.fullBrief ? (
                <div style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line-3)" }}>
                  <GfmSection markdown={stripSourcesSection(r.fullBrief)} />
                </div>
              ) : null}
            </DetailSection>
            {showFindings && (
              <DetailSection id="findings" title="Substantive findings" index={2}>
                {isRecord ? (
                  <CarbonFindings bundle={bundle} item={carbonItem} nowIso={nowIso} />
                ) : (
                  <>
                    <DetailSubSection title="Drivers & trajectory" subtitle="4 forces · compounding" first>
                      {map["2"] ? <FactBlocks markdown={map["2"]} /> : null}
                      {map["3"] ? <FactBlocks markdown={map["3"]} /> : null}
                      {r.conversionTrigger ? (
                        <p>
                          <b>Conversion trigger:</b> {r.conversionTrigger}
                        </p>
                      ) : null}
                      {trajectory ? <TrajectoryBars trajectoryPoints={trajectory} /> : null}
                      {hasCarbon ? <CarbonFindings bundle={bundle} item={carbonItem} nowIso={nowIso} /> : null}
                      {map["5"] ? <FactBlocks markdown={map["5"]} /> : null}
                      {!map["2"] && !map["3"] && !map["5"] && !trajectory && !hasCarbon ? note("Drivers and trajectory") : null}
                    </DetailSubSection>
                    <DetailSubSection title="Cost impact by mode" subtitle="Air · Ocean · Road">
                      {map["4"] ? <FactBlocks markdown={map["4"]} /> : note("Operational and cost implications by mode")}
                    </DetailSubSection>
                    <DetailSubSection title="Do now" subtitle={actions.length > 0 ? `${actions.length} steps` : null}>
                      {actions.length > 0 ? (
                        <ul className={styles.gapList}>
                          {actions.map((a, i) => (
                            <li key={`${a.action_text}-${i}`}>
                              <b>{a.timeframe_days != null ? `${a.timeframe_days} days` : `Step ${i + 1}`}</b> · {a.action_text}
                              {a.owner ? <span className={styles.muted}> · {a.owner}</span> : null}
                            </li>
                          ))}
                        </ul>
                      ) : map["7"] ? (
                        <FactBlocks markdown={map["7"]} />
                      ) : (
                        note("The actions the workspace should take")
                      )}
                    </DetailSubSection>
                    <DetailSubSection title="Client talking points">{map["6"] ? <FactBlocks markdown={map["6"]} /> : note("What the workspace can credibly say")}</DetailSubSection>
                  </>
                )}
              </DetailSection>
            )}
            <DetailSection id="sources" title="Sources" index={5} aside={sourceRows.length > 0 ? `${sourceRows.length} · tier = provenance, never urgency` : undefined}>
              {sourceRows.length > 0 ? <SourcesGrid rows={sourceRows} /> : <StateNote>No sources are listed for this item.</StateNote>}
            </DetailSection>
            {hasRelated && (
              <DetailSection id="related" title="Related" aside={signalBand ? BAND_LABEL[signalBand] : undefined} index={6}>
                <ConnectionList rows={connectionRows} />
              </DetailSection>
            )}
            <CrossPageSection surfaceKey="market" surfaceLabel="Market Intel" crossPage={crossPage} onRetry={retry} />
            <NoticesRail />
          </DetailLayout>
        </DetailPageWrapper>
      </div>
    </ClaimTierProvider>
  );
}
