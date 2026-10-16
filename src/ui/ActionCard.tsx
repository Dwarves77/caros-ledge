"use client";

// Ported from old_repo/src/components/ui/ActionCard.tsx (lines 42-308)
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { UrgencyBand } from "@/core/lists";
import type { BiasTagInput } from "@/core/sources/bias-tags";
import { hasBiasTags } from "@/core/sources/bias-tags";
import type { TimelineEntry } from "@/core/types";

import { Absence } from "./Absence";
import type { AbsenceReason } from "./absence";
import { ActionRow } from "./ActionRow";
import { BiasChips } from "./BiasChips";
import { BandChip, TagChip, TierChip, WorkspaceTagPill } from "./Chips";
import { SectionCard } from "./SectionCard";
import { SectionLabel } from "./SectionLabel";
import { Timeline } from "./Timeline";
import { classifyMilestones, nextMilestoneClause } from "./timeline-math";

interface Exposure {
  value: ReactNode;
  absenceReason?: AbsenceReason;
}

interface ActionCardProps {
  band: UrgencyBand;
  kindLabel: string;
  /** The render instant (ISO date), required: no render reads a clock. */
  nowIso: string;
  extraChips?: ReactNode;
  tier?: number | null | undefined;
  biasTags?: BiasTagInput[] | null | undefined;
  meta?: string | null | undefined;
  tags?: string[] | null | undefined;
  tagPopover?: ReactNode;
  onExport: () => void;
  onShare: () => void;
  watch: ReactNode;
  onTag?: (() => void) | undefined;
  exportDisabled?: boolean | undefined;
  overflow?: ReactNode;
  viewer?: boolean;
  where: Exposure;
  whoPays: Exposure;
  yourLanes: Exposure;
  timeline?: TimelineEntry[] | null | undefined;
  onFullSchedule?: () => void;
  fullScheduleHref?: string;
  moreMarkersHref?: string;
  bare?: boolean;
}

/** One exposure cell: three lines then "Show more". The overflow is re-measured when the cell resizes, so a viewport change cannot leave a stale button. */
function ExposureCell({ label, cell }: { label: string; cell: Exposure }) {
  const hasValue = cell.value !== null && cell.value !== undefined && cell.value !== "";
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cell.value, expanded]);
  return (
    <div className="cl-exposure-cell">
      <p className="cl-exposure-label">{label}</p>
      <div ref={ref} data-audit="exposure-value" className={`cl-exposure-value${expanded ? "" : " cl-clamp-3"}`}>
        {hasValue ? cell.value : <Absence reason={cell.absenceReason ?? "not in primary source"} />}
      </div>
      {hasValue && (overflowing || expanded) && (
        <button type="button" data-audit="exposure-expand" onClick={() => setExpanded((v) => !v)} className="cl-exposure-expand">
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** The one detail action card: pill row, bias row, tags, the action row, the exposure cells and the timeline. */
export function ActionCard({ band, kindLabel, nowIso, extraChips, tier, biasTags, meta, tags, tagPopover, onExport, onShare, watch, onTag, exportDisabled, overflow, viewer, where, whoPays, yourLanes, timeline, onFullSchedule, fullScheduleHref, moreMarkersHref, bare = false }: ActionCardProps) {
  const nextClause = nextMilestoneClause(classifyMilestones(timeline ?? []), nowIso);
  const hasTags = !!tags && tags.length > 0;
  const content = (
    <>
      <div className="cl-ac-pills">
        <div className="cl-ac-pills-main">
          <BandChip band={band} withWindow />
          <TagChip>{kindLabel}</TagChip>
          {extraChips}
          {typeof tier === "number" && <TierChip tier={tier} />}
        </div>
        {meta && <span className="cl-ac-meta">{meta}</span>}
      </div>
      {hasBiasTags(biasTags) && (
        <div className="cl-ac-row">
          <BiasChips tags={biasTags} variant="detail" label="Primary source" />
        </div>
      )}
      {hasTags && (
        <div className="cl-ac-tags">
          {tags.map((t) => (
            <WorkspaceTagPill key={t} name={t} />
          ))}
        </div>
      )}
      {tagPopover && <div style={{ marginTop: hasTags ? 8 : 10 }}>{tagPopover}</div>}
      <div className="cl-ac-actions">
        <ActionRow onExport={onExport} onShare={onShare} watch={watch} onTag={onTag} exportDisabled={exportDisabled} overflow={overflow} {...(viewer !== undefined ? { viewer } : {})} />
      </div>
      <div className="cl-ac-rule" aria-hidden="true" />
      <div>
        <div className="cl-ac-label">
          <SectionLabel>Exposure</SectionLabel>
        </div>
        <div className="cl-exposure-grid">
          <ExposureCell label="Where" cell={where} />
          <ExposureCell label="Who pays" cell={whoPays} />
          <ExposureCell label="Your lanes" cell={yourLanes} />
          <ExposureCell label="Next milestone" cell={nextClause ? { value: nextClause } : { value: null, absenceReason: "pending" }} />
        </div>
      </div>
      <div className="cl-ac-rule" aria-hidden="true" />
      <Timeline entries={timeline} band={band} nowIso={nowIso} {...(onFullSchedule ? { onFullSchedule } : {})} {...(fullScheduleHref ? { fullScheduleHref } : {})} {...(moreMarkersHref ? { moreMarkersHref } : {})} />
    </>
  );
  return bare ? (
    <div data-part="action-card" className="cl-ac-bare">
      {content}
    </div>
  ) : (
    <SectionCard as="section" dataAttributes={{ "data-part": "action-card" }} padding="16px 20px 18px">
      {content}
    </SectionCard>
  );
}
