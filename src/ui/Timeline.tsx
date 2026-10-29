"use client";

// Ported from old_repo/src/components/ui/Timeline.tsx (lines 40-170)
// Ported from old_repo/src/components/ui/Timeline.tsx (lines 180-375)
import Link from "next/link";
import { useState } from "react";

import type { UrgencyBand } from "@/core/lists";
import { pluralize } from "@/core/shared";
import type { TimelineEntry } from "@/core/types";

import { SectionLabel } from "./SectionLabel";
import { StateNote } from "./StateNote";
import { TimelineDot } from "./MilestoneTimeline";
import { classifyMilestones, collapseTimeline, formatDayMonthYear, greenPercent, nextMilestoneClause, timelineHeaderCounts } from "./timeline-math";

interface TimelineProps {
  entries?: TimelineEntry[] | null | undefined;
  band: UrgencyBand;
  /** The render instant (ISO date): required, so no render reads a clock (B-0209). */
  nowIso: string;
  onFullSchedule?: () => void;
  fullScheduleHref?: string;
  moreMarkersHref?: string;
}

function Header({ total, passed, nextDate }: { total: number; passed: number; nextDate: string | null }) {
  return (
    <div className="cl-tl-head">
      <SectionLabel>Timeline</SectionLabel>
      <span className="cl-tl-counts">
        {total} {pluralize(total, "milestone")} · {passed} passed{nextDate ? ` · next ${formatDayMonthYear(nextDate)}` : ""}
      </span>
    </div>
  );
}

/**
 * The action-card timeline: ONE markup. Wide it is a dot track with date above and label below each marker; on the phone the same markers reflow to a
 * vertical stack (grid in base.css). Markers are interactive buttons: clicking a milestone expands an inline context bar below the timeline showing
 * verbatim details, kind, and quick navigation / search actions.
 */
const cleanLabel = (raw: string): string => {
  const s = raw.trim().replace(/\s+[a-zA-Z]{1,10}(?:\.{3}|…)$/, "…");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
};

export function Timeline({ entries, band, nowIso, onFullSchedule, fullScheduleHref, moreMarkersHref }: TimelineProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const list = entries ?? [];
  if (list.length === 0) {
    return (
      <div data-part="timeline">
        <Header total={0} passed={0} nextDate={null} />
        <span className="cl-timeline-empty cl-tl-empty" aria-hidden="true" />
      </div>
    );
  }
  const classified = classifyMilestones(list);
  const counts = timelineHeaderCounts(classified);
  const { visible, hiddenCount, collapsed } = collapseTimeline(classified);
  const clause = nextMilestoneClause(classified, nowIso);
  const lastDate = list[list.length - 1]?.date ?? "";
  const action = onFullSchedule ? { label: "Full schedule ↓", onClick: onFullSchedule } : fullScheduleHref ? { label: "Full schedule ↓", href: fullScheduleHref } : collapsed && hiddenCount > 0 ? { label: showAll ? `Hide full schedule (${counts.total}) ▴` : `Show all ${counts.total} milestones (+${hiddenCount} more) ▾`, onClick: () => setShowAll((v) => !v) } : undefined;

  const selectedMilestone = selected !== null ? classified.find((c) => c.index === selected) : null;
  const selectedEntry = selectedMilestone?.entry ?? null;

  return (
    <div data-part="timeline" className="cl-tl">
      <Header total={counts.total} passed={counts.passed} nextDate={counts.nextDate} />
      <div role="img" aria-label={`Milestone timeline: ${counts.total} milestones, ${counts.passed} passed`} className="cl-tl-track" style={{ ["--tl-n" as string]: visible.length, ["--tl-green" as string]: `${greenPercent(visible.map((c) => c.state))}%` }}>
        <div aria-hidden="true" className="cl-tl-line" />
        {visible.map(({ entry, state, index }, i) => {
          const displayLabel = cleanLabel(entry.label);
          const displayDate = formatDayMonthYear(entry.date);
          return (
            <button
              key={index}
              type="button"
              className="cl-tl-marker"
              data-state={state}
              aria-pressed={selected === index}
              aria-label={`${displayLabel} · ${displayDate}`}
              onClick={() => setSelected(selected === index ? null : index)}
              style={{ ["--c" as string]: i + 1 }}
            >
              <span className="cl-tl-date">{displayDate}</span>
              <span className="cl-tl-dotcell">
                <TimelineDot state={state} bandHex={band.hex} size={state === "next" ? 12 : 8} ring={3} />
              </span>
              <span title={displayLabel} className="cl-tl-label">
                {displayLabel}
              </span>
            </button>
          );
        })}
      </div>
      {collapsed && hiddenCount > 0 && moreMarkersHref && (
        <div className="cl-tl-more-row">
          <Link href={moreMarkersHref} data-audit="timeline-more-markers" className="cl-tl-more cl-tl-more--link">
            Open Statutory Obligation Register ↓
          </Link>
        </div>
      )}
      {showAll && (
        <div className="cl-tl-schedule" aria-label="Full milestone schedule">
          {classified.map(({ entry, state, index }) => (
            <button
              key={index}
              type="button"
              onClick={() => setSelected(selected === index ? null : index)}
              className={`cl-tl-schedule-row${state === "next" ? " cl-tl-schedule-row--next" : ""}`}
            >
              <TimelineDot state={state} bandHex={band.hex} size={state === "next" ? 10 : 8} ring={2} />
              <span className="cl-tl-schedule-date">{formatDayMonthYear(entry.date)}</span>
              <span className="cl-tl-schedule-label">{cleanLabel(entry.detail ?? entry.label)}</span>
              <span className={`cl-tl-schedule-badge cl-tl-schedule-badge--${state}`}>
                {state === "passed" ? "Passed" : state === "next" ? "Next due" : "Upcoming"}
              </span>
            </button>
          ))}
        </div>
      )}
      {selectedEntry && (
        <div data-part="timeline-context" className="cl-tl-context">
          <div className="cl-tl-context-head">
            <span className="cl-tl-context-tag">
              {selectedEntry.date} {selectedEntry.kind ? ` · ${selectedEntry.kind.replace(/_/g, " ")}` : ""}
            </span>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="cl-tl-context-close"
              aria-label="Close milestone details"
            >
              Close ✕
            </button>
          </div>
          <p className="cl-tl-context-body">
            {selectedEntry.detail ?? selectedEntry.label}
          </p>
          <div className="cl-tl-context-actions">
            <a href="#obligations" className="cl-tl-context-link cl-tl-context-link--brand">
              View in obligations ↓
            </a>
            <a href="#summary" className="cl-tl-context-link">
              Summary ↵
            </a>
            <a
              href={`?q=${encodeURIComponent(selectedEntry.date)}`}
              onClick={(e) => {
                const askInput = document.querySelector<HTMLInputElement>("input[data-guard-search], input[type='search']");
                if (askInput) {
                  e.preventDefault();
                  askInput.value = selectedEntry.date;
                  askInput.focus();
                  askInput.dispatchEvent(new Event("input", { bubbles: true }));
                }
              }}
              className="cl-tl-context-link"
            >
              Research {selectedEntry.date} →
            </a>
          </div>
        </div>
      )}
      <div className="cl-tl-callout">
        {clause ? (
          <StateNote band={band} {...(action ? { action } : {})}>
            Next: {clause}
          </StateNote>
        ) : counts.total > 0 ? (
          <StateNote band={band}>Last milestone passed · {formatDayMonthYear(lastDate)} · no further step is scheduled on this timeline</StateNote>
        ) : null}
      </div>
    </div>
  );
}
