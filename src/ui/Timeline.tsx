// Ported from old_repo/src/components/ui/Timeline.tsx (lines 40-170)
// Ported from old_repo/src/components/ui/Timeline.tsx (lines 180-375)
import Link from "next/link";

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
 * vertical stack (grid in base.css). A label is not a focus stop (a tab stop per marker was a defect, B-1965); the full text rides in `title` and the callout's Full schedule action is the keyboard route. The callout states the next milestone; it never asserts that obligations are
 * current from the entry list alone (B-1964).
 */
export function Timeline({ entries, band, nowIso, onFullSchedule, fullScheduleHref, moreMarkersHref }: TimelineProps) {
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
  const action = onFullSchedule ? { label: "Full schedule ↓", onClick: onFullSchedule } : fullScheduleHref ? { label: "Full schedule ↓", href: fullScheduleHref } : undefined;
  return (
    <div data-part="timeline" className="cl-tl">
      <Header total={counts.total} passed={counts.passed} nextDate={counts.nextDate} />
      <div role="img" aria-label={`Milestone timeline: ${counts.total} milestones, ${counts.passed} passed`} className="cl-tl-track" style={{ ["--tl-n" as string]: visible.length, ["--tl-green" as string]: `${greenPercent(visible.map((c) => c.state))}%` }}>
        <div aria-hidden="true" className="cl-tl-line" />
        {visible.map(({ entry, state, index }, i) => (
          <div key={index} className="cl-tl-marker" data-state={state} style={{ ["--c" as string]: i + 1 }}>
            <span className="cl-tl-date">{entry.date}</span>
            <span className="cl-tl-dotcell">
              <TimelineDot state={state} bandHex={band.hex} size={state === "next" ? 12 : 8} ring={3} />
            </span>
            <span title={entry.label} className="cl-tl-label">
              {entry.label}
            </span>
          </div>
        ))}
      </div>
      {collapsed && hiddenCount > 0 &&
        (moreMarkersHref ? (
          <Link href={moreMarkersHref} data-audit="timeline-more-markers" className="cl-tl-more cl-tl-more--link">
            +{hiddenCount} more
          </Link>
        ) : (
          <span data-audit="timeline-more-markers" className="cl-tl-more">
            +{hiddenCount} more
          </span>
        ))}
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
