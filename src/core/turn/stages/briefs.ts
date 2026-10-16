// Ported from old_repo/scripts/turns/theme-briefs/artifact.mjs (lines 1-41)
// Stage 8, briefs: the session-authored batch kinds that exist in merged slices (a theme brief, a screen-verdict batch), each validated before it is written. The remaining kinds (record briefs, need URLs,
// question answers, extraction output) are the session-batch kit, slice P2-08b: until it is merged they are recorded as refused, never faked.
import type { FamilyCall } from "@/core/harness";
import type { RunResult } from "@/core/types/run-result";
import { runResult } from "@/core/types/run-result";
import { applyScreenVerdictBatch } from "@/features/drain";
import { applyThemeBrief } from "@/features/flywheel";

import type { BuiltDeps } from "../wiring";

export const KIT_KINDS = ["record-briefs", "need-urls", "question-answers", "extraction-output"] as const;
export interface Batch {
  kind: string;
  format?: "json" | "md";
  content: string;
}

/** The batch from the stage input, or the reason it is not one. Pure. */
export function planBriefs(input: Record<string, unknown>): { batch: Batch | null; error: string | null } {
  if (input.batch === undefined) return { batch: null, error: null };
  const b = input.batch as Record<string, unknown>;
  if (typeof b?.kind !== "string" || typeof b.content !== "string") return { batch: null, error: "batch must carry a string kind and a string content" };
  return { batch: { kind: b.kind, content: b.content, ...(b.format === "md" ? { format: "md" as const } : {}) }, error: null };
}

export async function runBriefs(call: FamilyCall, d: BuiltDeps): Promise<RunResult> {
  const { batch, error } = planBriefs(call.input);
  if (error) return runResult("failed", { refused: 1 }, [error]);
  if (!batch) return runResult("ok", { applied: 0 }, ["no batch given: nothing to apply"]);
  const deps = { sb: d.sb, now: d.now };
  if (batch.kind === "theme-brief") {
    const r = await applyThemeBrief(deps, { format: batch.format ?? "json", content: batch.content, dry: call.dry });
    return { ...r, counts: { applied: r.counts.written ?? 0, ...r.counts }, data: { ids: {} } };
  }
  if (batch.kind === "screen-verdicts") {
    let parsed: { verdicts?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(batch.content) as typeof parsed;
    } catch (e) {
      return runResult("failed", { refused: 1 }, [`screen-verdicts batch is not JSON: ${(e as Error).message}`]);
    }
    const r = await applyScreenVerdictBatch(deps, parsed, { dry: call.dry });
    return runResult(r.refused.length ? "partial" : "ok", { applied: r.written, planned: r.planned, refused_rows: r.refused.length }, r.refused);
  }
  const kit = (KIT_KINDS as readonly string[]).includes(batch.kind);
  return runResult("failed", { refused: 1 }, [kit ? `refused: kit not merged: the "${batch.kind}" batch kind belongs to the session-batch kit (P2-08b)` : `refused: unknown batch kind "${batch.kind}"`]);
}
