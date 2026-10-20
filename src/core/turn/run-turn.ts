// Ported from old_repo/scripts/turns/run-source-sweep.mjs (lines 1009-1423)
// Ported from old_repo/scripts/turns/run-population-flywheel.mjs (lines 1466-1607)
// The one turn runtime: an ordered stage plan, the build-mode gate read once, one root run id, one ledger row per stage, each stage the next one's upstream. A stage that is asked for runs its
// downstream stages too (rule 17) unless the dispatch says `chain: false`, and the row then says so.
import { familyOf, resolveModes, runChain, type FamilyRun, type HarnessDeps, type Mode, type ModeGate, type Resolved, type Trigger } from "@/core/harness";
import { newRunId } from "@/core/harness";

import { familyFns, familyOfStage, isStage, STAGES, type Stage } from "./registry";
import type { BuiltDeps } from "./wiring";

export interface TurnRequest {
  /** A stage, `all`, or `ops` (one operator task, named in the input, outside the chain). */
  stage: Stage | "all" | "ops";
  mode: Mode;
  trigger?: Trigger;
  /** Run only the named stage when false; the default runs it and everything after it. */
  chain?: boolean;
  /** Per-stage input, keyed by stage name. */
  input?: Partial<Record<Stage | "ops", Record<string, unknown>>>;
}
export interface TurnResult {
  rootRunId: string;
  plan: (Stage | "ops")[];
  resolved: Resolved;
  runs: FamilyRun[];
  /** 0 every stage recorded, 1 a failed record or credential in CI, 2 self-skipped for lack of credentials. */
  exit: 0 | 1 | 2;
  /** What the turn's reference data read degraded (host_verdicts or market_series_items absent or unreadable): stated, never a silent empty. */
  notes: string[];
}

/** The stages a request runs: all of them, or the named one and (unless chain is false) its downstream stages. Pure. */
function planTurn(stage: Stage | "all" | "ops", chain = true): (Stage | "ops")[] {
  if (stage === "all") return [...STAGES];
  if (stage === "ops") return ["ops"];
  if (!isStage(stage)) throw new Error(`unknown stage "${stage}" (stages: ${STAGES.join(", ")})`);
  return chain ? STAGES.slice(STAGES.indexOf(stage)) : [stage];
}

export async function runTurn(req: TurnRequest, target: { d: BuiltDeps | null; env: Record<string, string | undefined>; now: () => Date }): Promise<TurnResult> {
  const plan = planTurn(req.stage, req.chain !== false);
  const trigger = req.trigger ?? "dispatch";
  const rootRunId = newRunId();
  const d = target.d;
  const h: HarnessDeps = { sb: d?.sb ?? null, env: target.env, now: target.now, fns: d ? familyFns(d) : {} };
  // The build-mode gate is read ONCE: every stage of this turn runs in the mode it resolves, and every row says why.
  const notes = d ? await d.loadReferenceData() : [];
  const open: Resolved = { mode: req.mode, forcedDry: false, reason: null };
  const gate: ModeGate = d ? await resolveModes(d.sb, { mode: req.mode, trigger }) : { fetching: open, analysis: open };
  // The turn reports the mode its first stage runs in; every row says its own.
  const families = plan.map((s) => (s === "ops" ? "ops" : familyOfStage(s)));
  const resolved = gate[familyOf(families[0] as string)?.fetches ? "fetching" : "analysis"];
  const inputs = Object.fromEntries(plan.map((s, i) => [families[i], { ...(req.input?.[s] ?? {}), ...(req.chain === false ? { chain_disabled: true } : {}) }]));
  const runs = await runChain(families, { mode: req.mode, trigger, rootRunId, resolved: gate }, h, inputs);
  const failure = runs.find((r) => r.exit !== 0);
  return { rootRunId, plan, resolved, runs, exit: failure ? failure.exit : 0, notes };
}
