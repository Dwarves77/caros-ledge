// IMP-030: every stage runtime registers in this one list; the dispatcher (runFamily), the CLI and the connection check read it. A stage appears here once, with the family it records under.
import { FAMILIES, type FamilyFn } from "@/core/harness";

import { runBriefs } from "./stages/briefs";
import { runCapture } from "./stages/capture";
import { runChange } from "./stages/change";
import { runConnect } from "./stages/connect";
import { runIntake } from "./stages/intake";
import { runPropagate } from "./stages/propagate";
import { runResearch } from "./stages/sweep-research";
import { runSweep } from "./stages/sweep";
import type { BuiltDeps } from "./wiring";
import type { FamilyCall } from "@/core/harness";
import type { RunResult } from "@/core/types/run-result";

/** The ordered plan (runtimes-b section 8): each stage is the previous one's downstream. */
export const STAGES = ["sweep", "sweep-research", "change", "capture", "intake", "connect", "propagate", "briefs"] as const;
export type Stage = (typeof STAGES)[number];

export type StageRunner = (call: FamilyCall, d: BuiltDeps) => Promise<RunResult>;
export const STAGE_RUNNERS: Readonly<Record<Stage, StageRunner>> = { sweep: runSweep, "sweep-research": runResearch, change: runChange, capture: runCapture, intake: runIntake, connect: runConnect, propagate: runPropagate, briefs: runBriefs };

export const isStage = (s: string): s is Stage => (STAGES as readonly string[]).includes(s);
/** The family a stage records under (from FAMILIES, the one table). */
export const familyOfStage = (stage: Stage): string => {
  const f = FAMILIES.find((x) => x.stage === stage);
  if (!f) throw new Error(`stage ${stage} has no family in FAMILIES`);
  return f.name;
};

/** The registry the run frame dispatches through: family name to its bound function. */
export function familyFns(d: BuiltDeps): Record<string, FamilyFn> {
  return Object.fromEntries(STAGES.map((stage) => [familyOfStage(stage), (call: FamilyCall) => STAGE_RUNNERS[stage](call, d)]));
}
