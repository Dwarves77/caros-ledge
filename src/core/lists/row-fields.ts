// Ported from old_repo/src/lib/list-row-fields.ts (lines 1-93)
// Ported from old_repo/src/lib/dashboard/row-fields.ts (lines 1-86)
// The fields a list row draws, derived from one Resource (ROWS-1: the row draws only what src/ui/list-surface/data/row-fields.json names). The impact score, timeline, bias tags, grade and workspace tags stay on the Resource for the detail page.
import type { Resource } from "@/core/types";
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
  /** The jurisdiction code, or "" when the item names none (the row then draws no chip). */
  jurisdiction: string;
  title: string;
  /** The stored item_type; the row picks its row type and its type chip from it. */
  type: string | null;
  /** The second line of the row (see rowSummary): the first sentence of the stored reader text, never blank. */
  summary: string;
  due: { label: string; days: string } | null;
  tier: number | null;
  watchType: ListWatchType;
}

const watchTypeForItem = (item: { type?: string | null; domain?: number | null }): ListWatchType => WATCH_TYPE[canonicalSurface(item)];

export function jurisdictionCode(r: { jurisdictionIso?: string[] | undefined; jurisdiction?: string | undefined }): string {
  const iso = r.jurisdictionIso?.[0];
  return iso ? iso.toUpperCase() : r.jurisdiction ? r.jurisdiction.toUpperCase() : "";
}

/** The nearest future date among the deadline and the timeline, by UTC day. Only a stated day counts: a timeline entry the reader gave as a year or a month ("2027", "2027-03") is a period, not a due date (F:12). */
export function dueInfo(r: Resource, now: Date): DueInfo | null {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const raws = [r.complianceDeadline, ...(r.timeline ?? []).map((t) => t.date)].filter((x): x is string => !!x && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(x));
  let best: number | null = null;
  for (const raw of raws) {
    const ms = new Date(raw + (raw.length === 10 ? "T00:00:00Z" : "")).getTime();
    if (!Number.isNaN(ms) && ms >= today && (best === null || ms < best)) best = ms;
  }
  if (best === null) return null;
  const diff = Math.round((best - today) / 86_400_000);
  return { label: formatDate(new Date(best).toISOString().slice(0, 10)), days: `${diff} day${diff === 1 ? "" : "s"}`, daysNum: diff };
}

/** The first sentence of a stored text, cut at its end (not at "No." or "Art."); null when there is none. */
const firstSentence = (text: string | null | undefined): string | null => {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, [...t.matchAll(/[.!?](?=\s+[A-Z("“]|$)/g)].map((m) => m.index + 1).find((n) => !/\b(?:No|Nos|Art|Arts|Dir|Reg|Sec|vs|approx|e\.g|i\.e)\.$/i.test(t.slice(0, n)))) : null;
};

export function toListRowFields(r: Resource, now: Date): ListRowFields {
  const due = dueInfo(r, now);
  return {
    id: r.id,
    href: detailHref(r),
    priority: String(r.priority ?? ""),
    jurisdiction: jurisdictionCode(r),
    title: r.title,
    type: r.type ?? null,
    // the second line, never blank: why it matters, else what it changes, else what the record is, else a line composed from its jurisdiction and next date
    summary: firstSentence(r.whyMatters) ?? firstSentence(r.whatItChanges) ?? firstSentence(r.whatIsIt) ?? firstSentence(r.note) ?? `${jurisdictionCode(r) ? `Applies in ${jurisdictionCode(r)}` : "Applies across jurisdictions"}${due ? `; next date ${due.label}` : ""}.`,
    due: due ? { label: due.label, days: due.days } : null,
    tier: r.sourceTier ?? null,
    watchType: watchTypeForItem(r),
  };
}
