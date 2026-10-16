// Ported from old_repo/scripts/turns/theme-briefs/artifact.mjs (lines 1-41)
// Stage 8, briefs: the session-batch kit. An input names either a batch to apply (`batch: { kind, content, format?, options? }`: record-briefs, question-answers, needs-search, forward-events, theme-briefs, screen-verdicts or
// ledger-verdicts, each validated whole before it is written) or an export to hand a session (`export: { kind, outDir?, limit?, ids? }`: the bundle goes to a scratch directory, never the repo). The kit's apply ends by
// calling its own downstream in the same run; the row this stage returns is the run's record.
import type { FamilyCall } from "@/core/harness";
import type { RunResult } from "@/core/types/run-result";
import { runResult } from "@/core/types/run-result";
import { applyBatch, exportBatch } from "@/features/batches";
import type { BatchDeps, ExportInput } from "@/features/batches";

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
export function planBriefs(input: Record<string, unknown>): BriefsPlan {
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
export const batchDeps = (d: BuiltDeps): BatchDeps => ({ sb: d.sb, now: d.now, intake: d.intake, verdicts: d.producers.verdicts ?? null, flushCache: d.mintRun.flushCache });

export async function runBriefs(call: FamilyCall, d: BuiltDeps): Promise<RunResult> {
  const plan = planBriefs(call.input);
  if (plan.error) return runResult("failed", { refused: 1 }, [plan.error]);
  const deps = batchDeps(d);
  if (plan.export) return exportBatch(plan.export.kind, deps, { ...plan.export, runId: call.runId });
  if (!plan.batch) return runResult("ok", { applied: 0 }, ["no batch given: nothing to apply"]);
  const r = await applyBatch(plan.batch.kind, deps, { content: plan.batch.content, ...(plan.batch.format ? { format: plan.batch.format } : {}), dry: call.dry, runId: call.runId, ...(plan.batch.options ? { options: plan.batch.options } : {}) });
  return { ...r, counts: { applied: r.counts.written ?? 0, ...r.counts } };
}
