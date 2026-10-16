// Ported from old_repo/scripts/lib/chained-dry-guard.mjs (lines 14-66)
// Ported from old_repo/scripts/lib/upstream-artifact.mjs (lines 56-112)
// Ported from old_repo/scripts/lib/run-artifact.mjs (lines 380-416)
// Ported from old_repo/scripts/maintenance/lib/cli.mjs (lines 70-108)
// The run frame: credentials gate, the kill switch (read first), mode resolution, the upstream hand-off, the call, and the one record. Every firing leaves one row.
import type { Db } from "@/core/db";
import { getScrapeState } from "@/core/fetch/hold";
import type { RunResult } from "@/core/types/run-result";

import { familyOf } from "./families";
import { classify, noopContractErrors, type Mode, type Outcome, type Trigger } from "./outcome";
import { newRunId, recordRun, type RecorderContext, type RunRow } from "./record";

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
  /** The frame publishes the running run here so the recorder the runtimes call can write their unit rows under it. */
  setContext?(ctx: RecorderContext | null): void;
}
export interface RunRequest {
  mode: Mode;
  trigger: Trigger;
  input?: Record<string, unknown>;
  id?: string;
  rootRunId?: string;
  upstreamRunId?: string | null;
  /** The mode resolved once by the caller (a turn reads the build-mode gate once); absent, the frame resolves it. */
  resolved?: Resolved;
}
export interface Resolved {
  mode: Mode;
  forcedDry: boolean;
  reason: string | null;
}
export interface FamilyRun {
  /** 0 recorded, 1 a record or credential failure (CI), 2 self-skipped for lack of credentials. */
  exit: 0 | 1 | 2;
  row: RunRow | null;
  result: RunResult | null;
  error: string | null;
}

const isCi = (env: Record<string, string | undefined>): boolean => env.CI === "true" || env.GITHUB_ACTIONS === "true";

/** The mode a request resolves to. Apply needs an operator dispatch (or a hop of one's chain) AND the cadence on; anything else runs dry and says so. A cadence read error is off. */
export async function resolveMode(sb: Db, req: Pick<RunRequest, "mode" | "trigger">): Promise<Resolved> {
  if (req.mode === "dry") return { mode: "dry", forcedDry: false, reason: null };
  const state = await getScrapeState(sb);
  if (state.cadence === "off" || state.emergencyPaused) return { mode: "dry", forcedDry: true, reason: `forced dry: scrape cadence is ${state.emergencyPaused ? "under the emergency stop" : "off"} (build mode, rule 16)` };
  if (req.trigger !== "dispatch" && req.trigger !== "manual" && req.trigger !== "chained") return { mode: "dry", forcedDry: true, reason: `forced dry: a ${req.trigger} firing is machine-fired and apply needs an operator dispatch` };
  return { mode: "apply", forcedDry: false, reason: null };
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
  if (up.outcome === "failed" || (up.outcome === "noop" && outputs.skipped === true)) return { ok: false, outcome: "noop", reason: `upstream ${up.family} did not run: ${up.outcome}${up.reason ? ` (${up.reason})` : ""}` };
  return { ok: true, row: { id: up.id, family: up.family, outcome: up.outcome, mode: up.mode, ids: (outputs.ids ?? {}) as Record<string, string[]>, counts: (outputs.counts ?? outputs.planned ?? {}) as Record<string, number> } };
}

/** Run one family once. Always records exactly one row, except without credentials: a self-skip locally (exit 2) and a loud failure in CI (exit 1). */
export async function runFamily(name: string, req: RunRequest, h: HarnessDeps): Promise<FamilyRun> {
  const fam = familyOf(name);
  if (!fam) throw new Error(`runFamily: "${name}" is not in FAMILIES`);
  if (!h.sb) {
    const ci = isCi(h.env);
    return { exit: ci ? 1 : 2, row: null, result: null, error: `no database credentials: ${name} ${ci ? "fails loud in CI" : "self-skipped"}` };
  }
  const fn = h.fns[name];
  if (!fn) throw new Error(`runFamily: family "${name}" has no registered function`);
  const sb = h.sb;
  const id = req.id ?? newRunId();
  const rootRunId = req.rootRunId ?? id;
  const startedAt = h.now().toISOString();
  const code = { code_sha: h.env.GITHUB_SHA ?? null, github_run_id: h.env.GITHUB_RUN_ID ?? null };
  const finish = async (outcome: Outcome, mode: Mode | null, forcedDry: boolean, extra: Partial<RunRow>, result: RunResult | null): Promise<FamilyRun> => {
    const row: RunRow = { id, family: name, root_run_id: rootRunId, upstream_run_id: req.upstreamRunId ?? null, trigger: req.trigger, mode, forced_dry: forcedDry, outcome, reason: null, inputs: req.input ?? {}, outputs: {}, error: null, ...code, started_at: startedAt, finished_at: h.now().toISOString(), ...extra };
    const rec = await recordRun(sb, row);
    h.setContext?.(null);
    return { exit: rec.error ? 1 : 0, row: rec.error ? null : row, result, error: rec.error };
  };

  const stop = await halted(sb);
  if (stop.halted) return finish("refused", null, false, { reason: stop.reason, outputs: { skipped: true, halted: true } }, null);
  const resolved = req.resolved ?? (await resolveMode(sb, req));
  let upstream: Upstream | null = null;
  if (req.upstreamRunId) {
    const up = await readUpstream(sb, name, rootRunId, req.upstreamRunId);
    if (!up.ok) return finish(up.outcome, resolved.mode, resolved.forcedDry, { reason: up.reason, outputs: { skipped: true } }, null);
    upstream = up.row;
  }
  const dry = resolved.mode === "dry";
  h.setContext?.({ rootRunId, upstreamRunId: req.upstreamRunId ?? null, mode: resolved.mode, trigger: req.trigger, forcedDry: resolved.forcedDry, codeSha: code.code_sha, githubRunId: code.github_run_id });
  let result: RunResult;
  try {
    result = await fn({ mode: resolved.mode, dry, input: req.input ?? {}, runId: id, rootRunId, upstream });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return finish("failed", resolved.mode, resolved.forcedDry, { reason: msg, error: msg, outputs: dry ? { planned: {}, notes: [msg] } : { counts: {}, notes: [msg] } }, null);
  }
  const { outcome, reason } = classify(result, fam.writes, resolved.mode);
  const ids = (result.data as { ids?: Record<string, string[]> } | undefined)?.ids;
  const outputs: Record<string, unknown> = { ...(dry ? { planned: result.counts } : { counts: result.counts }), notes: result.notes.slice(0, 50), ...(ids ? { ids } : {}) };
  return finish(outcome, resolved.mode, resolved.forcedDry, { reason: resolved.reason ?? reason, error: outcome === "failed" ? (result.notes[0] ?? "failed") : null, outputs }, result);
}

/** Run families in order under one root: each is the previous one's downstream, takes its row as upstream, and inherits its resolved mode. The head's id is the root. */
export async function runChain(plan: readonly string[], req: RunRequest, h: HarnessDeps, inputs: Readonly<Record<string, Record<string, unknown>>> = {}): Promise<FamilyRun[]> {
  const runs: FamilyRun[] = [];
  const root = req.rootRunId ?? newRunId();
  let prev: FamilyRun | null = null;
  for (const [i, name] of plan.entries()) {
    const run: FamilyRun = await runFamily(name, { ...req, input: inputs[name] ?? req.input ?? {}, mode: prev?.row?.mode ?? req.mode, trigger: i === 0 ? req.trigger : "chained", rootRunId: root, ...(i === 0 ? { id: root } : {}), upstreamRunId: prev?.row?.id ?? null }, h);
    runs.push(run);
    if (run.exit !== 0) break;
    prev = run;
  }
  return runs;
}
