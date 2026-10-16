// Ported from old_repo/src/components/ui/milestone-timeline-classify.ts (lines 1-28)
// Ported from old_repo/src/lib/detail/timeline-math.ts (lines 1-168)
// Milestone classification and the timeline's pure arithmetic. No function here reads the clock: the caller passes `nowIso`.
import type { TimelineEntry } from "@/core/types";

export type TimelineDotState = "passed" | "next" | "ahead";
export interface ClassifiedMilestone {
  entry: TimelineEntry;
  state: TimelineDotState;
  index: number;
}

/** passed (status past), next (status current, else the first not-past entry when none is marked current), ahead (the rest). */
export function classifyTimelineEntries(entries: TimelineEntry[]): Array<{ entry: TimelineEntry; state: TimelineDotState }> {
  const explicit = entries.some((e) => e.status === "current");
  let firstFutureSeen = false;
  return entries.map((entry) => {
    const isFirstFuture = !explicit && entry.status !== "past" && !firstFutureSeen;
    if (isFirstFuture) firstFutureSeen = true;
    const state: TimelineDotState = entry.status === "past" ? "passed" : entry.status === "current" || isFirstFuture ? "next" : "ahead";
    return { entry, state };
  });
}
export const classifyMilestones = (entries: TimelineEntry[]): ClassifiedMilestone[] => classifyTimelineEntries(entries).map((c, index) => ({ ...c, index }));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "4 Mar 2026" or "Mar 2026"; the input back when it is not a date. */
export function formatDayMonthYear(iso: string): string {
  const [y, m, d] = iso.split(/[-T]/);
  const year = parseInt(y ?? "", 10);
  const month = parseInt(m ?? "", 10) - 1;
  const name = MONTHS[month];
  if (Number.isNaN(year) || !name) return iso;
  const day = d ? parseInt(d, 10) : NaN;
  return day ? `${day} ${name} ${year}` : `${name} ${year}`;
}

const utcMidnight = (iso: string): number => {
  const [y, m, d] = iso.split(/[-T]/).map((s) => parseInt(s, 10));
  return Date.UTC(y ?? 1970, (m || 1) - 1, d || 1);
};
/** Whole UTC days from `fromIso` to `targetIso`; both are passed in (nothing reads the clock). */
export const daysBetween = (targetIso: string, fromIso: string): number => Math.round((utcMidnight(targetIso) - utcMidnight(fromIso)) / 86_400_000);

export function daysPhrase(days: number): string {
  if (days === 0) return "today";
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
}

export function timelineHeaderCounts(classified: ClassifiedMilestone[]): { total: number; passed: number; nextDate: string | null } {
  return { total: classified.length, passed: classified.filter((c) => c.state === "passed").length, nextDate: classified.find((c) => c.state === "next")?.entry.date ?? null };
}

const COLLAPSE_AT = 4;
/** More than four milestones collapse to four, starting at the next one (else the last four). */
export function collapseTimeline(classified: ClassifiedMilestone[]): { visible: ClassifiedMilestone[]; hiddenCount: number; collapsed: boolean } {
  if (classified.length <= COLLAPSE_AT) return { visible: classified, hiddenCount: 0, collapsed: false };
  const next = classified.findIndex((c) => c.state === "next");
  const start = next >= 0 ? next : Math.max(0, classified.length - COLLAPSE_AT);
  const visible = classified.slice(start, Math.min(classified.length, start + COLLAPSE_AT));
  return { visible, hiddenCount: classified.length - visible.length, collapsed: true };
}

export function nextMilestoneClause(classified: ClassifiedMilestone[], nowIso: string): string | null {
  const next = classified.find((c) => c.state === "next");
  return next ? `${next.entry.label} · ${formatDayMonthYear(next.entry.date)} · ${daysPhrase(daysBetween(next.entry.date, nowIso))}` : null;
}

/** Where the green part of the track ends, as a percent of the first-to-last marker span. */
export function greenPercent(states: TimelineDotState[]): number {
  const next = states.indexOf("next");
  if (next >= 0) return states.length > 1 ? (next / (states.length - 1)) * 100 : 0;
  return states.length > 0 && states.every((s) => s === "passed") ? 100 : 0;
}

/** Event rows merged into a timeline by date: a date already on the timeline is not repeated. */
export function mergeObligationEvents(timeline: TimelineEntry[], events: Array<{ event_date: string; event_kind: string }>, kindLabels: Record<string, string>): TimelineEntry[] {
  const seen = new Set(timeline.map((t) => t.date));
  const merged = [...timeline];
  for (const ev of events) {
    if (!ev.event_date || seen.has(ev.event_date)) continue;
    seen.add(ev.event_date);
    merged.push({ date: ev.event_date, label: kindLabels[ev.event_kind] ?? ev.event_kind });
  }
  return merged;
}
