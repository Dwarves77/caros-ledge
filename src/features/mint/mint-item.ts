// Ported from old_repo/src/lib/intake/mint-item.ts (lines 248-445)
// Ported from old_repo/scripts/mint/apply-mint-batch.mjs (lines 204-241)
// Ported from old_repo/scripts/mint/apply-mint-batch.mjs (lines 340-400)
// THE mint function: the only runtime INSERT into intelligence_items (INV-169). The gates run first and are shared by dry and apply; then the single insert (markers
// never persist); then, for a record payload, intake's ordered grounding write (item, searches, sections, Gate A, claims, citations) with a CHECKED compensating delete on
// any failure, so a failed write leaves no item row (INV-295); then the flywheel participation list, which calls `connect.connect(itemId)` exactly once (rule 17).
// Nothing in the post-insert surfacing is swallowed: every failure is a recorded defect flag or a returned note.
import { assertNoInternalMarkers } from "@/core/brief";
import type { Db } from "@/core/db";
import { runParticipation, writeGroundingSequence } from "@/features/intake";
import type { ConnectDeps } from "@/features/intake";

import { runGates } from "./gates";
import type { EntityDeps } from "./deps";
import type { MintInput, MintResult, RecordPayload } from "./types";

export interface MintCtx { sb: Db; entities: EntityDeps; connect: ConnectDeps; now(): Date }
/** A MintInput that may carry the record payload whose grounding rows are written in the same call (the batch path). */
export type MintRequest = MintInput & { payload?: RecordPayload | undefined; sourceTier?: number | null | undefined };
export interface MintDetail extends MintResult {
  /** The grounding rows written (batch path only). */
  written?: { searches: number; sections: number; claims: number; citations: number };
  /** Participation counts and notes from the flywheel step list. */
  participation?: { counts: Record<string, number>; notes: string[]; outcome: string };
}
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Delete a half-written item and CHECK the row is gone (children cascade). Returns a note naming what is left when it is not. */
async function compensate(sb: Db, itemId: string): Promise<string> {
  const del = await sb.from("intelligence_items").delete().eq("id", itemId);
  if (del.error) return `cleanup_failed: ${del.error.message}`;
  const left = await sb.from("intelligence_items").select("id").eq("id", itemId).maybeSingle();
  if (left.error) return `cleanup_unverified: ${left.error.message}`;
  return left.data ? "cleanup_failed: item row still present after delete" : "partial_item_deleted";
}

export async function mintItem(input: MintRequest, ctx: MintCtx, opts: { dry: boolean }): Promise<MintDetail> {
  const gate = await runGates(ctx.sb, ctx.entities, { seed: input.seed, legacyId: input.legacyId, relevance: input.relevance, grade: input.grade });
  if (gate.stop) return { itemId: gate.itemId, outcome: gate.outcome, reasons: [...gate.flags, gate.error] };
  const { seed, flags } = gate;
  const outcome = gate.linkTargetId ? "linked" : gate.retyped ? "retyped" : "minted";
  try {
    if (typeof seed.full_brief === "string") assertNoInternalMarkers(seed.full_brief, "mintItem");
  } catch (e) {
    return { itemId: null, outcome: "rejected", reasons: [...flags, `markers: ${msg(e)}`] };
  }
  if (opts.dry) return { itemId: null, outcome, reasons: [...flags, "dry"] };

  const ins = await ctx.sb.from("intelligence_items").insert(seed).select("id").single();
  const itemId = (ins.data as { id?: string } | null)?.id;
  if (ins.error || !itemId) return { itemId: null, outcome: "rejected", reasons: [...flags, `insert failed: ${ins.error?.message ?? "no row returned"}`] };

  const detail: MintDetail = { itemId, outcome, reasons: [...flags] };
  if (input.payload) {
    try {
      detail.written = await writeGroundingSequence(ctx.sb, input.payload, itemId, { sourceId: (seed.source_id as string | null) ?? null, sourceTier: input.sourceTier ?? null, nowIso: ctx.now().toISOString() });
    } catch (e) {
      const cleanup = await compensate(ctx.sb, itemId);
      return { itemId: cleanup === "partial_item_deleted" ? null : itemId, outcome: "rejected", reasons: [...flags, msg(e), cleanup] };
    }
  }
  const part = await runParticipation(
    { sb: ctx.sb, connect: ctx.connect, now: ctx.now },
    { itemId, context: "mint", mint: { title: typeof seed.title === "string" ? seed.title : null, sourceUrl: typeof seed.source_url === "string" ? seed.source_url : null, linkTargetItemId: gate.linkTargetId, seekStudy: gate.seekStudy, lowRelevance: gate.lowRelevance } },
  );
  detail.reasons.push(...part.flags);
  detail.participation = { counts: part.counts, notes: part.notes, outcome: part.outcome };
  return detail;
}

/** The MintDeps shape intake calls (`mintItem(input, { dry })`), bound to this slice's context. */
export const bindMint = (ctx: MintCtx) => ({ mintItem: (input: MintInput, opts: { dry: boolean }): Promise<MintResult> => mintItem(input, ctx, opts) });
