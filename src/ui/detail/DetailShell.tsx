"use client";

// Ported from old_repo/src/components/detail/DetailShell.tsx (lines 69-628)
// The frame every detail page shares: the masthead with its list-position breadcrumb, the section frame (S-ordinal head, 72ch body), the layout with its 300 px rail, the rail cards callers
// pass only the drawable rows to, "In this list" with prev and next, and the page wrapper that mounts the workspace notes and assignments. The depth switch, the scroll spy and the legend
// are the kit's. Nothing reads the clock.
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import type { RecommendedAction } from "@/core/brief";
import { normalizeDisplayTitle } from "@/core/fetch/titles";
import type { UrgencyBand } from "@/core/lists";
import { displayTitle } from "@/core/lists/display-title";
import { itemIdFromDetailPath } from "@/core/workspace/paths";
import type { ImpactScores } from "@/core/types";

import { ImpactMeter } from "../ImpactMeter";
import { Masthead } from "../Masthead";
import { SectionCard } from "../SectionCard";
import { SectionHead } from "../SectionHead";
import { ShellCommandBar } from "../shell/CommandBar";
import { useBootstrapStore } from "../shell/use-bootstrap";
import { RailCard } from "../SmallParts";
import { BandProvider, useBandContext } from "../StateNote";

import { ItemAssignBlock } from "./collab/ItemAssignBlock";
import { ItemNotesBlock } from "./collab/ItemNotesBlock";
import { neighbourHref, useListPosition } from "./useListPosition";

/** The masthead of a detail page: the title, the breadcrumb ("surface / jurisdiction / 3 of 22 in Immediate" when the list rode along), the command bar, and the two card slots. */
export function DetailMasthead({ title, band, surface, jurisdiction, dek, placeholder, nowIso, actionSlot, connectionsSlot }: { title: string; band: UrgencyBand; surface: string; jurisdiction?: string; dek?: ReactNode; placeholder: string; nowIso: string; actionSlot?: ReactNode; connectionsSlot?: ReactNode }) {
  const position = useListPosition();
  const base = [surface, jurisdiction].filter(Boolean).join(" / ");
  // ROWS-1: the page title is the short name the list row drew; the full official title (with its annex note) is shown once, under it. A title with no short form is the page title as stored.
  const official = normalizeDisplayTitle(title);
  const short = displayTitle(official.title, true);
  const full = short === official.title ? null : [official.title, official.subtitle].filter(Boolean).join(" · ");
  return (
    <div className="cl-detail-mast">
      <Masthead title={full ? short : title} size="detail" dateLabel={position.known ? `${base} / ${position.pos} of ${position.of} in ${band.label}` : base} nowIso={nowIso} dek={full ? <><p className="cl-masthead-official">{full}</p>{dek}</> : dek} commandBar={<ShellCommandBar placeholder={placeholder} />} actionSlot={actionSlot} connectionsSlot={connectionsSlot} />
    </div>
  );
}

/** One S-section: the numbered head on the band tint, the body capped at 72 characters. */
export function DetailSection({ id, title, aside, index, children }: { id: string; title: string; aside?: ReactNode; index?: number | null | undefined; children: ReactNode }) {
  const { band } = useBandContext();
  return (
    <SectionCard as="section" id={id} padding="0" className="cl-detail-section">
      <div className="cl-detail-section-head" data-audit="detail-section-head" style={band ? ({ ["--cl-detail-head-tint" as string]: band.tintCssVar } as React.CSSProperties) : undefined}>
        <SectionHead index={index != null ? `S${index}` : null} title={title} aside={aside} padding="section" size="detail" rule />
      </div>
      <div className="cl-detail-section-body">{children}</div>
    </SectionCard>
  );
}

export function DetailLayout({ children, rail }: { children: ReactNode; rail: ReactNode }) {
  return (
    <div className="cl-detail-layout">
      <div style={{ minWidth: 0 }}>{children}</div>
      <div data-audit="detail-rail" className="cl-detail-rail">
        {rail}
      </div>
    </div>
  );
}

/** The workspace's notes and assignments at the foot of every detail page; absent until the roster has loaded (a degraded roster shows no half-block). */
function ItemCollabSlot({ todayIso }: { todayIso: string }) {
  const itemId = itemIdFromDetailPath(usePathname());
  const members = useBootstrapStore((s) => s.data?.members);
  if (!itemId || members == null) return null;
  return (
    <DetailLayout rail={null}>
      <DetailSection id="notes" title="Notes" aside="Visible to your workspace only">
        <ItemNotesBlock itemId={itemId} />
      </DetailSection>
      <DetailSection id="assignments" title="Assignments" aside="Assign teammates, with a notification">
        <ItemAssignBlock itemId={itemId} todayIso={todayIso} />
      </DetailSection>
    </DetailLayout>
  );
}

export function DetailPageWrapper({ children, band = null, action = null, nowIso }: { children: ReactNode; band?: UrgencyBand | null; action?: string | null; nowIso: string }) {
  return (
    <BandProvider band={band} action={action}>
      <div className="cl-detail-wrap">
        {children}
        <ItemCollabSlot todayIso={nowIso} />
      </div>
    </BandProvider>
  );
}

/** The action to do first: the extractor's list in its order, the soonest timeframe first. */
export function topRecommendedAction(actions: readonly RecommendedAction[] | null | undefined): string | null {
  const sorted = [...(actions ?? [])].sort((a, b) => (a.timeframe_days ?? 1e9) - (b.timeframe_days ?? 1e9));
  return sorted.find((a) => a.action_text && a.action_text.trim())?.action_text.trim() ?? null;
}

export function DetailRail({ atAGlance, impact, relevance, designed, legend, undesigned }: { atAGlance?: ReactNode; impact?: ReactNode; relevance?: ReactNode; designed?: ReactNode; legend?: ReactNode; undesigned?: ReactNode }) {
  return (
    <>
      {atAGlance}
      {impact}
      {relevance}
      {designed}
      {legend}
      {undesigned}
    </>
  );
}

const MASTHEAD_FIELDS: ReadonlySet<string> = new Set(["band", "type", "kind", "jurisdiction", "region", "source", "published"]);
/** "At a glance": the rows the caller passes that the rail may draw. The masthead already states band, type, jurisdiction, source and date; a caller passes none of those (RegulationDetail is tested to pass only drawable rows). */
export function AtAGlanceCard({ rows }: { rows: Array<{ label: string; value: ReactNode }> }) {
  const present = rows.filter((r) => r.value !== null && r.value !== undefined && r.value !== "" && !MASTHEAD_FIELDS.has(r.label.trim().toLowerCase()));
  if (present.length === 0) return null;
  return (
    <RailCard title="At a glance" dataAudit="at-a-glance-rail">
      <div className="cl-glance">
        {present.map((r) => (
          <div key={r.label} style={{ display: "contents" }}>
            <span className="cl-glance-k">{r.label}</span>
            <span className="cl-glance-v">{r.value}</span>
          </div>
        ))}
      </div>
    </RailCard>
  );
}

/** The impact card: the scores, or the dash with the sentence of the input they wait for (the list row no longer draws either). */
export const ImpactRailCard = ({ scores, absence }: { scores?: ImpactScores | null; absence?: string | undefined }) => (
  <RailCard title="Impact assessment" dataAudit="impact-assessment-rail">
    <ImpactMeter scores={scores} absence={absence} valueVisible />
  </RailCard>
);

/** "In this list": N of M in the band, the way back, prev and next; an item opened directly says the position is not known. */
export function InThisListStat({ backHref, backLabel, band }: { backHref: string; backLabel: string; band?: UrgencyBand }) {
  const position = useListPosition();
  const pathname = usePathname();
  const base = pathname ? pathname.replace(/\/[^/]*$/, "") : "";
  const prev = neighbourHref(base, position, -1);
  const next = neighbourHref(base, position, 1);
  return (
    <RailCard title={`In this list${position.list ? ` · ${position.list}` : ""}`} dataAudit="in-this-list-rail">
      <p style={{ fontSize: "var(--fs-13)", color: "var(--ink)", margin: "0 0 var(--sp-8)" }}>{position.known ? `${position.pos} of ${position.of}${band ? ` in ${band.label}` : ""}` : "Opened directly"}</p>
      <div className="cl-rail-links">
        <Link href={backHref} prefetch={false} className="cl-rail-link">
          {backLabel}
        </Link>
        {prev && (
          <Link href={prev} prefetch={false} className="cl-rail-link cl-rail-link--quiet">
            {"‹ prev"}
          </Link>
        )}
        {next && (
          <Link href={next} prefetch={false} className="cl-rail-link cl-rail-link--quiet">
            {"next ›"}
          </Link>
        )}
      </div>
    </RailCard>
  );
}
