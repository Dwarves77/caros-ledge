// Ported from old_repo/scripts/mint/run-mint-batch.mjs (lines 122-172)
// One record-grade payload per exported census row, through intake's buildRecordPayload (no model, no fetch). The census id travels on the row, not in the payload's
// own id, so apply traces a payload back to its census row without a lookup that can miss (the old payload.id convention fell back to a URL when row_id was absent).
import { buildRecordPayload } from "@/features/intake";

import type { ExportRow, RecordPayload } from "./types";

export interface BuiltPayload { censusId: string; payload: RecordPayload }

/** A build failure is a value the caller holds the row on; one bad row never aborts a run. */
export function buildPayload(row: ExportRow, requiredSlots: readonly string[]): { ok: true; built: BuiltPayload } | { ok: false; error: string } {
  try {
    const payload = buildRecordPayload({
      sourceUrl: row.source_url,
      itemType: row.item_type,
      title: row.title,
      instrumentIdentifier: row.instrument_identifier,
      canonicalInstrumentKey: row.canonical_instrument_key,
      jurisdictionIso: row.jurisdiction_iso,
      priority: row.priority,
      source: { ...row.source },
      capturedText: row.captured_text,
      fetchedLength: row.fetched_length,
      requiredSlots,
      screen: { verdict: row.screen.verdict, provenance: row.screen.provenance, basis: row.screen.basis },
    });
    return { ok: true, built: { censusId: row.census_id, payload } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
