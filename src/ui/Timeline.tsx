"use client";

// Ported from old_repo/src/components/ui/Timeline.tsx (lines 42-228)
// One markup: the track is a grid on the wide form (`--tl-n` columns, three rows) and a vertical stack below 768 px (base.css). No MatchMedia, no second tree.
import Link from "next/link";
import { useState } from "react";

import type { UrgencyBand } from "@/core/lists";
import type { TimelineEntry } from "@/core/types";

import { SectionLabel } from "./SectionLabel";
import { StateNote } from "./StateNote";
import { TimelineDot } from "./MilestoneTimeline";
import { classifyMilestones, collapseTimeline, formatDayMonthYear, greenPercent, milestoneStageOf, nextMilestoneClause, timelineHeaderCounts } from "./timeline-math";

interface TimelineProps {
  entries: TimelineEntry[] | null | undefined;
  band: UrgencyBand;
  /** The render instant (ISO date), required: the timeline reads no clock. */
  nowIso: string;
  onFullSchedule?: () => void;
  fullScheduleHref?: string;
  moreMarkersHref?: string;
}

const cleanLabel = (raw: string | undefined | null): string => {
  const s = (raw ?? "")
    .replace(/^\d{4}(?:-\d{2}){0,2}\s*[—–:\-]\s*(?:\d{4}(?:-\d{2}){0,2}\s*[—–:\-]\s*)?/, "")
    .trim()
    .replace(/\s+[a-zA-Z]{1,10}(?:\.{3}|…)$/, "…");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
};

export function Timeline({ entries, band, nowIso, onFullSchedule, fullScheduleHref, moreMarkersHref }: TimelineProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const list = entries ?? [];
  if (list.length === 0) {
    return (
      <div data-part="timeline">
        <div className="cl-tl-head"><SectionLabel>Timeline</SectionLabel></div>
        <span className="cl-timeline-empty cl-tl-empty" aria-hidden="true" />
      </div>
    );
  }
  const classified = classifyMilestones(list);
  const counts = timelineHeaderCounts(classified);
  const { visible, hiddenCount, collapsed } = collapseTimeline(classified);
  const clause = nextMilestoneClause(classified, nowIso);
  const lastDate = list[list.length - 1]?.date ?? "";
  const action = onFullSchedule ? { label: "Full schedule ↓", onClick: onFullSchedule } : fullScheduleHref ? { label: "Full schedule ↓", href: fullScheduleHref } : undefined;
  const selectedMilestone = selected !== null ? classified.find((c) => c.index === selected) : null;
  const selectedEntry = selectedMilestone?.entry ?? null;
  const parts = [`${counts.total} milestone${counts.total === 1 ? "" : "s"}`];
  if (counts.passed > 0) parts.push(`${counts.passed} passed`);
  if (counts.nextDate) parts.push(`next ${formatDayMonthYear(counts.nextDate)}`);

  return (
    <div data-part="timeline" className="cl-tl">
      <div className="cl-tl-head">
        <div className="cl-tl-head-left">
          <SectionLabel>Timeline</SectionLabel>
          <span className="cl-tl-counts">{parts.join(" · ")}</span>
        </div>
        <div className="cl-tl-head-right">
          {collapsed && hiddenCount > 0 && (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="cl-tl-more-btn" aria-expanded={showAll}>
              {showAll ? `Hide schedule (${counts.total}) ▴` : `All ${counts.total} milestones (+${hiddenCount} more) ▾`}
            </button>
          )}
          {moreMarkersHref && (
            <Link href={moreMarkersHref} prefetch={false} data-audit="timeline-more-markers" className="cl-tl-more cl-tl-more--link">
              Clause register ↓
            </Link>
          )}
        </div>
      </div>
      <div role="img" aria-label={`Milestone timeline: ${counts.total} milestones, ${counts.passed} passed`} className="cl-tl-track" style={{ ["--tl-n" as string]: visible.length, ["--tl-green" as string]: `${greenPercent(visible.map((c) => c.state))}%` }}>
        <div aria-hidden="true" className="cl-tl-line" />
        {visible.map(({ entry, state, index }, i) => {
          const displayLabel = cleanLabel(entry.label);
          const displayDate = formatDayMonthYear(entry.date);
          const stage = milestoneStageOf(entry);
          return (
            <button key={index} type="button" className="cl-tl-marker" data-state={state} aria-pressed={selected === index} aria-label={`${displayLabel} · ${displayDate}${stage ? ` · ${stage}` : ""}`} onClick={() => setSelected(selected === index ? null : index)} style={{ ["--c" as string]: i + 1 }}>
              <span className="cl-tl-date">{displayDate}{stage ? ` · ${stage}` : ""}</span>
              <span className="cl-tl-dotcell"><TimelineDot state={state} bandHex={band.hex} size={state === "next" ? 12 : 8} ring={3} /></span>
              <span title={displayLabel} className="cl-tl-label">{displayLabel}</span>
            </button>
          );
        })}
      </div>
      {showAll && (
        <div className="cl-tl-schedule" aria-label="Full milestone schedule">
          {classified.map(({ entry, state, index }) => {
            const stage = milestoneStageOf(entry);
            return (
              <button key={index} type="button" onClick={() => setSelected(selected === index ? null : index)} className={`cl-tl-schedule-row${state === "next" ? " cl-tl-schedule-row--next" : ""}`}>
                <TimelineDot state={state} bandHex={band.hex} size={state === "next" ? 10 : 8} ring={2} />
                <span className="cl-tl-schedule-date">{formatDayMonthYear(entry.date)}</span>
                <span className="cl-tl-schedule-label">{cleanLabel(entry.detail ?? entry.label)}</span>
                <span className={`cl-tl-schedule-badge cl-tl-schedule-badge--${state}`}>{stage ? `${stage} · ` : ""}{state === "passed" ? "Passed" : state === "next" ? "Next due" : "Upcoming"}</span>
              </button>
            );
          })}
        </div>
      )}
      {selectedEntry && (
        <div data-part="timeline-context" className="cl-tl-context">
          <div className="cl-tl-context-head">
            <span className="cl-tl-context-tag">{selectedEntry.date}{milestoneStageOf(selectedEntry) ? ` · ${milestoneStageOf(selectedEntry)}` : ""}</span>
            <button type="button" onClick={() => setSelected(null)} className="cl-tl-context-close" aria-label="Close milestone details">Close ✕</button>
          </div>
          <p className="cl-tl-context-body">{selectedEntry.detail ?? selectedEntry.label}</p>
          <div className="cl-tl-context-actions">
            <a href="#obligations" className="cl-tl-context-link cl-tl-context-link--brand">View in obligations ↓</a>
            <a href="#summary" className="cl-tl-context-link">Summary ↵</a>
            <a
              href={`?q=${encodeURIComponent(selectedEntry.date)}`}
              onClick={(e) => {
                const askInput = document.querySelector<HTMLInputElement>("input[data-guard-search], input[type='search']");
                if (askInput) { e.preventDefault(); askInput.value = selectedEntry.date; askInput.focus(); askInput.dispatchEvent(new Event("input", { bubbles: true })); }
              }}
              className="cl-tl-context-link"
            >
              Research {selectedEntry.date} →
            </a>
          </div>
        </div>
      )}
      {((clause && action) || (!clause && counts.total > 0)) && (
        <div className="cl-tl-callout">
          {clause && action ? (
            <StateNote band={band} action={action}>Next: {clause}</StateNote>
          ) : (
            <StateNote band={band}>Last milestone passed · {formatDayMonthYear(lastDate)} · no further step is scheduled on this timeline</StateNote>
          )}
        </div>
      )}
    </div>
  );
}
