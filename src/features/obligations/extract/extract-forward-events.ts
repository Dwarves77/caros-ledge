// Ported from old_repo/src/lib/forward-events/extract-forward-events.mjs (lines 1-1)
// Ported from old_repo/src/lib/forward-events/extract-forward-events.mjs (lines 1294-1456)
// The pure extractor: claims (FACT and GAP) and sections in, events and skips out. No I/O, no clock, no model (the extractor imports no client). Claim-backed
// events are high confidence, section-backed medium; the source span is the date text alone and verbatim in its source (ADR-016). A due-date slot claim
// whose span yields no event is rescued with the capture context around it. Every drop is recorded: a claim with no span and a section with no text land
// in `skipped` with a reason instead of vanishing (the old loop `continue`d silently, against its own rule).
import { assertVerbatim } from "@/core/contracts/verbatim";

import { dedupeEvents, type DroppedEvent, type ExtractedEvent } from "./dedupe";
import { finerDuePrecision, isDueDateSlotClaim, rescueSlotDateWithContext, scanText, slotDatePrecision, type ClaimIn, type Hit } from "./scan";

export const EXTRACTOR_VERSION = "fe1-2026-09-13.1";
export interface SectionIn {
  section_id: string;
  key?: string;
  md: string;
}
export interface SkippedEvent {
  source_kind: "claim" | "section";
  source_claim_id: string | null;
  source_section_id: string | null;
  reason: string;
  text: string;
}
export interface ExtractInput {
  claims?: readonly ClaimIn[];
  sections?: readonly SectionIn[];
  referenceDates?: readonly string[];
}
export interface ExtractOutput {
  events: ExtractedEvent[];
  skipped: SkippedEvent[];
  counts: { dedupe_dropped: number; dedupe_dropped_detail: DroppedEvent[] };
}

const toEvent = (h: Pick<Hit, "iso" | "kind" | "obligationText" | "dateSpan">, precision: string, source: { kind: "claim"; claimId: string } | { kind: "section"; sectionId: string }): ExtractedEvent => ({
  event_date: h.iso, date_precision: precision, event_kind: h.kind, obligation_text: h.obligationText, source_kind: source.kind,
  source_claim_id: source.kind === "claim" ? source.claimId : null, source_section_id: source.kind === "section" ? source.sectionId : null,
  source_span: h.dateSpan, confidence: source.kind === "claim" ? "high" : "medium", extractor_version: EXTRACTOR_VERSION,
});

export function extractForwardEvents(input: ExtractInput): ExtractOutput {
  const referenceDates = input?.referenceDates ?? [];
  const events: ExtractedEvent[] = [];
  const skipped: SkippedEvent[] = [];
  const claimSkip = (claimId: string, reason: string, text: string) => skipped.push({ source_kind: "claim", source_claim_id: claimId, source_section_id: null, reason, text });

  for (const claim of input?.claims ?? []) {
    if (claim.kind !== "FACT" && claim.kind !== "GAP") continue;
    if (typeof claim.span !== "string" || claim.span.length === 0) {
      claimSkip(claim.claim_id, "claim_has_no_span", String(claim.text ?? "").slice(0, 120));
      continue;
    }
    const text = claim.span;
    const { hits, skips } = scanText(text, { referenceDates });
    const slot = isDueDateSlotClaim(claim);
    for (const s of skips) claimSkip(claim.claim_id, s.reason, s.span);
    for (const h of hits) {
      assertVerbatim(text, h.dateSpan);
      events.push(toEvent(h, slot ? finerDuePrecision(h.precision, slotDatePrecision(claim)) : h.precision, { kind: "claim", claimId: claim.claim_id }));
    }
    if (slot && hits.length === 0) {
      if (skips.length === 0) claimSkip(claim.claim_id, "relative_deadline_no_calendar_date", text);
      else if (!claim.context) claimSkip(claim.claim_id, "calendar_date_deontic_context_unavailable", text);
      else {
        const rescued = rescueSlotDateWithContext(claim.span, claim.context, referenceDates);
        if (rescued) {
          assertVerbatim(claim.context.before + claim.span + claim.context.after, rescued.dateSpan);
          events.push(toEvent(rescued, finerDuePrecision(rescued.precision, slotDatePrecision(claim)), { kind: "claim", claimId: claim.claim_id }));
        } else claimSkip(claim.claim_id, "calendar_date_no_deontic_in_context", text);
      }
    }
  }
  for (const section of input?.sections ?? []) {
    const text = typeof section.md === "string" ? section.md : "";
    if (!text) {
      skipped.push({ source_kind: "section", source_claim_id: null, source_section_id: section.section_id, reason: "section_has_no_text", text: "" });
      continue;
    }
    const { hits, skips } = scanText(text, { referenceDates });
    for (const s of skips) skipped.push({ source_kind: "section", source_claim_id: null, source_section_id: section.section_id, reason: s.reason, text: s.span });
    for (const h of hits) {
      assertVerbatim(text, h.dateSpan);
      events.push(toEvent(h, h.precision, { kind: "section", sectionId: section.section_id }));
    }
  }
  const { events: deduped, dropped } = dedupeEvents(events);
  return { events: deduped, skipped, counts: { dedupe_dropped: dropped.length, dedupe_dropped_detail: dropped } };
}
