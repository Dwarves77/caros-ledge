// The public surface of the mint family. `mintItem` is the ONE function that inserts an item; `bindMint` gives intake the MintDeps shape. The runtimes are
// (deps, input) entries that return counts, an outcome and notes; none of them reads the wall clock except through deps.now or exits the process.
export { applyPayload, holdRow, isReopenTarget, reconcileRow, reopenHeldRows } from "./apply";
export { buildPayload } from "./build-payload";
export { runGates } from "./gates";
export type { ConnectDeps, CorpusRow, EntityDeps, MintRunDeps, RecorderDeps } from "./deps";
export { healItem, healQuarantined, rederiveStale } from "./heal/run";
export type { HealDeps, HealItemInput, HealItemResult, HealSweepInput } from "./heal/run";
export { bindMint, mintItem } from "./mint-item";
export type { MintCtx, MintDetail, MintRequest } from "./mint-item";
export { preflight } from "./preflight";
export { runMint } from "./run";
export type { MintRunInput, MintRunResult } from "./run";
export { loadReviewedVerdicts, screenVerdictFor } from "./screen";
export { buildHeldIndex, isHeld, readHolders, resolveLimit, selectCensusRows } from "./select";
export { HOLD_STAGES } from "./types";
export type { CensusRow, ExportRow, Hold, MintInput, MintResult, RecordPayload, Screen } from "./types";
export { classifyMintOutcome } from "@/features/intake/write-item";

import type { RunResult } from "@/core/intake/result";
import { runResult } from "@/core/intake/result";

import { reopenHeldRows } from "./apply";
import type { MintRunDeps } from "./deps";

/** Re-admit held census rows whose reason contains the stated text (INV-028: never a blanket reopen). */
export async function reopenHolds(deps: Pick<MintRunDeps, "sb" | "now">, input: { reasonContains: string; dry?: boolean }): Promise<RunResult> {
  try {
    const r = await reopenHeldRows(deps.sb, input.reasonContains, { dry: input.dry ?? true, nowIso: deps.now().toISOString() });
    return runResult(r.failures.length ? "partial" : "ok", { matched: r.matched, written: r.written, failed: r.failures.length }, r.failures);
  } catch (e) {
    return runResult("failed", {}, [e instanceof Error ? e.message : String(e)]);
  }
}
