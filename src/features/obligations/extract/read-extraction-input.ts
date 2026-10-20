// Ported from old_repo/src/lib/forward-events/read-and-extract.mjs (lines 25-146)
// Ported from old_repo/src/lib/forward-events/read-and-extract.mjs (lines 274-318)
// One item's extraction input: its FACT and GAP claims, its sections and its reference dates (the run date and the brief's own document date, both refused
// as events when their clause names no commencement verb). The item's capture pool is always read: it is the source the extractor scans beside the brief (a date the brief never quoted) and the context a due-date slot claim is rescued with. Every read destructures
// its error and throws on it: a failed read is never an empty input (the old reader's warning is a returned count here).
import { readFactSuppressionsFor } from "@/core/detail/claim-tiers";
import { admissibleClaims } from "@/core/derived/admissible";
import type { Db } from "@/core/db";
import { readAllPoolRows, usableCaptures, type PoolRow } from "@/core/grounding";

import { isDueDateSlotClaim, needsDueDateContext, type ClaimIn } from "./scan";
import type { CaptureIn, SectionIn } from "./extract-forward-events";

const CLAIM_KIND_FILTER = ["FACT", "GAP"] as const;
const CONTEXT_CHARS = 240;

export interface ClaimRow {
  id: string;
  claim_kind: string;
  claim_text: string;
  source_span: string | null;
  intelligence_item_id?: string;
}
export interface SectionRow {
  id: string;
  section_key: string;
  content_md: string | null;
}
const mapClaimRow = (r: ClaimRow): ClaimIn => ({ claim_id: r.id, kind: r.claim_kind, text: r.claim_text, span: r.source_span ?? null });
const mapSectionRow = (r: SectionRow): SectionIn => ({ section_id: r.id, key: r.section_key, md: r.content_md ?? "" });

const todayIsoUtc = (now: Date): string => now.toISOString().slice(0, 10);
/** The date the brief was last regenerated (its own document date), or null. */
function documentDateIso(itemRow: { last_regenerated_at?: string | Date | null } | null | undefined): string | null {
  const raw = itemRow?.last_regenerated_at;
  if (typeof raw === "string" && raw.length >= 10) return raw.slice(0, 10);
  return raw instanceof Date ? raw.toISOString().slice(0, 10) : null;
}
function buildReferenceDates(itemRow: { last_regenerated_at?: string | Date | null } | null | undefined, now: Date): string[] {
  const dates = [todayIsoUtc(now), documentDateIso(itemRow)];
  return dates.filter((d, i): d is string => Boolean(d) && dates.indexOf(d) === i);
}

/** The usable captures in result_index order (the pool the context is cut from). */

/** The text before and after the first usable capture that holds the span verbatim. */
function buildDueDateContext(span: string, ordered: readonly PoolRow[]): { before: string; after: string; search_id: string } | null {
  if (typeof span !== "string" || !span) return null;
  for (const capture of ordered) {
    const idx = capture.text.indexOf(span);
    if (idx === -1) continue;
    return { before: capture.text.slice(Math.max(0, idx - CONTEXT_CHARS), idx), after: capture.text.slice(idx + span.length, idx + span.length + CONTEXT_CHARS), search_id: capture.id };
  }
  return null;
}

/** Attach capture context to the slot claims that carry a date but no deontic language of their own. */
function attachDueDateContext(claims: readonly ClaimIn[], poolRows: readonly PoolRow[]): ClaimIn[] {
  const ordered = usableCaptures([...poolRows]);
  return claims.map((claim) => (!isDueDateSlotClaim(claim) || typeof claim.span !== "string" || !claim.span ? claim : { ...claim, context: buildDueDateContext(claim.span, ordered) }));
}

export interface ExtractionInput {
  claims: ClaimIn[];
  sections: SectionIn[];
  /** The item's usable captures: its primary text, scanned for the dates the brief never quoted. */
  captures: CaptureIn[];
  referenceDates: string[];
}
export async function readExtractionInput(sb: Db, itemId: string, now: Date): Promise<ExtractionInput> {
  const [claimRes, sectionRes, itemRes] = await Promise.all([
    sb.from("section_claim_provenance").select("id, claim_kind, claim_text, source_span").eq("intelligence_item_id", itemId).in("claim_kind", [...CLAIM_KIND_FILTER]).order("id", { ascending: true }),
    sb.from("intelligence_item_sections").select("id, section_key, content_md").eq("item_id", itemId).order("id", { ascending: true }),
    sb.from("intelligence_items").select("last_regenerated_at").eq("id", itemId).maybeSingle(),
  ]);
  if (claimRes.error) throw new Error(`section_claim_provenance read failed: ${claimRes.error.message}`);
  if (sectionRes.error) throw new Error(`intelligence_item_sections read failed: ${sectionRes.error.message}`);
  if (itemRes.error) throw new Error(`intelligence_items read failed: ${itemRes.error.message}`);
  const claimRows = admissibleClaims(((claimRes.data ?? []) as ClaimRow[]).map((r) => ({ ...r, intelligence_item_id: itemId })), await readFactSuppressionsFor(sb, [itemId]));
  const mapped = claimRows.map(mapClaimRow);
  const poolRows = await readAllPoolRows(sb, itemId);
  return { claims: attachDueDateContext(mapped, poolRows), captures: usableCaptures(poolRows).map((r) => ({ capture_id: r.id, text: r.text })), sections: ((sectionRes.data ?? []) as SectionRow[]).map(mapSectionRow), referenceDates: buildReferenceDates(itemRes.data as { last_regenerated_at?: string } | null, now) };
}
