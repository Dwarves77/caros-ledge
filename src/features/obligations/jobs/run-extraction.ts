// Ported from old_repo/scripts/forward-events/run-extraction.mjs (lines 41-130)
// The corpus extraction runner: session-supplied items (claims and sections), the pure extractor over each, metrics by kind, confidence, precision and skip
// reason, and every dedupe drop. Dry computes only; apply writes each item's events through the one writer (never a file the writer's caller must re-load).
// The run's artifact is the recorder's (P2-08): this returns its counts and the full event and skip lists.
import type { Db } from "@/core/db";
import type { RunResult } from "@/core/sources/run-result";

import { syncComplianceDeadline } from "../derive/compliance-deadline";
import type { DroppedEvent, ExtractedEvent } from "../extract/dedupe";
import { EXTRACTOR_VERSION, extractForwardEvents, type SectionIn, type SkippedEvent } from "../extract/extract-forward-events";
import type { ClaimIn } from "../extract/scan";
import { insertForwardEvents } from "../extract/write-forward-events";

export interface CorpusItem {
  id: string;
  claims?: readonly ClaimIn[];
  sections?: readonly SectionIn[];
  referenceDates?: readonly string[];
}
export interface ExtractionMetrics {
  items_processed: number;
  items_with_events: number;
  events_emitted: number;
  skips: number;
  by_kind: Record<string, number>;
  by_confidence: Record<string, number>;
  by_precision: Record<string, number>;
  by_skip_reason: Record<string, number>;
  dedupe_dropped: number;
  extractor_version: string;
}
export interface ExtractionRun {
  metrics: ExtractionMetrics;
  allEvents: (ExtractedEvent & { item_id: string })[];
  allSkips: (SkippedEvent & { item_id: string })[];
  dedupeDropped: (DroppedEvent & { item_id: string })[];
}
const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};

/** The pure part: the extractor over each item. */
function runExtraction(items: readonly CorpusItem[]): ExtractionRun {
  const metrics: ExtractionMetrics = { items_processed: items.length, items_with_events: 0, events_emitted: 0, skips: 0, by_kind: {}, by_confidence: {}, by_precision: {}, by_skip_reason: {}, dedupe_dropped: 0, extractor_version: EXTRACTOR_VERSION };
  const run: ExtractionRun = { metrics, allEvents: [], allSkips: [], dedupeDropped: [] };
  items.forEach((item, index) => {
    const id = String(item?.id ?? `corpus-index-${index}`);
    const { events, skipped, counts } = extractForwardEvents({ claims: item?.claims ?? [], sections: item?.sections ?? [], referenceDates: item?.referenceDates ?? [] });
    for (const d of counts.dedupe_dropped_detail) run.dedupeDropped.push({ item_id: id, ...d });
    if (events.length) metrics.items_with_events += 1;
    for (const e of events) {
      run.allEvents.push({ item_id: id, ...e });
      bump(metrics.by_kind, e.event_kind);
      bump(metrics.by_confidence, e.confidence);
      bump(metrics.by_precision, e.date_precision);
    }
    for (const s of skipped) {
      run.allSkips.push({ item_id: id, ...s });
      bump(metrics.by_skip_reason, s.reason);
    }
  });
  metrics.events_emitted = run.allEvents.length;
  metrics.skips = run.allSkips.length;
  metrics.dedupe_dropped = run.dedupeDropped.length;
  return run;
}

export async function runExtractionJob(deps: { sb: Db; now: () => Date }, input: { items: readonly CorpusItem[]; dry: boolean }): Promise<RunResult<ExtractionRun>> {
  const run = runExtraction(input.items);
  const m = run.metrics;
  const counts: Record<string, number> = { items: m.items_processed, items_with_events: m.items_with_events, events: m.events_emitted, skips: m.skips, dedupe_dropped: m.dedupe_dropped, inserted: 0, failed: 0 };
  const notes: string[] = [];
  if (input.dry) return { counts, outcome: "ok", notes: ["dry: nothing written"], data: run };
  const today = deps.now().toISOString().slice(0, 10);
  for (const item of input.items) {
    const events = run.allEvents.filter((e) => e.item_id === item.id).map((e) => {
      const rest: Record<string, unknown> = { ...e };
      delete rest.item_id;
      return rest as unknown as Omit<typeof e, "item_id">;
    });
    if (!events.length) continue;
    try {
      const w = await insertForwardEvents(deps.sb, item.id, events, { claimIds: new Set((item.claims ?? []).map((c) => c.claim_id)), sectionIds: new Set((item.sections ?? []).map((s) => s.section_id)) });
      counts.inserted = (counts.inserted ?? 0) + w.inserted;
      await syncComplianceDeadline(deps.sb, item.id, today);
    } catch (e) {
      counts.failed = (counts.failed ?? 0) + 1;
      notes.push(`${item.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { counts, outcome: counts.failed ? "partial" : "ok", notes, data: run };
}
