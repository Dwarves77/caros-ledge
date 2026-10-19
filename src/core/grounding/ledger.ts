// Ported from old_repo/src/lib/agent/ledger-apply.mjs (lines 1-206)
// Ported from old_repo/src/lib/agent/ledger-dominance.mjs (lines 13-61)
// Ported from old_repo/src/lib/agent/ground-failure-class.mjs (lines 1-22)
// The claim ledger discipline: a non-destructive diff and apply, erase only with archived proof, the dominance regression guard and the ground-failure ladder.
// EVERY write of a claim goes through the database's ledger functions (migration 0074): one call, one transaction, the prior state archived to claim_versions FIRST,
// the version number taken under the claim's row lock, and a FACT accepted only when its capture holds its span and its tier is the one of the source registered on that
// capture's host (reattributeClaim is the single place an attribution is resolved, from the capture and never from the item). A claim the new grounding does not reproduce
// is KEPT. A refusal is returned or thrown with its rule; a failed write is never counted as a success.
import type { Db } from "@/core/db";

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

const normText = (t: unknown): string => String(t == null ? "" : t).trim().replace(/\s+/g, " ").toLowerCase();

/** Same attribution (so a match is UNCHANGED): source, tier, span, section and kind; a different pool ROW is a change, a null on either side is not. */
function sameAttribution(a: ClaimRow, b: ClaimRow): boolean {
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

/** A refusal by the database's ledger functions (migration 0074): the message names the rule that held (attribution refused: span_not_in_capture, source_host_mismatch, ...). Nothing was written. */
class LedgerRefusal extends Error {
  readonly fn: string;
  readonly code: string | undefined;
  constructor(fn: string, message: string, code?: string) {
    super(`${fn}: ${message}`);
    this.name = "LedgerRefusal";
    this.fn = fn;
    this.code = code;
  }
}
async function call<T>(sb: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new LedgerRefusal(fn, error.message, (error as { code?: string }).code);
  return data as T;
}

/** The claim columns a ledger write sends. The TIER is not among them: the database derives it from the source registered on the capture's host (ledger_attribution), so no caller can launder one. */
const ROW_FIELDS = ["section_row_id", "claim_text", "claim_kind", "source_span", "source_id", "search_result_id"] as const;
const rowArgs = (row: ClaimRow): Record<string, unknown> => Object.fromEntries(ROW_FIELDS.map((f) => [f, row[f] ?? null]));
const ticket = (id: string, row: ClaimRow): FactTicket => ({ id, claim_kind: "FACT", claim_text: row.claim_text ?? null, source_span: row.source_span ?? null, source_id: row.source_id ?? null, source_tier_at_grounding: row.source_tier_at_grounding ?? null });

// ---- the ONE writer of a claim's attribution (source_id, tier, search_result_id, source_span) ----------------------------------------
export type LedgerOp =
  | { op: "claim"; claim_id: string | null; row: Record<string, unknown>; note?: string }
  | { op: "remove"; claim_id: string; reason: "proven_inaccurate" | "superseded_by_record_briefs" | "orphaned_no_prose_referent"; proof?: unknown; note?: string }
  | { op: "section_insert"; id: string; section_key: string; section_order: number; content_md: string; is_conditional: boolean }
  | { op: "section_content"; id: string; content_md: string }
  | { op: "brief"; full_brief: string };

/** An ordered list of ledger writes applied as ONE transaction (ledger_apply_ops): each claim change is archived to claim_versions first, and a refusal anywhere leaves the item exactly as it was. */
export function applyLedgerOps(sb: Db, itemId: string, ops: readonly LedgerOp[], nowIso: string | null): Promise<{ claims: number; removed: number; sections: number }> {
  return call(sb, "ledger_apply_ops", { p_item_id: itemId, p_ops: ops, p_now: nowIso });
}

export interface CaptureRef { id: string; url: string }
export interface AttributionCtx {
  /** The registry's source for a URL's host (the one resolver); null when no source is registered there. */
  resolve(url: string): { sourceId: string | null } | null | Promise<{ sourceId: string | null } | null>;
  /** Rule 18: register-and-rate the host of a capture the registry does not know. A null source id means the host cannot be rated (an aggregator, a platform): the FACT stays unrated, never borrows another source. */
  register?(url: string): Promise<{ sourceId: string | null }>;
}
/**
 * THE re-attribution of a claim: the op that stands a FACT on the capture that holds its span. The source, and so the tier, come from THE CAPTURE'S OWN HOST through the registry, never from the item's source: this function is
 * not given the item. The op is applied by the database as one UPDATE inside one transaction with the claim_versions row of the prior state (ledger_apply_ops, alone or with the rest of a pass), and the database re-checks
 * the whole attribution there (the capture holds the span, the source is registered on that host, the tier is that source's) and refuses otherwise, leaving the claim as it was.
 */
export async function reattributeClaim(claim: { id: string }, capture: CaptureRef, span: string, ctx: AttributionCtx, note?: string): Promise<LedgerOp> {
  return { op: "claim", claim_id: claim.id, row: { source_span: span, search_result_id: capture.id, source_id: await sourceForCapture(capture.url, ctx) }, ...(note ? { note } : {}) };
}
/** The source id registered on a capture's own host (registered and rated on the spot when the registry has none and the context may), or null: an unrated host. */
export async function sourceForCapture(url: string, ctx: AttributionCtx): Promise<string | null> {
  const found = await ctx.resolve(url);
  return found?.sourceId ?? (ctx.register ? ((await ctx.register(url)).sourceId ?? null) : null);
}

/**
 * Apply a diff non-destructively. ADD new claims; CHANGE = the database archives the old state to claim_versions THEN updates in place, in one call (a refusal leaves the prior attribution and counts as failed); UNCHANGED untouched;
 * NOT-REPRODUCED kept, unless `replaceLedger` (a complete, author-checked ledger: the claim is archived to claim_versions and dropped in one call, and kept if that fails). `touchedFacts` are the FACTs added or changed that
 * PERSISTED (the mint-gate input); `applied.failed` counts writes that did not persist.
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
  const note = opts.batchId ? `batch ${opts.batchId}` : null;
  const write = (claimId: string | null, row: ClaimRow, extra: Record<string, unknown> = {}) => call<{ id: string }>(sb, "ledger_write_claim", { p_item_id: itemId, p_claim_id: claimId, p_row: { ...rowArgs(row), ...extra }, p_reason: "changed", p_batch: note, p_now: nowIso });
  for (const n of diff.add) {
    try {
      const { id } = await write(null, n);
      currentIds.push(id);
      applied.added += 1;
      if (n.claim_kind === "FACT") touchedFacts.push(ticket(id, n));
    } catch (e) {
      applied.failed += 1;
      notes.push(`add refused (${n.claim_kind}): ${(e as Error).message}`);
    }
  }
  for (const { existing, incoming } of diff.change) {
    try {
      await write(existing.id as string, incoming, { mint_hold_reason: null });
      applied.versioned += 1;
      applied.changed += 1;
      if (incoming.claim_kind === "FACT") touchedFacts.push(ticket(existing.id as string, incoming));
    } catch (e) {
      applied.failed += 1;
      notes.push(`change refused, the prior state stands (${existing.id}): ${(e as Error).message}`);
    }
    currentIds.push(existing.id as string);
  }
  for (const { existing } of diff.unchanged) {
    currentIds.push(existing.id as string);
    applied.unchanged += 1;
  }
  for (const e of diff.notReproduced) {
    if (opts.replaceLedger) {
      try {
        await call(sb, "ledger_remove_claim", { p_claim_id: e.id, p_reason: "superseded_by_record_briefs", p_proof: null, p_note: note, p_now: nowIso });
        applied.versioned += 1;
        applied.archived += 1;
        continue;
      } catch (err) {
        notes.push(`replace-ledger removal refused; claim kept: ${(err as Error).message}`);
        applied.failed += 1;
      }
    }
    currentIds.push(e.id as string);
    applied.notReproduced += 1;
  }
  return { currentIds, touchedFacts, applied, notes };
}

/** The ONLY path that erases a current claim: it needs PROOF, and the database archives the final state with the proof FIRST and deletes in the same transaction. */
export async function eraseClaimWithProof(sb: Db, existing: ClaimRow, _itemId: string, proof: { reason: string; [k: string]: unknown }, opts: { nowIso?: string | null } = {}): Promise<{ archivedVersion: number; supersedeReason: "proven_inaccurate" }> {
  if (!existing?.id) throw new Error("eraseClaimWithProof requires an existing claim with an id");
  if (!proof || typeof proof !== "object" || !proof.reason) throw new Error("eraseClaimWithProof requires a proof object with a `reason` (erase-only-on-proven-inaccuracy)");
  const archivedVersion = await call<number>(sb, "ledger_remove_claim", { p_claim_id: existing.id, p_reason: "proven_inaccurate", p_proof: proof, p_note: null, p_now: opts.nowIso ?? null });
  return { archivedVersion, supersedeReason: "proven_inaccurate" };
}

export interface SectionInput { section_key: string; section_order: number; content_md: string; is_conditional: boolean }
/** Reconcile an item's sections with its brief by key in ONE transaction: the claims of a vanished section are archived to claim_versions before the section (and its cascade) goes. */
export function reconcileSections(sb: Db, itemId: string, sections: readonly SectionInput[], nowIso: string | null): Promise<{ removed: number; claims_archived: number; updated: number; inserted: number }> {
  return call(sb, "ledger_reconcile_sections", { p_item_id: itemId, p_sections: sections, p_now: nowIso });
}
/** The tombstone, every claim archived to claim_versions, then the item: ONE transaction (ledger_erase_item); a failure at any step leaves all three untouched. */
export function eraseItem(sb: Db, itemId: string, e: { disposition: string; mergedInto: string | null; holder: string }, nowIso: string | null = null): Promise<{ claims_archived: number }> {
  return call(sb, "ledger_erase_item", { p_item_id: itemId, p_disposition: e.disposition, p_merged_into: e.mergedInto, p_holder: e.holder, p_now: nowIso });
}

// ---- dominance (INV-158) and the ground-failure ladder -------------------------------------------------------------
const FACT_FLOOR = 4;
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
