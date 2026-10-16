// Ported from old_repo/scripts/_reground/executor-ground.mjs (lines 13-31)
// The free injected-ledger grounding entry as a runtime function (no CLI, no exit call, no env file): ground a session-authored
// ledger against the item's stored pool, then read the verdict back with every read CHECKED (the old script read the item and the
// validation result without looking at either error, so a failed read printed "provenance_status: undefined | valid: undefined").
import { runResult, worst, type RunResult } from "@/core/intake/result";

import type { IntakeDeps } from "../deps";
import { groundInjectedLedger } from "../pipeline";

export interface GroundInjectedInput { itemId: string; ledger: unknown; dry?: boolean; replaceLedger?: boolean; batchId?: string | null }
export type GroundInjectedResult = RunResult & { claimsIn: number; provenanceStatus: string | null; valid: boolean | null; failuresByCriterion: Record<string, number>; detail: string };

export async function groundInjected(deps: Pick<IntakeDeps, "sb" | "sources" | "recorder">, input: GroundInjectedInput): Promise<GroundInjectedResult> {
  const { sb } = deps;
  const claimsIn = Array.isArray(input.ledger) ? input.ledger.length : 0;
  const g = await groundInjectedLedger(deps, { itemId: input.itemId, ledger: input.ledger, ...(input.dry ? { dry: true } : {}), ...(input.replaceLedger ? { replaceLedger: true } : {}), ...(input.batchId !== undefined ? { batchId: input.batchId } : {}) });
  const notes = [...g.notes];
  if (input.dry || !g.valid) return { ...runResult(g.outcome, g.counts, notes), claimsIn, provenanceStatus: null, valid: null, failuresByCriterion: {}, detail: g.detail };
  const fin = await sb.from("intelligence_items").select("provenance_status").eq("id", input.itemId).maybeSingle();
  const v = await sb.rpc("validate_item_provenance", { p_item_id: input.itemId });
  let read: RunResult["outcome"] = "ok";
  if (fin.error) {
    notes.push(`provenance read-back failed: ${fin.error.message}`);
    read = "partial";
  }
  if (v.error) {
    notes.push(`validate_item_provenance failed: ${v.error.message}`);
    read = "partial";
  }
  const verdict = (v.data ?? null) as { valid?: boolean; failures?: { criterion: string | number }[] } | null;
  const byC: Record<string, number> = {};
  for (const f of verdict?.failures ?? []) byC[String(f.criterion)] = (byC[String(f.criterion)] ?? 0) + 1;
  return { ...runResult(worst(g.outcome, read), g.counts, notes), claimsIn, provenanceStatus: fin.error ? null : ((fin.data as { provenance_status?: string } | null)?.provenance_status ?? null), valid: v.error ? null : (verdict?.valid ?? null), failuresByCriterion: byC, detail: g.detail };
}
