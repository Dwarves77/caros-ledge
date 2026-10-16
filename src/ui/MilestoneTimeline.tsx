// Ported from old_repo/src/components/ui/MilestoneTimeline.tsx (lines 28-93)
// Ported from old_repo/src/components/ui/timeline-dot-styles.ts (lines 1-36)
import type { CSSProperties } from "react";

import type { TimelineEntry } from "@/core/types";

import { classifyTimelineEntries, greenPercent, type TimelineDotState } from "./timeline-math";

/** One dot. The `next` dot is the band colour with a ring: `bandHex` plus an alpha suffix, the second declared colour exception. */
export function TimelineDot({ state, bandHex, size, ring }: { state: TimelineDotState; bandHex: string; size: number; ring: number }) {
  const style: CSSProperties = state === "next" ? { width: size, height: size, background: bandHex, boxShadow: `0 0 0 ${ring}px ${bandHex}33` } : { width: size, height: size };
  return <span aria-hidden="true" className={`cl-dot cl-dot--${state}`} style={style} />;
}

/** The row dot strip: passed, next with a ring, ahead; the track is green up to the next dot. The empty track is a 1 px hairline. */
export function MilestoneTimeline({ entries, bandHex }: { entries?: TimelineEntry[] | null | undefined; bandHex: string }) {
  const list = (entries ?? []).slice(0, 5);
  if (list.length === 0) return <span className="cl-timeline-empty" aria-hidden="true" />;
  const classified = classifyTimelineEntries(list);
  return (
    <span role="img" aria-label="Milestone timeline" className="cl-mt">
      <span aria-hidden="true" className="cl-mt-track" style={{ ["--tl-green" as string]: `${greenPercent(classified.map((c) => c.state))}%` }} />
      <span className="cl-mt-dots">
        {classified.map(({ state }, i) => (
          <TimelineDot key={i} state={state} bandHex={bandHex} size={state === "next" ? 9 : 6} ring={2} />
        ))}
      </span>
    </span>
  );
}
