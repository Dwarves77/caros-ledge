// Ported from old_repo/src/components/ui/ListRow.tsx (lines 52-137)
// Ported from old_repo/src/components/ui/ListRow.tsx (lines 555-555)
// Ported from old_repo/src/components/ui/ListRow.tsx (lines 713-985)
// The one list row. Class names only: every layout rule lives once in base.css, so a 100-row list carries the CSS once (the old row emitted 13.6 KB per instance).
import Link from "next/link";
import type { ReactNode } from "react";

import { hasBiasTags, type BiasTagInput } from "@/core/sources";
import type { UrgencyBand } from "@/core/lists";
import type { ImpactScores, TimelineEntry } from "@/core/types";

import { Absence } from "./Absence";
import { pickAbsenceReason, type AbsenceReason } from "./absence-reason";
import { BiasChips } from "./BiasChips";
import { GradeChip, TagChip, TierChip, WorkspaceTagPill } from "./Chips";
import { ImpactMeter } from "./ImpactMeter";
import { isImpactScored } from "./impact";
import { MilestoneTimeline } from "./MilestoneTimeline";

export interface ListRowProps {
  /** Where the row opens; absent for a row with no page (a watched source), which draws as a row without the link layer. */
  href?: string | undefined;
  band: UrgencyBand;
  jurisdiction: string;
  title: string;
  meta?: ReactNode;
  kind?: ReactNode;
  impact?: ImpactScores | null;
  due?: { label: string; days: string } | null;
  timeline?: TimelineEntry[] | null;
  tier?: number | null;
  /** The last control in the row (the watch star or the overflow menu); it never shares a box with the row link. */
  overflow?: ReactNode;
  tags?: { id: string; name: string; title?: string }[] | null;
  biasTags?: BiasTagInput[] | null;
  itemGrade?: "record" | "brief" | undefined;
  minHeight?: number;
}

/**
 * The list row: spine, jurisdiction, title with a meta line (kind, grade, meta text, the ONE absence reason, bias chips, tags), impact, due with days,
 * timeline, tier and a 44 px overflow cell. The whole row is one link. Phone, tablet, mid and wide layouts and the narrow-box reflow are in base.css.
 */
export function ListRow({ href, band, jurisdiction, title, meta, kind, impact, due, timeline, tier, overflow, tags, biasTags, itemGrade, minHeight = 56 }: ListRowProps) {
  const hasBias = hasBiasTags(biasTags);
  const isRecord = itemGrade === "record";
  const rowAbsence: AbsenceReason | null = pickAbsenceReason([tier == null ? "not in primary source" : null, !due || !isImpactScored(impact) ? "pending" : null]);
  const hasTags = !!tags && tags.length > 0;
  return (
    <div className="cl-list-row" data-part="list-row" data-part-variant="list" style={{ minHeight, ["--row-band" as string]: band.cssVar }}>
      <span className="cl-row-spine" aria-hidden="true" style={{ background: band.cssVar }} />
      {href && <Link href={href} prefetch={false} className="cl-row-link" aria-label={title} />}
      <div className="cl-row-content">
        <div className="cl-row-line1">
          <span className="cl-row-juris">{jurisdiction}</span>
          <span className="cl-row-title">
            <span data-guard-title className="cl-row-title-text">
              {title}
            </span>
            {(meta || kind || rowAbsence || hasBias || isRecord || hasTags) && (
              <span className="cl-row-meta-tags">
                {kind && <TagChip variant="row">{kind}</TagChip>}
                {isRecord && (
                  <span className="cl-row-grade-desktop">
                    <GradeChip itemGrade={itemGrade} />
                  </span>
                )}
                {meta && <span className="cl-row-meta-text">{meta}</span>}
                {rowAbsence && (
                  <span className="cl-row-absence-slot">
                    <Absence reason={rowAbsence} />
                  </span>
                )}
                {hasBias && (
                  <span className="cl-row-bias-desktop">
                    <BiasChips tags={biasTags} variant="row" />
                  </span>
                )}
                {hasTags && (
                  <span className="cl-row-tags">
                    {tags.map((t) => (
                      <WorkspaceTagPill key={t.id} name={t.name} {...(t.title ? { title: t.title } : {})} />
                    ))}
                  </span>
                )}
              </span>
            )}
          </span>
        </div>
        <div className="cl-row-line2">
          {isRecord && (
            <span className="cl-row-grade-mobile">
              <GradeChip itemGrade={itemGrade} />
            </span>
          )}
          <span className="cl-row-impact">
            <ImpactMeter scores={impact} />
          </span>
          <span className="cl-row-due">
            {due ? (
              <>
                <span className="cl-row-due-label">{due.label}</span>
                <span className="cl-row-due-days">{due.days}</span>
              </>
            ) : (
              <span className="cl-row-due-dash">
                <Absence reason={rowAbsence ?? "pending"} variant="dash" />
              </span>
            )}
          </span>
          <span className="cl-row-timeline">
            <MilestoneTimeline entries={timeline} bandHex={band.hex} />
          </span>
          <span className="cl-row-tier">{tier != null ? <TierChip tier={tier} /> : <Absence reason={rowAbsence ?? "not in primary source"} variant="dash" />}</span>
          {hasTags && (
            <span className="cl-row-tags-mobile">
              {tags.map((t) => (
                <WorkspaceTagPill key={`m-${t.id}`} name={t.name} {...(t.title ? { title: t.title } : {})} />
              ))}
            </span>
          )}
          {hasBias && (
            <span className="cl-row-bias-mobile">
              <BiasChips tags={biasTags} variant="row" wrap />
            </span>
          )}
          <span className="cl-row-overflow">{overflow}</span>
        </div>
      </div>
    </div>
  );
}

/** The list column header on the one grid: hidden when the rows stack. */
export function ListRowHeader({ dueLabel = "Due", titleLabel = "Title" }: { dueLabel?: string; titleLabel?: string }) {
  const cells: Array<[string, string?]> = [["Juris."], [titleLabel], ["Impact"], [dueLabel, "cl-row-header-end"], ["Timeline"], ["Tier"]];
  return (
    <div className="cl-list-row-header" data-part="list-row-header">
      <span aria-hidden="true" />
      {cells.map(([label, cls]) => (
        <span key={label} data-part-slot="column-label" className={cls ?? ""}>
          {label}
        </span>
      ))}
      <span aria-hidden="true" />
    </div>
  );
}
