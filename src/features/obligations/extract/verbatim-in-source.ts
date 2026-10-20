// Ported from old_repo/src/lib/forward-events/read-and-extract.mjs (lines 168-268)
// Ported from old_repo/src/lib/forward-events/read-and-extract.mjs (lines 333-338)
// The D10 class fix: a section-backed event survives only if its date span is verbatim in a FACT claim span of the same item (a forward event must be
// verbatim in its source, the same rule as a FACT claim). Every refusal is returned as a named skip and counted; claim-backed events are verbatim by construction.
import { isVerbatim } from "@/core/contracts/verbatim";
import type { Db } from "@/core/db";

import { extractForwardEvents, type SkippedEvent } from "./extract-forward-events";
import type { ExtractedEvent } from "./dedupe";
import { readExtractionInput, type ExtractionInput } from "./read-extraction-input";
import type { ClaimIn } from "./scan";

const REFUSED_NOT_IN_SOURCE = "refusedNotInSource: section-kind event's date span is not verbatim in any FACT claim span for this item -- a forward event must be verbatim in its source, the same rule as a FACT claim (D10 class fix)";

function enforceSectionVerbatimInSource(events: readonly ExtractedEvent[], skipped: readonly SkippedEvent[], claims: readonly ClaimIn[]): { events: ExtractedEvent[]; skipped: SkippedEvent[]; refusedNotInSource: number } {
  const factSpans = claims.filter((c) => c?.kind === "FACT" && typeof c.span === "string" && c.span.length > 0).map((c) => c.span as string);
  const kept: ExtractedEvent[] = [];
  const outSkipped = [...skipped];
  let refused = 0;
  for (const event of events) {
    if (event.source_kind !== "section" || factSpans.some((span) => isVerbatim(span, event.source_span))) {
      kept.push(event);
      continue;
    }
    refused += 1;
    outSkipped.push({ source_kind: "section", source_claim_id: null, source_section_id: event.source_section_id ?? null, reason: REFUSED_NOT_IN_SOURCE, text: event.source_span });
  }
  return { events: kept, skipped: outSkipped, refusedNotInSource: refused };
}

export interface ReadAndExtract extends ExtractionInput {
  events: ExtractedEvent[];
  skipped: SkippedEvent[];
  refusedNotInSource: number;
}
/** Read one item's input, extract, and apply the section-verbatim rule. The clock only supplies the run date for the reference-date refusal. */
export async function readAndExtractForwardEvents(sb: Db, itemId: string, now: Date): Promise<ReadAndExtract> {
  const input = await readExtractionInput(sb, itemId, now);
  const raw = extractForwardEvents(input);
  const { events, skipped, refusedNotInSource } = enforceSectionVerbatimInSource(raw.events, raw.skipped, input.claims);
  return { ...input, events, skipped, refusedNotInSource };
}
