// Ported from old_repo/scripts/lib/chained-dry-guard.mjs (lines 14-66)
// Ported from old_repo/scripts/lib/upstream-artifact.mjs (lines 56-112)
// Ported from old_repo/scripts/lib/run-artifact.mjs (lines 380-416)
// Ported from old_repo/scripts/maintenance/lib/cli.mjs (lines 70-108)
// The run frame: credentials gate, the kill switch (read first), mode resolution, the upstream hand-off, the call, and the one record. Every firing leaves one row.
import { missingServiceEnv, type Db } from "@/core/db";
import { readScrapeState } from "@/core/fetch/hold";
import type { RunResult } from "@/core/types/run-result";

import { skipVerdict, type Exit } from "./exit";
import { familyOf } from "./families";
import { classify, countsOf, noopContractErrors, type Mode, type Outcome, type Trigger } from "./outcome";
import { IN_PROGRESS, reapStaleRuns } from "./reap";
import { finishRun, newRunId, recordRun, withRunContext, type RunRow } from "./record";

/** The integrity flag a fleet-wide hard stop is raised under (rule 11, docs/runbooks/fleet-budget-control.md). */
export const KILL_SWITCH_REF = "fleet-budget-halt";

/** Is the hard stop up? Read first by every family. A failed read counts as halted: an unknown stop is a stop. */
export async function halted(sb: Db): Promise<{ halted: boolean; reason: string | null }> {
  const { data, error } = await sb.from("integrity_flags").select("id").eq("subject_ref", KILL_SWITCH_REF).eq("status", "open").limit(1);
  if (error) return { halted: true, reason: `kill switch unreadable (${error.message}): refusing` };
  return (data ?? []).length > 0 ? { halted: true, reason: `an open ${KILL_SWITCH_REF} flag is up` } : { halted: false, reason: null };
}

export interface Upstream {
  id: string;
  family: string;
  outcome: Outcome;
  mode: Mode | null;
  ids: Record<string, string[]>;
  counts: Record<string, number>;
}
/** What a family function is given. `dry` is the resolved mode, never the requested one. */
export interface FamilyCall {
  mode: Mode;
  dry: boolean;
  input: Record<string, unknown>;
  runId: string;
  rootRunId: string;
  upstream: Upstream | null;
}
export type FamilyFn = (call: FamilyCall) => Promise<RunResult>;

export interface HarnessDeps {
  sb: Db | null;
  env: Record<string, string | undefined>;
  now(): Date;
  /** The registry: family name to its function (IMP-030: every runtime entry registers itself in one list). */
  fns: Readonly<Record<string, FamilyFn>>;
  /** Waits between the attempts to conclude a started run; absent, real time. A test passes an immediate one. */
  sleep?(ms: number): Promise<void>;
}
export interface RunRequest {
  mode: Mode;
  trigger: Trigger;
  input?: Record<string, unknown>;
  id?: string;
  rootRunId?: string;
  upstreamRunId?: string | null;
  /** The modes resolved once by the caller (a turn reads the build-mode gate once); absent, the frame resolves them. */
  resolved?: ModeGate;
}
export interface Resolved {
  mode: Mode;
  forcedDry: boolean;
  reason: string | null;
}
export interface FamilyRun {
  /** 0 recorded and not failed, 1 a family that failed (its row says so) or a record or credential failure, 2 self-skipped for lack of credentials where the event cannot carry them (src/core/harness/exit.ts). */
  exit: Exit;
  row: RunRow | null;
  result: RunResult | null;
  error: string | null;
}

/** The mode a request resolves to, for the two kinds of family. Apply needs an operator dispatch (or a hop of one's chain); anything else runs dry and says so. A family that FETCHES also needs the scrape cadence on (rule 16 is about scraping: with the cadence off
 * the fetching families run dry and the analysis families work on stored data in the requested mode). The emergency stop and an unreadable system state hold every family: an unknown stop is a stop. The state is read once for both. */
export interface ModeGate {
  fetching: Resolved;
  analysis: Resolved;
}
export async function resolveModes(sb: Db, req: Pick<RunRequest, "mode" | "trigger">): Promise<ModeGate> {
  const dry = (reason: string | null, forcedDry: boolean): Resolved => ({ mode: "dry", forcedDry, reason });
  if (req.mode === "dry") return { fetching: dry(null, false), analysis: dry(null, false) };
  let state;
  try {
    state = await readScrapeState(sb);
  } catch (e) {
    const unreadable = dry(`forced dry: the scrape cadence is unreadable (${e instanceof Error ? e.message : String(e)}); an unknown state is treated as closed`, true);
    return { fetching: unreadable, analysis: unreadable };
  }
  const machine = req.trigger !== "dispatch" && req.trigger !== "manual" && req.trigger !== "chained" ? `forced dry: a ${req.trigger} firing is machine-fired and apply needs an operator dispatch` : null;
  const apply: Resolved = { mode: "apply", forcedDry: false, reason: null };
  const stopped = state.emergencyPaused ? "forced dry: scrape cadence is under the emergency stop (build mode, rule 16)" : null;
  const closed = stopped ?? (state.cadence === "off" ? "forced dry: scrape cadence is off (build mode, rule 16)" : null) ?? machine;
  const held = stopped ?? machine;
  return { fetching: closed ? dry(closed, true) : apply, analysis: held ? dry(held, true) : apply };
}
/** One family kind's resolution (a fetching family by default: the stricter gate). */
export async function resolveMode(sb: Db, req: Pick<RunRequest, "mode" | "trigger">, fetches = true): Promise<Resolved> {
  return (await resolveModes(sb, req))[fetches ? "fetching" : "analysis"];
}

type UpstreamRead = { ok: true; row: Upstream } | { ok: false; outcome: Outcome; reason: string };

/** Read the upstream row by id AND root, and decide whether this family may proceed: it must be a declared hand-off and obey the no-op contract (a forged success is refused); a failed or skipped upstream stops the chain. */
async function readUpstream(sb: Db, name: string, rootRunId: string, id: string): Promise<UpstreamRead> {
  const { data, error } = await sb.from("harness_runs").select("id,family,outcome,mode,reason,outputs").eq("id", id).eq("root_run_id", rootRunId).maybeSingle();
  if (error) return { ok: false, outcome: "refused", reason: `upstream row unreadable (${error.message}): refusing` };
  if (!data) return { ok: false, outcome: "refused", reason: `no upstream row ${id} under root ${rootRunId}: nothing to chain from` };
  const up = data as { id: string; family: string; outcome: Outcome; mode: Mode | null; reason: string | null; outputs: Record<string, unknown> | null };
  const upFam = familyOf(up.family);
  if (!upFam?.downstream.includes(name)) return { ok: false, outcome: "refused", reason: `${up.family} does not hand off to ${name}: not a declared downstream` };
  const outputs = up.outputs ?? {};
  const contract = noopContractErrors({ outcome: up.outcome, mode: up.mode, outputs }, upFam.writes);
  if (contract.length) return { ok: false, outcome: "refused", reason: `upstream ${up.family} ${up.id} breaks the no-op contract (${contract.join("; ")}): the chain stops here` };
  // A failed stage (or one that was itself skipped for it) stops the chain. A refused or no-op stage hands nothing over and the next stage runs on its own selection: a producer held by its gate must not stop the turn, and a mint refused by THE GATE must not stop the connect that closes the backlog.
  if (up.outcome === "failed" || up.outcome === "unknown" || (up.outcome === "noop" && outputs.skipped === true)) return { ok: false, outcome: "noop", reason: `upstream ${up.family} did not run: ${up.outcome}${up.reason ? ` (${up.reason})` : ""}` };
  return { ok: true, row: { id: up.id, family: up.family, outcome: up.outcome, mode: up.mode, ids: (outputs.ids ?? {}) as Record<string, string[]>, counts: countsOf(outputs) } };
}

/** Run one family once. Always records exactly one row, except without credentials: a self-skip locally (exit 2) and a loud failure in CI (exit 1). */
export async function runFamily(name: string, req: RunRequest, h: HarnessDeps): Promise<FamilyRun> {
  const fam = familyOf(name);
  if (!fam) throw new Error(`runFamily: "${name}" is not in FAMILIES`);
  if (!h.sb) {
    const verdict = skipVerdict(h.env, missingServiceEnv(h.env));
    return { exit: verdict.exit, row: null, result: null, error: `no database credentials: ${name} ${verdict.message}` };
  }
  const fn = h.fns[name];
  if (!fn) throw new Error(`runFamily: family "${name}" has no registered function`);
  const sb = h.sb;
  const id = req.id ?? newRunId();
  const rootRunId = req.rootRunId ?? id;
  const startedAt = h.now().toISOString();
  const code = { code_sha: h.env.GITHUB_SHA ?? null, github_run_id: h.env.GITHUB_RUN_ID ?? null };
  let started = false;
  const finish = async (outcome: Outcome, mode: Mode | null, forcedDry: boolean, extra: Partial<RunRow>, result: RunResult | null): Promise<FamilyRun> => {
    const row: RunRow = { id, family: name, root_run_id: rootRunId, upstream_run_id: req.upstreamRunId ?? null, trigger: req.trigger, mode, forced_dry: forcedDry, outcome, reason: null, inputs: req.input ?? {}, outputs: {}, error: null, ...code, started_at: startedAt, finished_at: h.now().toISOString(), ...extra };
    if (started) {
      const done = await finishRun(sb, row, h.sleep);
      return { exit: done.error || outcome === "failed" ? 1 : 0, row: done.error ? null : done.row, result, error: done.error };
    }
    const rec = await recordRun(sb, row);
    return { exit: rec.error || outcome === "failed" ? 1 : 0, row: rec.error ? null : row, result, error: rec.error };
  };

  const stop = await halted(sb);
  if (stop.halted) return finish("refused", null, false, { reason: stop.reason, outputs: { skipped: true, halted: true } }, null);
  const resolved = (req.resolved ?? (await resolveModes(sb, req)))[fam.fetches ? "fetching" : "analysis"];
  let upstream: Upstream | null = null;
  if (req.upstreamRunId) {
    const up = await readUpstream(sb, name, rootRunId, req.upstreamRunId);
    if (!up.ok) return finish(up.outcome, resolved.mode, resolved.forcedDry, { reason: up.reason, outputs: { skipped: true } }, null);
    upstream = up.row;
  }
  const dry = resolved.mode === "dry";
  const context = { rootRunId, upstreamRunId: req.upstreamRunId ?? null, mode: resolved.mode, trigger: req.trigger, forcedDry: resolved.forcedDry, codeSha: code.code_sha, githubRunId: code.github_run_id };
  // The row exists before the function runs (outcome `unknown`): anything the run stores that points at it (a graph snapshot) has its parent, a crash leaves the evidence that the firing began, and a run that cannot be recorded does not run.
  const begun = await recordRun(sb, { id, family: name, root_run_id: rootRunId, upstream_run_id: req.upstreamRunId ?? null, trigger: req.trigger, mode: resolved.mode, forced_dry: resolved.forcedDry, outcome: "unknown", reason: IN_PROGRESS, inputs: req.input ?? {}, outputs: {}, error: null, ...code, started_at: startedAt, finished_at: startedAt });
  if (begun.error) return { exit: 1, row: null, result: null, error: begun.error };
  started = true;
  let result: RunResult;
  try {
    result = await withRunContext(context, () => fn({ mode: resolved.mode, dry, input: req.input ?? {}, runId: id, rootRunId, upstream }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return finish("failed", resolved.mode, resolved.forcedDry, { reason: msg, error: msg, outputs: dry ? { planned: {}, notes: [msg] } : { counts: {}, notes: [msg] } }, null);
  }
  const { outcome, reason } = classify(result, fam.writes, resolved.mode);
  const ids = (result.data as { ids?: Record<string, string[]> } | undefined)?.ids;
  const outputs: Record<string, unknown> = { ...(dry ? { planned: result.counts } : { counts: result.counts }), notes: result.notes.slice(0, 50), ...(ids ? { ids } : {}) };
  return finish(outcome, resolved.mode, resolved.forcedDry, { reason: resolved.reason ?? reason, error: outcome === "failed" ? (result.notes[0] ?? "failed") : null, outputs }, result);
}

/** Run families in order under one root: each is the previous one's downstream and takes its row as upstream; each resolves its own mode from the requested one (a held fetching stage does not hold the analysis behind it). The head's id is the root. */
export async function runChain(plan: readonly string[], req: RunRequest, h: HarnessDeps, inputs: Readonly<Record<string, Record<string, unknown>>> = {}): Promise<FamilyRun[]> {
  const runs: FamilyRun[] = [];
  if (h.sb) await reapStaleRuns(h.sb, h.now()); // a firing that began and never concluded (its process died) is closed as crashed before this chain adds its own rows
  const root = req.rootRunId ?? newRunId();
  let prev: FamilyRun | null = null;
  for (const [i, name] of plan.entries()) {
    const run: FamilyRun = await runFamily(name, { ...req, input: inputs[name] ?? req.input ?? {}, mode: req.mode, trigger: i === 0 ? req.trigger : "chained", rootRunId: root, ...(i === 0 ? { id: root } : {}), upstreamRunId: prev?.row?.id ?? null }, h);
    runs.push(run);
    if (run.exit !== 0) {
      // A family that failed and was recorded leaves one refused row for every family behind it, so the ledger shows the whole chain and the job is red.
      if (h.sb && run.row?.outcome === "failed") for (const behind of plan.slice(i + 1)) runs.push(await recordRefusedBehind(h.sb, behind, run.row, root, h.now()));
      break;
    }
    prev = run;
  }
  return runs;
}

/** The row of a family that did not run because an upstream family failed: outcome refused, the failed row as its upstream, nothing written. */
async function recordRefusedBehind(sb: Db, name: string, failed: RunRow, rootRunId: string, now: Date): Promise<FamilyRun> {
  const at = now.toISOString();
  const row: RunRow = { id: newRunId(), family: name, root_run_id: rootRunId, upstream_run_id: failed.id, trigger: "chained", mode: failed.mode, forced_dry: failed.forced_dry, outcome: "refused", reason: `upstream ${failed.family} failed`, inputs: {}, outputs: { skipped: true }, error: null, code_sha: failed.code_sha, github_run_id: failed.github_run_id, started_at: at, finished_at: at };
  const rec = await recordRun(sb, row);
  return { exit: rec.error ? 1 : 0, row: rec.error ? null : row, result: null, error: rec.error };
}
