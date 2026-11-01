"use client";

// Ported from old_repo/src/components/regulations/RegulationDetailSurface.tsx (lines 103-674)
// The regulation page body. Summary depth shows S1 and the first Obligations group; Full brief renders every stored fact-document section by its key (the eight the old page never drew included),
// Penalties and Sources, each ONCE: never the raw full_brief and never its raw Sources markdown. A record-grade item renders its verbatim facts. The obligation events arrive read on the server
// (a failed read is a note with Retry, not an empty timeline); nothing here reads the clock.
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { stripSourcesSection, parseRecordSections, splitKeyDateFacts } from "@/core/brief";
import { indexFor, SECTION_INDEX, CONNECTED_SECTION_ID, INFERENCES_SECTION_ID } from "@/core/detail/section-index";
import { sourceEntriesOf } from "@/core/detail/sources-parse";
import { withObligationEvents } from "@/core/detail/timeline";
import type { SectionRow } from "@/core/detail/item-read";
import { bandFromPriority } from "@/core/lists";
import { formatDate } from "@/core/shared";
import type { ChangeLogEntry, Dispute, Resource } from "@/core/types";
import type { RecommendedAction } from "@/core/brief";
import type { PenaltyView } from "@/core/workspace";
import { useWorkspaceStore } from "@/core/workspace/store";
import { ActionCard, ClaimTierProvider, downloadMarkdownBrief, GfmSection, GradeChip, SectionIndex, sectionThemeOf, StateNote, type ClaimTierMap } from "@/ui";
import { AtAGlanceCard, BriefContextCallout, commonActionCardProps, CrossPageSection, crossPagePresence, DetailLayout, DetailMasthead, DetailPageWrapper, DetailRail, DetailSection, FactBlocks, PendingTriggers, pendingTriggers, ImpactRailCard, InThisListStat, ItemConnections, RecordFacts, RelevanceRailCard, RequirementTrajectory, SourcesGrid, topRecommendedAction, type CrossPageData, type DetailSurfaceSharedProps } from "@/ui/detail";
import { LegendRailCard } from "@/ui/list-surface";
import { DetailTagRow } from "@/features/workspace/ui/DetailTagRow";
import { DetailWatch } from "@/features/workspace/ui/DetailWatch";

import { OwnerCard } from "./OwnerCard";
import { PriorityMenu } from "./PriorityMenu";
import { regulationMeta } from "./meta";
import type { RelevanceFetch } from "./useItemRelevance";

export interface ObligationEvent { intelligence_item_id?: string; event_date: string; event_kind: string; obligation_text?: string | null; source_span?: string | null }
interface Props extends Omit<DetailSurfaceSharedProps, "relevance"> {
  resource: Resource; changelog: ChangeLogEntry[]; dispute: Dispute | null; sections: SectionRow[]; claimTiers: ClaimTierMap;
  /** The claims or their suppressions did not load: the page says so with Retry and draws no fact section. */
  claimsDegraded?: boolean; recommendedActions: RecommendedAction[]; crossPage: CrossPageData; events: ObligationEvent[]; eventsFailed: boolean;
  kindLabels: Record<string, string>; relevance: RelevanceFetch & { retry: () => void }; hasWorkspace: boolean; nowIso: string;
}

/** The heading each fact-document section renders under; the key is the document's own section number. */
const HEADINGS: Record<string, string> = { "3": "Obligations — issues requiring action", "4": "Compliance chain", "8": "Substantive requirements", "10": "Registration and reporting", "11": "Operational requirements", "1": "Purpose and scope", "2": "What this regulation is and why it applies", "5": "Authoritative guidance analysis", "6": "Anticipated guidance and pending events", "7": "Threshold questions", "9": "Product-specific compliance status", "12": "Exemptions and edge cases", "13": "Adjacent research and alternatives" };
const hasPenalties = (r: Resource): boolean => !!(r.penaltyRange || r.costMechanism || r.enforcementBody);

function regenLabel(iso: string | null | undefined, nowIso: string): string | null {
  if (!iso) return null;
  const days = Math.floor((Date.parse(nowIso) - Date.parse(iso)) / 86_400_000);
  return days >= 0 && days <= 30 ? formatDate(iso.slice(0, 10)) : null;
}

function sectionPreview(markdown: string | undefined): string {
  if (!markdown) return "Full statutory analysis and verbatim source clauses";
  const cleanedMd = markdown.replace(/<!--[\s\S]*?-->/g, "").replace(/[«»]/g, "");
  const bullets = (cleanedMd.match(/^\s*[-*]\s+/gm) ?? []).length;
  const firstClean = cleanedMd.split(/\r?\n/).map((line) => line.replace(/^[#*\-\s>+]+/, "").replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim()).find((line) => line.length > 24 && !/^table of contents/i.test(line));
  const prefix = bullets > 0 ? `${bullets} provision${bullets === 1 ? "" : "s"} · ` : "";
  if (!firstClean) return `${prefix}Full statutory analysis and verbatim clauses`;
  return `${prefix}${firstClean.length > 105 ? `${firstClean.slice(0, 104).replace(/\s+\S*$/, "")}…` : firstClean}`;
}

export function RegulationDetail(p: Props) {
  const { resource: r, nowIso } = p;
  const router = useRouter();
  const isAdminViewer = ["owner", "admin"].includes(useWorkspaceStore((s) => s.userRole) ?? "");
  const band = bandFromPriority(r.priority);
  const { jurisLabel, dek } = regulationMeta(r);
  const isRecord = r.itemGrade === "record";
  const [depth, setDepth] = useState<"summary" | "full">("summary");
  const [tagOpen, setTagOpen] = useState(false);
  const rows = useMemo(() => sourceEntriesOf(r), [r]);
  const pendingEvents = useMemo(() => pendingTriggers(p.events), [p.events]);
  const stored = useMemo(() => new Map(p.sections.filter((s) => s.section_key in HEADINGS && (s.content_md || "").trim()).map((s) => [s.section_key, s])), [p.sections]);
  const hasPendingSection = stored.has("6") || !!r.doesNotResolve || pendingEvents.length > 0;
  const factSections = isRecord ? [] : SECTION_INDEX.filter((e) => e.key && (stored.has(e.key) || (e.key === "6" && hasPendingSection)));
  const unparsedBrief = !isRecord && factSections.length === 0 && r.fullBrief ? stripSourcesSection(r.fullBrief) : "";
  const presence = crossPagePresence(p.crossPage);
  // D4: the instrument's penalty objects are read first (the object is canonical); the brief's penalty fields answer only when no penalty object exists
  const penalties = p.relevance.phase === "ready" ? (p.relevance.data.binding?.penalties ?? []) : [];
  const present = new Set(["summary", "sources", ...(penalties.length || hasPenalties(r) ? ["penalties"] : []), ...factSections.map((e) => e.id), ...(presence.connected ? [CONNECTED_SECTION_ID] : []), ...(presence.inferences ? [INFERENCES_SECTION_ID] : [])]);
  const index = indexFor(present);
  const parsed = useMemo(() => (isRecord ? parseRecordSections(p.sections, p.claimTiers) : null), [isRecord, p.sections, p.claimTiers]);
  const split = parsed ? splitKeyDateFacts(parsed.facts) : { dateFacts: [], otherFacts: [] };
  const timeline = useMemo(() => withObligationEvents(r.timeline ?? [], p.events, p.kindLabels), [r.timeline, p.events, p.kindLabels]);
  const regen = regenLabel(r.lastRegeneratedAt, nowIso);
  const trajectory = r.requirementTrajectory?.steps?.length ? <RequirementTrajectory trajectory={r.requirementTrajectory} nowIso={nowIso} /> : null;
  const sourceCount = rows.length;
  const meta = [sourceCount > 0 ? `${sourceCount} source${sourceCount === 1 ? "" : "s"}${typeof r.sourceTier === "number" ? ` · T${r.sourceTier} primary` : ""}` : null, regen ? `regenerated ${regen}` : null].filter(Boolean).join(" · ") || null;
  const actionCard = (
    <ActionCard
      bare band={band} kindLabel="Regulation" nowIso={nowIso} extraChips={<GradeChip itemGrade={r.itemGrade} />} tier={typeof r.sourceTier === "number" ? r.sourceTier : null} biasTags={r.biasTags} meta={meta}
      onExport={() => void downloadMarkdownBrief(r, { filenamePrefix: "regulation", metaRows: [r.jurisdiction ? `- Jurisdiction: ${r.jurisdiction}` : null, r.priority ? `- Priority: ${r.priority}` : null, r.complianceDeadline ? `- Compliance deadline: ${r.complianceDeadline}` : null, r.url ? `- Source: ${r.url}` : null] })}
      {...commonActionCardProps(r, { tagPopover: <DetailTagRow itemId={r.id} open={tagOpen} onOpenChange={setTagOpen} />, watch: <DetailWatch type="reg" id={r.id} />, onTag: () => setTagOpen((v) => !v), relevance: p.relevance.phase === "ready" ? p.relevance.data.relevance : null })}
      where={{ value: [r.sub || r.topic, jurisLabel].filter(Boolean).join(" · ") || null }} timeline={timeline} moreMarkersHref="#obligation-register" overflow={<PriorityMenu itemId={r.id} title={r.title} priority={r.priority} archivable />}
    />
  );
  const directoryItems = [
    ...factSections.filter((e) => e.key !== "3").map((e) => ({ id: e.id, ord: e.ord ?? 99, name: HEADINGS[e.key as string] as string, desc: sectionPreview(stored.get(e.key as string)?.content_md) })),
    ...(penalties.length > 0 || hasPenalties(r) ? [{ id: "penalties", ord: 7, name: "Penalties & Enforcement", desc: penalties.length > 0 ? `${penalties.length} statutory sanction & penalty schedule${penalties.length === 1 ? "" : "s"}` : [r.penaltyRange, r.enforcementBody].filter(Boolean).join(" · ") || "Statutory enforcement provisions" }] : []),
    { id: "sources", ord: 8, name: "Primary & Secondary Sources", desc: `${rows.length} captured source document${rows.length === 1 ? "" : "s"} with provenance tier ratings` },
  ].sort((a, b) => a.ord - b.ord);

  return (
    <ClaimTierProvider claimTiers={p.claimTiers}>
      <div style={{ paddingTop: "var(--sp-16)" }}>
        <DetailPageWrapper itemId={r.itemUuid ?? r.id} band={band} action={topRecommendedAction(p.recommendedActions)} nowIso={nowIso} footer={<CrossPageSection surfaceKey="regulations" surfaceLabel="Regulations" crossPage={p.crossPage} onRetry={() => router.refresh()} kindLabels={p.kindLabels ?? {}} />}>
          <DetailMasthead title={r.title} band={band} surface="Regulations" jurisdiction={jurisLabel} dek={dek} placeholder="Ask about this regulation, e.g. when does the largest deadline hit" nowIso={nowIso} actionSlot={actionCard} connectionsSlot={p.connectionRows && p.connectionRows.length > 0 ? <ItemConnections rows={p.connectionRows} /> : undefined} />
          {isAdminViewer && r.agentIntegrityFlag === true && r.agentIntegrityPhrase && <StateNote tone="error">Flagged for review: the brief carries the phrase “{r.agentIntegrityPhrase}”.</StateNote>}
          {p.claimsDegraded && <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>The facts of this regulation did not load, so none is shown. Nothing was changed; try again.</StateNote>}
          {p.eventsFailed && <StateNote tone="error" action={{ label: "Retry", onClick: () => router.refresh() }}>The dated obligations did not load, so the timeline shows only the stored milestones.</StateNote>}
          <SectionIndex sections={index} depth={depth} onDepthChange={setDepth} />
          <DetailLayout
            rail={
              <DetailRail
                atAGlance={<AtAGlanceCard rows={[{ label: "Instrument", value: r.legalInstrument }, { label: "Topic", value: r.topic }, { label: "Deadline", value: r.complianceDeadline ? formatDate(r.complianceDeadline) : null }, { label: "Penalty", value: r.penaltyRange ?? null }, { label: "Cost mechanism", value: r.costMechanism ?? null }, { label: "Enforcement", value: r.enforcementBody ?? null }]} />}
                impact={<ImpactRailCard scores={r.impactScores ?? null} absence={r.impactAbsence} reasoning={r.impactReasoning || r.reasoning} />}
                relevance={<RelevanceRailCard state={p.relevance.phase === "ready" ? { phase: "ready", relevance: p.relevance.data.relevance } : p.relevance.phase === "failed" ? { phase: "failed", retry: p.relevance.retry } : { phase: "loading" }} />}
                designed={<><OwnerCard itemId={r.id} assigneeName={r.actionOwner ?? null} lastVerifiedDate={r.lastVerifiedDate ?? null} hasWorkspace={p.hasWorkspace} /><InThisListStat backHref="/regulations" backLabel="Back to list" band={band} /></>}
                legend={<LegendRailCard />}
              />
            }
          >
            <DetailSection id="summary" title="Summary" aside={isRecord ? undefined : "Generated · 30-second read"} index={1}>
              {isRecord ? (
                <RecordFacts leadNote="This item was captured directly from its source document rather than synthesized into a brief. Every fact below is quoted verbatim from that source." dateFacts={split.dateFacts} otherFacts={split.otherFacts} gapsLine={parsed && parsed.slotFieldCount > 0 ? <>{`${parsed.gaps.length} of ${parsed.slotFieldCount} record fields not stated by the source`}{parsed.gaps.map((g) => <span key={g.slotKey} style={{ display: "block" }}>{g.label}: {g.text}</span>)}</> : undefined} tags={r.tags} />
              ) : (
                <BriefSummary r={r} changelog={p.changelog} dispute={p.dispute} trajectory={trajectory || r.conversionTrigger || null} doesNotResolve={r.doesNotResolve} pendingEvents={pendingEvents} kindLabels={p.kindLabels} />
              )}
              {depth === "full" && unparsedBrief && <div style={{ marginTop: "var(--sp-16)", paddingTop: "var(--sp-14)", borderTop: "1px solid var(--line-3)" }}><GfmSection markdown={unparsedBrief} /></div>}
            </DetailSection>
            {factSections.filter((e) => depth === "full" || e.key === "3").map((e) => {
              const storedContent = stored.get(e.key as string)?.content_md;
              return (
                <DetailSection key={e.id} id={e.id} title={HEADINGS[e.key as string] as string} aside={e.key === "3" && depth === "summary" ? "Top priority group · switch to Full brief for all sections" : undefined} index={e.ord ?? null}>
                  {storedContent ? <FactBlocks markdown={storedContent} {...(depth === "summary" ? { maxGroups: 1 } : {})} /> : e.key === "6" ? <p className="cl-detail-link-note">Pending regulatory triggers and unresolved items are summarized in S1 Summary above.</p> : null}
                </DetailSection>
              );
            })}
            {depth === "summary" && !isRecord && (
              <div className="cl-brief-directory">
                <div className="cl-brief-directory-head"><div><p className="cl-brief-directory-title">Full Statutory Breakdown Directory</p><p className="cl-brief-directory-sub">Summary view shows S1 Summary and the top-priority S2 Obligations group. Click any section below to open the complete statutory dossier at that section.</p></div></div>
                <div className="cl-brief-directory-grid">
                  {directoryItems.map((item) => (
                    <button key={item.id} type="button" data-audit="disclosure-row" data-sec-theme={sectionThemeOf(item.id)} className="cl-brief-directory-card" onClick={() => { setDepth("full"); requestAnimationFrame(() => document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" })); }}>
                      <span className="cl-brief-directory-card-top"><span className="cl-brief-directory-card-ord">{`S${item.ord}`}</span><span className="cl-brief-directory-card-name">{item.name}</span></span>
                      <span className="cl-brief-directory-card-desc">{item.desc}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {depth === "full" && (penalties.length > 0 || hasPenalties(r)) && <DetailSection id="penalties" title="Penalties" aside={penalties.length ? "From the obligations" : "From the regulatory brief"} index={7}>{penalties.length ? <PenaltyObjects views={penalties} /> : <PenaltyFacts r={r} />}</DetailSection>}
            {depth === "full" && <DetailSection id="sources" title="Sources" aside={rows.length > 0 ? `${rows.length} · tier = provenance, never urgency` : undefined} index={8}>{rows.length > 0 ? <SourcesGrid rows={rows} /> : <StateNote>No sources are listed for this item.</StateNote>}</DetailSection>}
          </DetailLayout>
        </DetailPageWrapper>
      </div>
    </ClaimTierProvider>
  );
}

const FACT_ROW = { display: "flex", justifyContent: "space-between", gap: "var(--sp-12)", fontSize: "var(--fs-13)" } as const;
/** One block per penalty object: the pinpoint, then its columns as labelled rows (the labels are the section's, the values the object's own). */
function PenaltyObjects({ views }: { views: readonly PenaltyView[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-14)" }}>
      {views.map((v) => {
        const rows: Array<[string, string]> = [v.sanction ? ["Sanction", v.sanction] : null, v.maximum ? ["Penalty amount", v.maximum] : null, v.formula ? ["Formula", v.formula] : null, ...v.basis.map((b): [string, string] => ["Schedule", b]), v.start ? ["Enforcement start", formatDate(v.start)] : null].filter((x): x is [string, string] => x !== null);
        return (
          <div key={v.pinpoint} style={{ display: "flex", flexDirection: "column", gap: "var(--sp-6)" }}>
            <p className="cl-detail-label">{v.pinpoint}</p>
            {rows.map(([label, value], i) => <div key={`${label}${i}`} style={FACT_ROW}><span style={{ color: "var(--ink-3)", fontWeight: 700 }}>{label}</span><span style={{ color: "var(--ink)", textAlign: "right", overflowWrap: "anywhere" }}>{value}</span></div>)}
          </div>
        );
      })}
    </div>
  );
}

function PenaltyFacts({ r }: { r: Resource }) {
  const rows: Array<[string, string]> = [r.penaltyRange ? ["Penalty amount", r.penaltyRange] : null, r.costMechanism ? ["Cost mechanism", r.costMechanism] : null, r.enforcementBody ? ["Enforcement body", r.enforcementBody] : null, r.complianceDeadline ? ["Compliance deadline", r.complianceDeadline] : null].filter((x): x is [string, string] => x !== null);
  return <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-8)" }}>{rows.map(([label, value]) => <div key={label} style={FACT_ROW}><span style={{ color: "var(--ink-3)", fontWeight: 700 }}>{label}</span><span style={{ color: "var(--ink)", textAlign: "right" }}>{value}</span></div>)}</div>;
}

function BriefSummary({ r, changelog, dispute, trajectory, doesNotResolve, pendingEvents = [], kindLabels = {} }: { r: Resource; changelog: ChangeLogEntry[]; dispute: Dispute | null; trajectory?: ReactNode; doesNotResolve?: string | undefined; pendingEvents?: ObligationEvent[]; kindLabels?: Record<string, string> }) {
  const shortText = r.whatIsIt || r.note || "";
  if (!shortText && !r.fullBrief) return <StateNote>The narrative brief for this regulation has not been written yet. The details elsewhere on this page are accurate.</StateNote>;
  const changes = changelog.map((c) => c.impact).filter((s): s is string => !!s && !/^brief regenerated from the item's held sources\.?$/i.test(s.trim()));
  const hasSubcards = !!trajectory || changes.length > 0 || !!doesNotResolve;
  return (
    <>
      {shortText && <p className="cl-summary-lead">{shortText}</p>}
      <BriefContextCallout r={r} />
      {hasSubcards && (
        <div className="cl-summary-grid">
          {trajectory && <div className="cl-summary-subcard"><p className="cl-summary-subcard-title">Trajectory</p><div className="cl-summary-subcard-body">{trajectory}</div></div>}
          {changes.length > 0 && <div className="cl-summary-subcard cl-summary-subcard--changed"><p className="cl-summary-subcard-title">What changed</p>{changes.slice(0, 3).map((s, i) => <p key={i} className="cl-summary-subcard-body">{s}</p>)}</div>}
          {doesNotResolve && <div className="cl-summary-subcard cl-summary-subcard--unresolved"><p className="cl-summary-subcard-title">What does not resolve</p><p className="cl-summary-subcard-body">{doesNotResolve}</p></div>}
        </div>
      )}
      {dispute?.note && <div style={{ marginTop: "var(--sp-12)" }}><StateNote>{dispute.note}</StateNote></div>}
      <PendingTriggers events={pendingEvents} kindLabels={kindLabels} />
    </>
  );
}
