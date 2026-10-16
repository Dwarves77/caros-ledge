// Ported from old_repo/src/lib/agent/ledger-apply.mjs (lines 1-206)
// Ported from old_repo/src/lib/agent/ledger-dominance.mjs (lines 13-61)
// Ported from old_repo/src/lib/agent/ground-failure-class.mjs (lines 1-22)
// The claim ledger discipline: a non-destructive diff and apply (the prior state is archived to claim_versions BEFORE any change,
// a claim the new grounding does not reproduce is KEPT), erase only with archived proof, the dominance regression guard and the
// ground-failure ladder. Every read and write destructures and acts on `error`: a failed version-number read once returned 1,
// which would have written a duplicate version (B-0060 class).
import type { Db } from "@/core/db";
import { LookupError } from "@/core/http/errors";

export interface ClaimRow {
  id?: string;
  section_row_id?: string | null;
  claim_text: string | null;
  claim_kind: string;
  source_span: string | null;
  source_id: string | null;
  search_result_id?: string | null;
  source_tier_at_grounding: number | null;
  mint_hold_reason?: string | null;
}
export interface Diff { add: ClaimRow[]; change: { existing: ClaimRow; incoming: ClaimRow }[]; unchanged: { existing: ClaimRow; incoming: ClaimRow }[]; notReproduced: ClaimRow[] }
export interface Applied { added: number; changed: number; unchanged: number; notReproduced: number; versioned: number; failed: number; archived: number }
export interface FactTicket { id: string; claim_kind: "FACT"; claim_text: string | null; source_span: string | null; source_id: string | null; source_tier_at_grounding: number | null }

export const normText = (t: unknown): string => String(t == null ? "" : t).trim().replace(/\s+/g, " ").toLowerCase();

/** Same attribution (so a match is UNCHANGED): source, tier, span, section and kind; a different pool ROW is a change, a null on either side is not. */
export function sameAttribution(a: ClaimRow, b: ClaimRow): boolean {
  return (a.source_id ?? null) === (b.source_id ?? null)
    && (a.search_result_id == null || b.search_result_id == null || a.search_result_id === b.search_result_id)
    && (a.source_tier_at_grounding ?? null) === (b.source_tier_at_grounding ?? null)
    && normText(a.source_span) === normText(b.source_span)
    && (a.section_row_id ?? null) === (b.section_row_id ?? null)
    && String(a.claim_kind) === String(b.claim_kind);
}

/** Pure non-destructive diff by normalised claim text. There is no delete in the result: a duplicate within the incoming set collapses. */
export function diffLedger(existing: ClaimRow[] | null | undefined, incoming: ClaimRow[] | null | undefined): Diff {
  const byText = new Map<string, ClaimRow>();
  for (const e of existing ?? []) if (!byText.has(normText(e.claim_text))) byText.set(normText(e.claim_text), e);
  const diff: Diff = { add: [], change: [], unchanged: [], notReproduced: [] };
  const seen = new Set<string>();
  for (const n of incoming ?? []) {
    const k = normText(n.claim_text);
    if (seen.has(k)) continue;
    seen.add(k);
    const e = byText.get(k);
    if (!e) diff.add.push(n);
    else (sameAttribution(e, n) ? diff.unchanged : diff.change).push({ existing: e, incoming: n });
  }
  diff.notReproduced = (existing ?? []).filter((e) => !seen.has(normText(e.claim_text)));
  return diff;
}

const CLAIM_FIELDS = ["section_row_id", "claim_text", "claim_kind", "source_span", "source_id", "search_result_id", "source_tier_at_grounding"] as const;
const claimPayload = (row: ClaimRow, itemId: string): Record<string, unknown> => ({ intelligence_item_id: itemId, ...Object.fromEntries(CLAIM_FIELDS.map((f) => [f, row[f] ?? null])) });
const ticket = (id: string, row: ClaimRow): FactTicket => ({ id, claim_kind: "FACT", claim_text: row.claim_text ?? null, source_span: row.source_span ?? null, source_id: row.source_id ?? null, source_tier_at_grounding: row.source_tier_at_grounding ?? null });
/** Reasons that REMOVE the current row (its current_claim_id becomes null on the archived version). */
const REMOVED = new Set(["proven_inaccurate", "superseded_by_record_briefs"]);

/** The claim_versions row for a claim's prior state (the one shape every archive uses). */
export function versionPayload(existing: ClaimRow, itemId: string, versionNumber: number, reason: string, proof: unknown, nowIso: string | null, note: string | null = null): Record<string, unknown> {
  return {
    current_claim_id: REMOVED.has(reason) ? null : (existing.id ?? null),
    intelligence_item_id: itemId,
    section_row_id: existing.section_row_id ?? null,
    claim_text: existing.claim_text ?? null,
    claim_kind: existing.claim_kind ?? null,
    source_span: existing.source_span ?? null,
    source_id: existing.source_id ?? null,
    search_result_id: existing.search_result_id ?? null,
    source_tier_at_grounding: existing.source_tier_at_grounding ?? null,
    mint_hold_reason: existing.mint_hold_reason ?? null,
    version_number: versionNumber,
    supersede_reason: reason,
    inaccuracy_proof: proof ?? null,
    note,
    superseded_at: nowIso,
  };
}
async function nextVersionNumber(sb: Db, claimId: string): Promise<number> {
  const { data, error } = await sb.from("claim_versions").select("version_number").eq("current_claim_id", claimId).order("version_number", { ascending: false }).limit(1);
  if (error) throw new LookupError("claim_versions", error);
  const top = Array.isArray(data) && data.length ? Number((data[0] as { version_number: unknown }).version_number) : 0;
  return (Number.isFinite(top) ? top : 0) + 1;
}

/**
 * Apply a diff non-destructively. ADD new claims; CHANGE = archive the old state to claim_versions THEN update in place (an archive
 * failure throws before the update: the prior attribution survives); UNCHANGED untouched; NOT-REPRODUCED kept, unless
 * `replaceLedger` (a complete, author-checked ledger: the claim is archived to claim_versions and dropped, and kept if its archive
 * write fails). `touchedFacts` are the FACTs added or changed (the mint-gate input); `applied.failed` counts writes that did not persist.
 */
export async function applyLedgerDiff(sb: Db, itemId: string, diff: Diff, opts: { nowIso?: string | null; replaceLedger?: boolean; batchId?: string | null; dry?: boolean } = {}): Promise<{ currentIds: string[]; touchedFacts: FactTicket[]; applied: Applied; notes: string[] }> {
  const nowIso = opts.nowIso ?? null;
  const currentIds: string[] = [];
  const touchedFacts: FactTicket[] = [];
  const notes: string[] = [];
  const applied: Applied = { added: 0, changed: 0, unchanged: 0, notReproduced: 0, versioned: 0, failed: 0, archived: 0 };
  if (opts.dry) {
    return { currentIds: [], touchedFacts: [], applied: { ...applied, added: diff.add.length, changed: diff.change.length, unchanged: diff.unchanged.length, notReproduced: diff.notReproduced.length }, notes: ["dry: nothing written"] };
  }
  for (const n of diff.add) {
    const { data, error } = await sb.from("section_claim_provenance").insert(claimPayload(n, itemId)).select("id").single();
    if (error) {
      applied.failed += 1;
      notes.push(`add insert failed (${n.claim_kind}): ${error.message}`);
      continue;
    }
    const id = (data as { id?: string } | null)?.id;
    if (id) {
      currentIds.push(id);
      applied.added += 1;
      if (n.claim_kind === "FACT") touchedFacts.push(ticket(id, n));
    }
  }
  for (const { existing, incoming } of diff.change) {
    const vnum = await nextVersionNumber(sb, existing.id as string);
    const v = await sb.from("claim_versions").insert(versionPayload(existing, itemId, vnum, "changed", null, nowIso));
    if (v.error) throw new Error(`change aborted: version archive failed (${existing.id}): ${v.error.message}`);
    applied.versioned += 1;
    const u = await sb.from("section_claim_provenance").update({ ...claimPayload(incoming, itemId), mint_hold_reason: null }).eq("id", existing.id as string);
    if (u.error) {
      applied.failed += 1;
      notes.push(`change update failed (${existing.id}): ${u.error.message}`);
    }
    currentIds.push(existing.id as string);
    applied.changed += 1;
    if (incoming.claim_kind === "FACT") touchedFacts.push(ticket(existing.id as string, incoming));
  }
  for (const { existing } of diff.unchanged) {
    currentIds.push(existing.id as string);
    applied.unchanged += 1;
  }
  for (const e of diff.notReproduced) {
    if (!opts.replaceLedger) {
      currentIds.push(e.id as string);
      applied.notReproduced += 1;
      continue;
    }
    const vnum = await nextVersionNumber(sb, e.id as string);
    const v = await sb.from("claim_versions").insert(versionPayload(e, itemId, vnum, "superseded_by_record_briefs", null, nowIso, opts.batchId ? `batch ${opts.batchId}` : null));
    if (v.error) {
      notes.push(`replace-ledger archive failed (${e.id}); claim kept: ${v.error.message}`);
      currentIds.push(e.id as string);
      applied.notReproduced += 1;
      continue;
    }
    applied.versioned += 1;
    applied.archived += 1;
    const d = await sb.from("section_claim_provenance").delete().eq("id", e.id as string);
    if (d.error) {
      applied.failed += 1;
      notes.push(`replace-ledger delete failed after a successful archive (${e.id}): ${d.error.message}`);
      currentIds.push(e.id as string);
      applied.notReproduced += 1;
    }
  }
  return { currentIds, touchedFacts, applied, notes };
}

/** The ONLY path that erases a current claim: it needs PROOF, the final state with the proof is archived FIRST, and the delete follows only on success. */
export async function eraseClaimWithProof(sb: Db, existing: ClaimRow, itemId: string, proof: { reason: string; [k: string]: unknown }, opts: { nowIso?: string | null } = {}): Promise<{ archivedVersion: number; supersedeReason: "proven_inaccurate" }> {
  if (!existing?.id) throw new Error("eraseClaimWithProof requires an existing claim with an id");
  if (!proof || typeof proof !== "object" || !proof.reason) throw new Error("eraseClaimWithProof requires a proof object with a `reason` (erase-only-on-proven-inaccuracy)");
  const vnum = await nextVersionNumber(sb, existing.id);
  const v = await sb.from("claim_versions").insert(versionPayload(existing, itemId, vnum, "proven_inaccurate", proof, opts.nowIso ?? null));
  if (v.error) throw new Error(`erase aborted: proof archive failed (${existing.id}): ${v.error.message}`);
  const d = await sb.from("section_claim_provenance").delete().eq("id", existing.id);
  if (d.error) throw new Error(`erase delete failed after archive (${existing.id}): ${d.error.message}`);
  return { archivedVersion: vnum, supersedeReason: "proven_inaccurate" };
}

// ---- dominance (INV-158) and the ground-failure ladder -------------------------------------------------------------
export const FACT_FLOOR = 4;
export interface LedgerSummary { total: number; facts: number; floorQualifying: number; wouldVerify?: boolean }
export function summarizeLedger(claims: { claim_kind?: string | null; source_tier_at_grounding?: number | null }[] | null | undefined, itemFloor: number | null = null): LedgerSummary {
  let facts = 0;
  let floorQualifying = 0;
  for (const c of claims ?? []) {
    if (c?.claim_kind !== "FACT") continue;
    facts += 1;
    const t = c.source_tier_at_grounding;
    if (itemFloor != null && typeof t === "number" && t <= itemFloor) floorQualifying += 1;
  }
  return { total: (claims ?? []).length, facts, floorQualifying };
}
const collapsed = (prior: number, next: number, floor: number): boolean => prior >= floor && next < Math.ceil(prior / 2);
/** Would committing `next` over `prior` be weaker on a dominance axis (total, facts, floor-qualifying lost to zero, verified eligibility)? */
export function ledgerRegression(prior: LedgerSummary, next: LedgerSummary, opts: { floor?: number } = {}): { regression: boolean; axes: string[] } {
  const floor = opts.floor ?? FACT_FLOOR;
  const axes: string[] = [];
  if (collapsed(prior.total, next.total, floor)) axes.push("total");
  if (collapsed(prior.facts, next.facts, floor)) axes.push("facts");
  if (prior.facts >= floor && prior.floorQualifying > 0 && next.floorQualifying === 0) axes.push("floor_qualifying");
  if (prior.wouldVerify === true && next.wouldVerify === false) axes.push("verified_eligibility");
  return { regression: axes.length > 0, axes };
}

const DETERMINISTIC = ["ungrounded_url", "missing_required_slot", "fact_below_authority_floor", "analysis_missing_label_syntax", "unlabeled_assertion", "legal_not_routed_to_callout"];
/** Failure detail to the ladder action: structural (a source-less wall, checked FIRST: zero re-research on it), deterministic content flaw, or transient. */
export function groundRetryPlan(detail: string | null | undefined): "structural_hold" | "reresearch_only" | "reground" {
  const d = detail ?? "";
  if (d.includes("no source_id")) return "structural_hold";
  return DETERMINISTIC.some((r) => d.includes(r)) ? "reresearch_only" : "reground";
}
