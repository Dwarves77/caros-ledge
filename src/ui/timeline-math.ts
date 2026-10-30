// Ported from old_repo/src/components/ui/milestone-timeline-classify.ts (lines 1-28)
// Ported from old_repo/src/lib/detail/timeline-math.ts (lines 1-168)
// Milestone classification and the timeline's pure arithmetic. No function here reads the clock: the caller passes `nowIso`.
import type { TimelineEntry } from "@/core/types";

export type TimelineDotState = "passed" | "next" | "ahead";
export interface ClassifiedMilestone { entry: TimelineEntry; state: TimelineDotState; index: number }

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
const daysBetween = (targetIso: string, fromIso: string): number => Math.round((utcMidnight(targetIso) - utcMidnight(fromIso)) / 86_400_000);

function daysPhrase(days: number): string {
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
  return next ? `${next.entry.label.replace(/^(?:\d{4}-\d{2}(?:-\d{2})?\s*(?:[—–\-:]|\s)+)+/, "").trim() || next.entry.label} · ${formatDayMonthYear(next.entry.date)} · ${daysPhrase(daysBetween(next.entry.date, nowIso))}` : null;
}

/** Where the green part of the track ends, as a percent of the first-to-last marker span. */
export function greenPercent(states: TimelineDotState[]): number {
  const next = states.indexOf("next");
  if (next >= 0) return states.length > 1 ? (next / (states.length - 1)) * 100 : 0;
  return states.length > 0 && states.every((s) => s === "passed") ? 100 : 0;
}

function summarizeObligationText(text: string, fallback: string): string {
  const t = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return fallback;
  if (t.length <= 48) return t;
  const firstSentence = t.split(/(?<=[.!?])\s+/)[0] ?? t;
  if (firstSentence.length <= 48) return firstSentence;
  const truncated = firstSentence.slice(0, 48);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated).trim() + "…";
}

export interface ObligationEventInput { id?: string; event_date: string; event_kind: string; obligation_text?: string | null; source_span?: string | null; source_claim_id?: string | null; source_section_id?: string | null }

const STAGE_BY_KIND: Readonly<Record<string, string>> = { consultation_close: "Proposed / consultation", entry_into_force: "Entry into force", implementing_act_due: "Rulemaking due", delegated_act_due: "Rulemaking due", guidance_expected: "Rulemaking due", phase_step: "Phase-in", review_or_report: "Review / report", compliance_deadline: "Enacted deadline" };

/** Deterministic statutory stage badge for a milestone from its obligation event_kind or verbatim label. */
export function milestoneStageOf(entry: TimelineEntry): string | null {
  if (entry.kind && entry.kind !== "other") return STAGE_BY_KIND[entry.kind] ?? entry.kind.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const text = `${entry.label ?? ""} ${entry.detail ?? ""}`;
  if (/\b(consultation|proposal|proposed|draft|comment period)\b/i.test(text)) return "Proposed / consultation";
  if (/\b(entry into force|enters into force|effective date)\b/i.test(text)) return "Entry into force";
  if (/\b(delegated act|implementing act|commission to adopt|guidance)\b/i.test(text)) return "Rulemaking due";
  if (/\b(review|report|evaluation|assessment)\b/i.test(text)) return "Review / report";
  if (/\b(transitional|phase-in|phased|permitted until|derogation)\b/i.test(text)) return "Phase-in";
  if (/\b(prohibited|mandatory|ban|must|shall|apply|applies|deadline|obligation)\b/i.test(text)) return "Enacted deadline";
  return null;
}

/** Event rows merged into a timeline by date: a date already on the timeline is not repeated. Preserves obligation_text, claimId, and builds concise label. */
export function mergeObligationEvents(timeline: TimelineEntry[], events: Array<ObligationEventInput>, kindLabels: Record<string, string>): TimelineEntry[] {
  const seen = new Map<string, number>();
  timeline.forEach((t, i) => seen.set(t.date, i));
  const merged = [...timeline];
  for (const ev of events) {
    if (!ev.event_date) continue;
    const existingIndex = seen.get(ev.event_date);
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex];
      if (existing) merged[existingIndex] = { ...existing, detail: existing.detail || ev.obligation_text || undefined, claimId: existing.claimId ?? ev.source_claim_id ?? null, sectionId: existing.sectionId ?? ev.source_section_id ?? null, kind: existing.kind ?? ev.event_kind };
      continue;
    }
    seen.set(ev.event_date, merged.length);
    const label = summarizeObligationText(ev.obligation_text ?? "", kindLabels[ev.event_kind] ?? ev.event_kind);
    merged.push({ date: ev.event_date, label, detail: ev.obligation_text || undefined, claimId: ev.source_claim_id ?? null, sectionId: ev.source_section_id ?? null, kind: ev.event_kind });
  }
  return merged;
}
