// Ported from old_repo/scripts/mint/payload-schema.json (lines 1-335)
// Ported from old_repo/scripts/mint/export-census-rows.mjs (lines 1416-1456)
// The typed shapes the mint family passes around: the census row, the exported row, the relevance verdict, and the hold vocabulary. The payload itself is
// intake's RecordPayload; nothing here restates it.
import type { buildRecordPayload, MintDeps } from "@/features/intake";

export type ScreenVerdictName = "on_vertical" | "off_vertical" | "ambiguous";
export interface Screen {
  verdict: ScreenVerdictName;
  rule: string | null;
  basis: string;
  provenance: "rule" | "reviewed" | "registry";
}

export interface CensusRow {
  id: string;
  source_id: string;
  document_url: string;
  title: string | null;
  surface_tags?: string[] | null;
  instrument_identifier: string | null;
  dryrun_disposition?: string | null;
  hold_reason?: string | null;
  notes?: string | null;
  is_archived?: boolean | null;
  enumeration_status?: string | null;
}

export interface SourceRow {
  id: string;
  url: string | null;
  name: string | null;
  base_tier: number | null;
  tier_override: number | null;
  status: string | null;
  institution_id: string | null;
  category: string | null;
}

/** A holder of a URL or a canonical key in intelligence_items (archived rows included). */
export interface Holder {
  id: string;
  source_url: string | null;
  canonical_instrument_key: string | null;
  instrument_identifier: string | null;
  archive_reason?: string | null;
}

/** One exported census row: everything buildRecordPayload needs, with the census id carried on the row. */
export interface ExportRow {
  census_id: string;
  source_url: string;
  item_type: string;
  title: string;
  title_origin: string | null;
  instrument_identifier: string | null;
  canonical_instrument_key: string | null;
  jurisdiction_iso: string | null;
  priority: string;
  source: SourceRow;
  captured_text: string;
  fetched_length: number;
  screen: Screen;
}

/** A census hold: the stage-qualified reason is the whole vocabulary a reopen matches (`<stage>:<reason>[:<detail>]`). */
export interface Hold {
  rowId: string;
  reason: string;
  evidence?: Record<string, unknown>;
}

export type MintRowOutcome = "minted_verified" | "minted_unverified" | "held" | "refused" | "would_mint" | "deferred" | "failed";
export interface RowResult {
  rowId: string;
  outcome: MintRowOutcome;
  itemId?: string | null;
  hold?: string;
  detail?: string;
}

/** The `<stage>:` prefixes a mint hold carries; reopen refuses any hold outside them. */
export const HOLD_STAGES = ["validation_failed", "screen", "capture", "identity", "held", "source"] as const;
export const HOLD_PREFIX = "validation_failed:";

// P2-04 exports the dependency interface, not the input and result types; they are derived from it so the one mint function satisfies it exactly.
export type MintInput = Parameters<MintDeps["mintItem"]>[0];
export type MintResult = Awaited<ReturnType<MintDeps["mintItem"]>>;
export type MintOutcome = MintResult["outcome"];
/** The record-grade payload intake builds (item, source, screen, sections, search_results, claims). */
export type RecordPayload = ReturnType<typeof buildRecordPayload>;
