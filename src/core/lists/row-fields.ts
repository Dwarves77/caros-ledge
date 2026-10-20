// Ported from old_repo/src/lib/list-row-fields.ts (lines 1-93)
// Ported from old_repo/src/lib/dashboard/row-fields.ts (lines 1-86)
// The fields a list row draws, derived from one Resource. Impact is the stored score (the mapper reads item_impact_scores and the workspace's client relevance) or null (rendered as the dash) with the sentence of the input it waits for; no keyword heuristic scores a row.
// A missing due date likewise names its input.
import type { ImpactScores, Resource, TimelineEntry } from "@/core/types";
import { READING } from "@/core/impact/rules";
import { formatDate } from "@/core/shared";

import { canonicalSurface, detailHref, type DetailSurface } from "./item-links";

export type ListWatchType = "reg" | "signal" | "research" | "operations";
const WATCH_TYPE: Record<DetailSurface, ListWatchType> = { regulations: "reg", market: "signal", research: "research", operations: "operations" };

export interface DueInfo {
  label: string;
  days: string;
  daysNum: number;
}

export interface ListRowFields {
  id: string;
  href: string;
  priority: string;
  jurisdiction: string;
  title: string;
  meta: string;
  impact: ImpactScores | null;
  /** The input the impact score is waiting for ("No obligations extracted yet"), null when it is scored: the absence text a row draws beside the dash. */
  impactAbsence?: string | null;
  due: { label: string; days: string } | null;
  /** Why the due date is empty ("No milestone dates"), null when there is one. */
  dueAbsence?: string | null;
  timeline: TimelineEntry[] | null;
  tier: number | null;
  biasTags?: Resource["biasTags"];
  itemGrade?: Resource["itemGrade"];
  watchType: ListWatchType;
}

const watchTypeForItem = (item: { type?: string | null; domain?: number | null }): ListWatchType => WATCH_TYPE[canonicalSurface(item)];

export function jurisdictionCode(r: { jurisdictionIso?: string[] | undefined; jurisdiction?: string | undefined }): string {
  const iso = r.jurisdictionIso?.[0];
  return iso ? iso.toUpperCase() : r.jurisdiction ? r.jurisdiction.toUpperCase() : "GLOBAL";
}

/** The nearest future date among the deadline and the timeline, by UTC day. */
export function dueInfo(r: Resource, now: Date): DueInfo | null {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const raws = [r.complianceDeadline, ...(r.timeline ?? []).map((t) => t.date)].filter((x): x is string => !!x);
  let best: number | null = null;
  for (const raw of raws) {
    const ms = new Date(raw + (raw.length === 10 ? "T00:00:00Z" : "")).getTime();
    if (!Number.isNaN(ms) && ms >= today && (best === null || ms < best)) best = ms;
  }
  if (best === null) return null;
  const diff = Math.round((best - today) / 86_400_000);
  return { label: formatDate(new Date(best).toISOString().slice(0, 10)), days: `${diff} day${diff === 1 ? "" : "s"}`, daysNum: diff };
}

export const metaLine = (r: { type?: string | null; modes?: string[] | undefined; topic?: string | undefined }): string => [r.type, r.modes?.length ? r.modes.join(", ") : null, r.topic].filter(Boolean).join(" · ");

export function toListRowFields(r: Resource, now: Date): ListRowFields {
  const due = dueInfo(r, now);
  return {
    id: r.id,
    href: detailHref(r),
    priority: String(r.priority ?? ""),
    jurisdiction: jurisdictionCode(r),
    title: r.title,
    meta: metaLine(r),
    impact: r.impactScores ?? null,
    impactAbsence: r.impactScores ? null : (r.impactAbsence ?? null),
    due: due ? { label: due.label, days: due.days } : null,
    dueAbsence: due ? null : READING.absence.due,
    timeline: r.timeline ?? null,
    tier: r.sourceTier ?? null,
    ...(r.biasTags && r.biasTags.length > 0 ? { biasTags: r.biasTags } : {}),
    ...(r.itemGrade ? { itemGrade: r.itemGrade } : {}),
    watchType: watchTypeForItem(r),
  };
}
