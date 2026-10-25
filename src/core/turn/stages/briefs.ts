// Ported from old_repo/scripts/turns/theme-briefs/artifact.mjs (lines 1-41)
// Stage 8, briefs: the session-batch kit (FLY-1, ADR-050: the applier of the batches the judgement drain commits). With no input it reads the committed batch files under drain/batches/ (`batchRoot`, default the working directory)
// that the applied_batches ledger has not recorded and applies them; an input names either a batch to apply (`batch: { kind, content, format?, options? }`: record-briefs, question-answers, needs-search, forward-events, theme-briefs, screen-verdicts or
// ledger-verdicts, each validated whole before it is written) or an export to hand a session (`export: { kind, outDir?, limit?, ids? }`: the bundle goes to a scratch directory, never the repo). The kit's apply ends by
// calling its own downstream in the same run; the row this stage returns is the run's record.
import type { FamilyCall } from "@/core/harness";
import { scoreItems } from "@/core/impact/run";
import type { RunResult } from "@/core/types/run-result";
import { runResult, worst } from "@/core/types/run-result";
import { applyBatch, applyCommitted, exportBatch } from "@/features/batches";
import type { BatchDeps, ExportInput } from "@/features/batches";
import { resolvePendingTriggers } from "@/features/obligations";

import type { BuiltDeps } from "../wiring";

export interface Batch {
  kind: string;
  format?: "json" | "md";
  content: string;
  options?: Record<string, unknown>;
}
export interface BriefsPlan {
  batch: Batch | null;
  export: (ExportInput & { kind: string }) | null;
  error: string | null;
}

/** The batch or the export from the stage input, or the reason it is neither. Pure. */
function planBriefs(input: Record<string, unknown>): BriefsPlan {
  const none = { batch: null, export: null };
  if (input.batch !== undefined && input.export !== undefined) return { ...none, error: "give a batch to apply or an export to run, not both" };
  if (input.export !== undefined) {
    const e = input.export as Record<string, unknown>;
    if (typeof e?.kind !== "string") return { ...none, error: "export must carry a string kind" };
    const { kind, outDir, limit, charBudget, ids } = e as { kind: string; outDir?: unknown; limit?: unknown; charBudget?: unknown; ids?: unknown };
    return { batch: null, export: { kind, ...(typeof outDir === "string" ? { outDir } : {}), ...(typeof limit === "number" ? { limit } : {}), ...(typeof charBudget === "number" ? { charBudget } : {}), ...(Array.isArray(ids) ? { ids: ids.filter((x): x is string => typeof x === "string") } : {}) }, error: null };
  }
  if (input.batch === undefined) return { ...none, error: null };
  const b = input.batch as Record<string, unknown>;
  if (typeof b?.kind !== "string" || typeof b.content !== "string") return { ...none, error: "batch must carry a string kind and a string content" };
  return { batch: { kind: b.kind, content: b.content, ...(b.format === "md" ? { format: "md" as const } : {}), ...(b.options && typeof b.options === "object" ? { options: b.options as Record<string, unknown> } : {}) }, export: null, error: null };
}

/** The kit's deps from the turn's: the members it uses, by name. */
export const batchDeps = (d: BuiltDeps): BatchDeps => ({ sb: d.sb, now: d.now, intake: d.intake, verdicts: d.producers.verdicts ?? null });

/** The ids the downstream runs over: the item ids a batch of an item-keyed kind applied, less the ones whose read-back failed. */
const itemIdsOf = (kind: string | null, r: RunResult): string[] => {
  const ids = ((r.data as { ids?: Record<string, string[]> } | undefined)?.ids ?? {});
  return kind === null ? ids.item_ids ?? [] : kind === "record-briefs" || kind === "forward-events" ? (ids.applied_ids ?? []).filter((x) => !(ids.read_back_failed_ids ?? []).includes(x)) : [];
};

/**
 * What an apply hands on, in the same run (rule 17). The kit's own downstream already ran the record briefs' source discovery (growSources per entry, its counts `grow_*`), the tag, term and corpus passes (intersections and theme
 * membership); here the applied items are scored (the propagate stage's scoring step) and their pending regulatory triggers resolved against the captures held. Dry applies nothing, so nothing follows.
 */
async function downstream(call: FamilyCall, d: BuiltDeps, r: RunResult, itemIds: readonly string[]): Promise<RunResult> {
  if (call.dry || !itemIds.length) return r;
  const guard = async (what: string, f: () => Promise<RunResult>): Promise<RunResult> => {
    try { return await f(); } catch (e) { return runResult("failed", {}, [`${what} threw: ${e instanceof Error ? e.message : String(e)}`]); }
  };
  const scores = await guard("scores", () => scoreItems({ sb: d.sb, now: d.now, registry: d.registry }, { dry: false, readIds: itemIds, limit: 0 }));
  const triggers = await guard("pending triggers", () => resolvePendingTriggers({ sb: d.sb, now: d.now }, { dry: false, itemIds }));
  const ids = ((r.data as { ids?: Record<string, string[]> } | undefined)?.ids ?? {});
  const resolved = (triggers.data as { ids?: { resolved_event_ids?: string[] } } | undefined)?.ids?.resolved_event_ids ?? [];
  const scored = (scores.data as { ids?: { scored_item_ids?: string[] } } | undefined)?.ids?.scored_item_ids ?? [];
  const pick = (p: RunResult, prefix: string) => Object.fromEntries(Object.entries(p.counts).map(([k, n]) => [`${prefix}${k}`, n]));
  return { ...r, outcome: worst(r.outcome, scores.outcome, triggers.outcome), counts: { ...r.counts, ...pick(scores, ""), ...pick(triggers, "triggers_") }, notes: [...r.notes, ...scores.notes, ...triggers.notes], data: { ...(r.data as object | undefined), ids: { ...ids, scored_item_ids: scored, resolved_event_ids: resolved } } };
}

export async function runBriefs(call: FamilyCall, d: BuiltDeps): Promise<RunResult> {
  const plan = planBriefs(call.input);
  if (plan.error) return runResult("failed", { refused: 1 }, [plan.error]);
  const deps = batchDeps(d);
  if (plan.export) return exportBatch(plan.export.kind, deps, { ...plan.export, runId: call.runId });
  if (!plan.batch) {
    const root = typeof call.input.batchRoot === "string" ? call.input.batchRoot : process.cwd();
    const r = await applyCommitted(deps, { root, dry: call.dry, runId: call.runId });
    if (!r.counts.batches_found) return runResult(r.outcome, { applied: 0 }, ["no batch given: nothing to apply"]);
    return downstream(call, d, { ...r, counts: { applied: r.counts.applied ?? 0, ...r.counts } }, itemIdsOf(null, r));
  }
  const r = await applyBatch(plan.batch.kind, deps, { content: plan.batch.content, ...(plan.batch.format ? { format: plan.batch.format } : {}), dry: call.dry, runId: call.runId, ...(plan.batch.options ? { options: plan.batch.options } : {}) });
  return downstream(call, d, { ...r, counts: { applied: r.counts.written ?? 0, ...r.counts } }, itemIdsOf(plan.batch.kind, r));
}
