// Ported from old_repo/src/lib/forward-events/extract-forward-events.mjs (lines 1172-1279)
// Within one extraction, two events with the same date and kind whose texts are the same sentence after comparison normalisation collapse to one:
// claim-backed over section-backed, the earlier of two equals. Every drop is recorded with its reason (INV-218).
import type { EventKind } from "../kinds";

import { normalizeObligationText } from "./window";

const UNICODE_SUBSCRIPT_DIGITS: Record<string, string> = { "₀": "0", "₁": "1", "₂": "2", "₃": "3", "₄": "4", "₅": "5", "₆": "6", "₇": "7", "₈": "8", "₉": "9" };
const DEDUPE_MIN_COMPARE_LEN = 40;

export interface ExtractedEvent {
  event_date: string;
  date_precision: string;
  event_kind: EventKind;
  obligation_text: string;
  source_kind: "claim" | "section";
  source_claim_id: string | null;
  source_section_id: string | null;
  source_span: string;
  confidence: "high" | "medium";
  extractor_version: string;
}
export interface DroppedEvent {
  event_date: string;
  event_kind: EventKind;
  source_kind: string;
  source_claim_id: string | null;
  source_section_id: string | null;
  confidence: string;
  obligation_text: string;
  kept_source_kind: string;
  kept_source_claim_id: string | null;
  kept_source_section_id: string | null;
  kept_confidence: string;
  reason: "claim_backed_preferred_over_section_backed" | "duplicate_same_confidence_kept_first";
}

/** Normalise for comparison only: the display normalisation, lower case, subscript digits as digits, a letter-space-digit as one token, edge quotes off. */
function compareNormalize(text: string): string {
  let t = normalizeObligationText(text).toLowerCase();
  t = t.replace(/[₀-₉]/g, (d) => UNICODE_SUBSCRIPT_DIGITS[d] ?? d);
  t = t.replace(/(?<![a-z0-9])([a-z])\s+(\d)/g, "$1$2");
  t = t.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "");
  return t.replace(/\s+/g, " ").trim();
}

/** The same sentence: equal, or one is a prefix-sharing or contained form of the other (at least 40 characters of agreement). */
export function sameObligationContent(aText: string, bText: string): boolean {
  const a = compareNormalize(aText);
  const b = compareNormalize(bText);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < DEDUPE_MIN_COMPARE_LEN) return false;
  let i = 0;
  while (i < shorter.length && i < longer.length && shorter[i] === longer[i]) i += 1;
  return i >= DEDUPE_MIN_COMPARE_LEN || longer.includes(shorter);
}

export function dedupeEvents(events: readonly ExtractedEvent[]): { events: ExtractedEvent[]; dropped: DroppedEvent[] } {
  const keep = new Array<boolean>(events.length).fill(true);
  const dropped: DroppedEvent[] = [];
  const groups = new Map<string, number[]>();
  events.forEach((ev, idx) => groups.set(`${ev.event_date}|${ev.event_kind}`, [...(groups.get(`${ev.event_date}|${ev.event_kind}`) ?? []), idx]));
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    for (let a = 0; a < idxs.length; a += 1) {
      const i = idxs[a] as number;
      if (!keep[i]) continue;
      for (let b = a + 1; b < idxs.length; b += 1) {
        const j = idxs[b] as number;
        if (!keep[j]) continue;
        const ei = events[i] as ExtractedEvent;
        const ej = events[j] as ExtractedEvent;
        if (!sameObligationContent(ei.obligation_text, ej.obligation_text)) continue;
        const iHigh = ei.confidence === "high";
        const jHigh = ej.confidence === "high";
        const dropIdx = iHigh && !jHigh ? j : jHigh && !iHigh ? i : j;
        const keptIdx = dropIdx === j ? i : j;
        keep[dropIdx] = false;
        const d = events[dropIdx] as ExtractedEvent;
        const k = events[keptIdx] as ExtractedEvent;
        dropped.push({
          event_date: d.event_date, event_kind: d.event_kind, source_kind: d.source_kind, source_claim_id: d.source_claim_id, source_section_id: d.source_section_id, confidence: d.confidence, obligation_text: d.obligation_text,
          kept_source_kind: k.source_kind, kept_source_claim_id: k.source_claim_id, kept_source_section_id: k.source_section_id, kept_confidence: k.confidence,
          reason: iHigh !== jHigh ? "claim_backed_preferred_over_section_backed" : "duplicate_same_confidence_kept_first",
        });
        if (dropIdx === i) break;
      }
    }
  }
  return { events: events.filter((_, idx) => keep[idx]), dropped };
}
