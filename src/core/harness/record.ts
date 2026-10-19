// Ported from old_repo/scripts/lib/record-harness-run.mjs (lines 59-180)
// Ported from old_repo/scripts/lib/emit-workflow-run-artifact.mjs (lines 20-26)
// The one recorder: ONE insert into harness_runs per firing, success, noop, refused or failed. It never throws into the runtime; a failed record is
// returned as the run's error and the CLI exits 1. The id is minted here (a uuid), so there is one numbering authority and no file to rename.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { Db } from "@/core/db";
import type { Recorder } from "@/core/producers/deps";

import { familyOf } from "./families";
import { classify, noopContractErrors, type Mode, type Outcome, type Trigger } from "./outcome";

export interface RunRow {
  id: string;
  family: string;
  root_run_id: string;
  upstream_run_id: string | null;
  trigger: Trigger | null;
  mode: Mode | null;
  forced_dry: boolean;
  outcome: Outcome;
  reason: string | null;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  error: string | null;
  code_sha: string | null;
  github_run_id: string | null;
  started_at: string;
  finished_at: string;
}

export const newRunId = (): string => randomUUID();

/** Insert one ledger row. The family must be in FAMILIES, the no-op contract must hold, and finished_at must not precede started_at: a row that breaks any of them is refused, not stored. */
export async function recordRun(sb: Db | null, row: RunRow): Promise<{ id: string | null; error: string | null }> {
  if (!sb) return { id: null, error: "no database client: the run cannot be recorded" };
  const fam = familyOf(row.family);
  if (!fam) return { id: null, error: `family "${row.family}" is not in FAMILIES` };
  const contract = noopContractErrors(row, fam.writes);
  if (contract.length) return { id: null, error: `no-op contract: ${contract.join("; ")}` };
  if (Date.parse(row.finished_at) < Date.parse(row.started_at)) return { id: null, error: "finished_at precedes started_at" };
  try {
    const { error } = await sb.from("harness_runs").insert(row);
    return error ? { id: null, error: `harness_runs insert failed: ${error.message}` } : { id: row.id, error: null };
  } catch (e) {
    return { id: null, error: `harness_runs insert threw: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const FINISH_ATTEMPTS = 3;
const FINISH_BACKOFF_MS = 400;
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Conclude a started run: its one row takes the outcome, the outputs and the finish time. A result that breaks the no-op contract is not stored as claimed; the row concludes `failed` and says why.
 * A failed closing update is tried again (a transient fault must not leave finished work reading `unknown`); after the last attempt it is the run's error, the row stays `unknown` (the evidence the firing began),
 * and the reaper (reap.ts) closes it as crashed once the lease passes. Never throws.
 */
export async function finishRun(sb: Db, row: RunRow, sleep: (ms: number) => Promise<void> = realSleep): Promise<{ row: RunRow; error: string | null }> {
  const fam = familyOf(row.family);
  const broken = fam ? noopContractErrors(row, fam.writes) : [`family "${row.family}" is not in FAMILIES`];
  const final: RunRow = broken.length ? { ...row, outcome: "failed", reason: `unrecordable result: ${broken.join("; ")}`, error: broken.join("; ") } : row;
  let error: string | null = null;
  for (let attempt = 0; attempt < FINISH_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(FINISH_BACKOFF_MS * attempt);
    try {
      const res = await sb.from("harness_runs").update({ outcome: final.outcome, reason: final.reason, outputs: final.outputs, error: final.error, mode: final.mode, forced_dry: final.forced_dry, finished_at: final.finished_at }).eq("id", final.id);
      error = res.error ? `harness_runs update failed: ${res.error.message}` : null;
    } catch (e) {
      error = `harness_runs update threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (!error) break;
  }
  return { row: final, error };
}

/** The run a recorder entry belongs to: the run frame publishes it for the duration of one family call, and the recorder and the dry-aware adapters read it when a runtime records one of its own units (a minted item, a producer run). */
export interface RecorderContext {
  rootRunId: string;
  upstreamRunId: string | null;
  mode: Mode;
  trigger: Trigger | null;
  forcedDry: boolean;
  codeSha: string | null;
  githubRunId: string | null;
}

// The context belongs to the call, not to the deps: two chains that share one set of deps (the worker with concurrency) each see their own run, and nothing outlives the call that set it.
const runContext = new AsyncLocalStorage<RecorderContext>();
/** Run `fn` with `ctx` as the current run; every async continuation of `fn` sees it, nothing else does. */
export const withRunContext = <T>(ctx: RecorderContext, fn: () => T): T => runContext.run(ctx, fn);
/** The run the current call belongs to, or null outside a family call. */
export const currentRunContext = (): RecorderContext | null => runContext.getStore() ?? null;

/** The recorder (structurally the intake RecorderDeps) the intake, mint and producer runtimes take: each entry becomes one ledger row under the running family's root. */
export function makeRecorder(sb: Db | null, now: () => Date): Recorder {
  return {
    now,
    async recordRun(entry) {
      const ctx = currentRunContext();
      const fam = familyOf(entry.family);
      if (!ctx || !fam) return { error: ctx ? `family "${entry.family}" is not in FAMILIES` : "no run is in progress: the entry has no root run to belong to" };
      const at = now().toISOString();
      const result = { outcome: entry.outcome, counts: entry.counts, notes: entry.notes };
      const { outcome, reason } = classify(result, fam.writes, ctx.mode);
      const outputs: Record<string, unknown> = ctx.mode === "dry" ? { planned: entry.counts, notes: entry.notes } : { counts: entry.counts, notes: entry.notes };
      const row: RunRow = { id: newRunId(), family: entry.family, root_run_id: ctx.rootRunId, upstream_run_id: ctx.upstreamRunId, trigger: ctx.trigger, mode: ctx.mode, forced_dry: ctx.forcedDry, outcome, reason, inputs: entry.itemId ? { item_id: entry.itemId } : {}, outputs, error: entry.outcome === "failed" ? (entry.notes[0] ?? "failed") : null, code_sha: ctx.codeSha, github_run_id: ctx.githubRunId, started_at: at, finished_at: at };
      return { error: (await recordRun(sb, row)).error };
    },
  };
}
