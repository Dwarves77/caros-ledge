// Ported from old_repo/src/lib/intake/write-item.ts (lines 1-329)
// Ported from old_repo/src/lib/intake/pool-row-contract.mjs (lines 1-25)
// The ordered post-insert write for a record-grade item and its row builders. The ORDER is the contract: pool rows first (a FACT's
// search_result_id must resolve to a pool row, or criterion 3 fails it as "not in source"), then sections, then the Gate A state
// (BEFORE the claims: the last claim write fires set_provenance_status and criterion 7 must find current state), then the claims, then
// the citation edges. Every step's error is checked and named. There is no rollback by design: the caller owns the item row.
import { buildCitationEdges, buildGateARow, upsertGateAState } from "@/core/grounding/gates";
import type { Db } from "@/core/db";

import type { RecordClaim } from "./record-facts/extract";
import type { RecordPayload } from "./record-facts/payload";

export type MintOutcomeClass = "minted_verified" | "minted_unverified";
/** The pass/fail meaning of a FRESH read of provenance_status from the row, never from an RPC's own valid flag (population run #8). */
export const classifyMintOutcome = (rowProvenanceStatus: string | null | undefined): MintOutcomeClass => (rowProvenanceStatus === "verified" ? "minted_verified" : "minted_unverified");

/** The pool-row shape the corpus export reads; a row it cannot use is refused before the insert. */
export function assertPoolRowShape(row: Record<string, unknown>): void {
  for (const f of ["intelligence_item_id", "result_url", "result_content", "result_index"]) if (!(f in row)) throw new Error(`assertPoolRowShape: missing field "${f}"`);
  if (typeof row.intelligence_item_id !== "string" || !row.intelligence_item_id) throw new Error("assertPoolRowShape: intelligence_item_id must be a non-empty string");
  if (typeof row.result_url !== "string" || !row.result_url) throw new Error("assertPoolRowShape: result_url must be a non-empty string");
  if (typeof row.result_content !== "string") throw new Error("assertPoolRowShape: result_content must be a string");
  if (typeof row.result_index !== "number") throw new Error("assertPoolRowShape: result_index must be a number");
}

const buildAgentRunSearchRows = (p: RecordPayload, itemId: string, nowIso: string) =>
  p.search_results.map((r, i) => ({ intelligence_item_id: itemId, search_query: r.search_query ?? null, result_url: r.result_url, result_title: r.result_title ?? null, result_index: typeof r.result_index === "number" ? r.result_index : i, result_content: r.result_content, searched_at: nowIso }));
const buildSectionRows = (p: RecordPayload, itemId: string) => p.sections.map((s) => ({ item_id: itemId, section_key: s.section_key, section_order: s.section_order, content_md: s.content_md, is_conditional: false }));

export interface ClaimInsertRow { section_row_id: string | null; intelligence_item_id: string; claim_text: string; claim_kind: string; source_span: string | null; source_id: string | null; search_result_id: string | null; source_tier_at_grounding: number | null }
/** section_claim_provenance rows: a grounded FACT carries the source, its pool row and the source's tier; everything else carries none. */
function buildClaimRows(p: RecordPayload, itemId: string, c: { sectionIdByKey: Map<string, string>; searchIdByUrl: Map<string, string>; sourceId: string | null; sourceTier: number | null }): ClaimInsertRow[] {
  return p.claims.map((x: RecordClaim) => {
    const grounded = x.claim_kind === "FACT" && !!x.source_span;
    const url = x.source_url ?? null;
    return {
      section_row_id: c.sectionIdByKey.get(x.section_key) ?? null,
      intelligence_item_id: itemId,
      claim_text: x.claim_text,
      claim_kind: x.claim_kind,
      source_span: x.source_span ?? null,
      source_id: grounded && url ? c.sourceId : null,
      search_result_id: grounded && url ? (c.searchIdByUrl.get(url) ?? null) : null,
      source_tier_at_grounding: grounded ? c.sourceTier : null,
    };
  });
}

class WriteSequenceError extends Error {
  readonly step: string;
  constructor(step: string, message: string) {
    super(`write sequence failed at ${step}: ${message}`);
    this.name = "WriteSequenceError";
    this.step = step;
  }
}
async function insertMany<T extends object>(sb: Db, table: string, rows: T[], select: string): Promise<Record<string, unknown>[]> {
  if (!rows.length) return [];
  const { data, error } = await sb.from(table).insert(rows).select(select);
  if (error) throw new WriteSequenceError(table, error.message);
  return (data ?? []) as unknown as Record<string, unknown>[];
}

/** The ordered write (pool, sections, Gate A, claims, citations). Throws WriteSequenceError naming the failed step. */
export async function writeGroundingSequence(sb: Db, payload: RecordPayload, itemId: string, ctx: { sourceId: string | null; sourceTier: number | null; nowIso: string }): Promise<{ searches: number; sections: number; claims: number; citations: number }> {
  const searchRows = buildAgentRunSearchRows(payload, itemId, ctx.nowIso);
  for (const r of searchRows) assertPoolRowShape(r);
  const searches = await insertMany(sb, "agent_run_searches", searchRows, "id, result_url");
  const sections = await insertMany(sb, "intelligence_item_sections", buildSectionRows(payload, itemId), "id, section_key");
  const gateA = await upsertGateAState(sb, buildGateARow({ itemId, fullBrief: String(payload.item.full_brief ?? ""), factClaims: payload.claims.filter((c) => c.claim_kind === "FACT").map((c) => ({ claim_text: c.claim_text, source_span: c.source_span ?? "" })), nowIso: ctx.nowIso }));
  if (gateA.error) throw new WriteSequenceError("item_gate_a_state", gateA.error);
  const claimRows = buildClaimRows(payload, itemId, {
    sectionIdByKey: new Map(sections.map((r) => [String(r.section_key), String(r.id)])),
    searchIdByUrl: new Map(searches.map((r) => [String(r.result_url), String(r.id)])),
    sourceId: ctx.sourceId,
    sourceTier: ctx.sourceTier,
  });
  const claims = await insertMany(sb, "section_claim_provenance", claimRows, "id");
  const citations = await insertMany(sb, "intelligence_item_citations", buildCitationEdges(itemId, claimRows.map((c) => c.source_id), ctx.nowIso), "id");
  return { searches: searches.length, sections: sections.length, claims: claims.length, citations: citations.length };
}
