// Ported from old_repo/src/lib/detail/timeline-math.ts (lines 1-168)
// Ported from old_repo/src/lib/detail/requirement-trajectory-classify.ts (lines 1-66)
// The detail page's timeline arithmetic. Classification, the 4/4 collapse, the next-milestone clause and the obligation-event merge are the kit's (src/ui/timeline-math, one copy: the
// action card draws from them); this file adds the requirement-trajectory step and the helpers the page needs. Nothing here reads the clock: `nowIso` is the request's one instant.
import type { TimelineEntry } from "@/core/types";
import { classifyMilestones, collapseTimeline, mergeObligationEvents, nextMilestoneClause } from "@/ui/timeline-math";

export { classifyMilestones as classifyTimeline, collapseTimeline, mergeObligationEvents, nextMilestoneClause };

export interface TrajectoryStep {
  date: string;
  value: string;
  label?: string;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const toMs = (date: string): number | null => {
  const t = Date.parse(date.length === 4 ? `${date}-01-01T00:00:00Z` : date);
  return Number.isNaN(t) ? null : t;
};

/** The step that applies at `nowIso`: the first not yet past, else the last dated one; -1 when no step has a parseable date. */
export function pickCurrentStepIndex(steps: readonly TrajectoryStep[], nowIso: string): number {
  const now = Date.parse(nowIso);
  const at = steps.map((s) => toMs(s.date));
  const upcoming = at.findIndex((t) => t !== null && t >= now);
  return upcoming >= 0 ? upcoming : at.reduce<number>((last, t, i) => (t !== null ? i : last), -1);
}

/** "0.5 (Jan 1 2030)": a bare year stays a year and an ISO date is written without constructing a Date. */
export function formatTrajectoryStep(step: TrajectoryStep): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(step.date);
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return `${step.value} (${m && month ? `${month} ${Number(m[3])} ${m[1]}` : step.date})`;
}

/** The page timeline: the stored milestones with the obligation events merged in by date. */
export const withObligationEvents = (timeline: TimelineEntry[], events: Array<{ event_date: string; event_kind: string }>, kindLabels: Record<string, string>): TimelineEntry[] => mergeObligationEvents(timeline, events, kindLabels);
