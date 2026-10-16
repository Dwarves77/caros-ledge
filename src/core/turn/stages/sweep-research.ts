// Ported from old_repo/scripts/research/research-sweep.mjs (lines 66-344)
// Stage 2, sweep-research: the research walker. It searches OpenAlex for the topic and the open needs, rates each publisher by the class table, and mints only through the chokepoint;
// the producer gates (the reviewed ENABLED constant, the kill switch, the licence) decide whether an apply may write, and a refusal is recorded as one.
import type { FamilyCall } from "@/core/harness";
import type { RunResult } from "@/core/types/run-result";
import { walkResearch } from "@/features/research";
import type { WalkInput } from "@/features/research/walker";

import type { BuiltDeps } from "../wiring";

/** The walk input from the stage input: a topic query, the open needs and the grey-literature sources. Pure. */
export function planResearch(input: Record<string, unknown>): WalkInput {
  const w = (input.walk ?? {}) as Record<string, unknown>;
  return { ...(typeof w.query === "string" ? { query: w.query } : {}), ...(Array.isArray(w.needs) ? { needs: w.needs as NonNullable<WalkInput["needs"]> } : {}), ...(Array.isArray(w.greyLit) ? { greyLit: w.greyLit as NonNullable<WalkInput["greyLit"]> } : {}) };
}

/** The walker's counts and notes become the stage result; a stage that minted nothing still names its counts so the ledger row is whole. Pure. */
export function shapeResearch(r: RunResult): RunResult {
  return { ...r, counts: { minted: 0, upserted: 0, ...r.counts }, data: { ids: {} } };
}

export async function runResearch(call: FamilyCall, d: BuiltDeps): Promise<RunResult> {
  if (!call.dry && !(await d.gate.refresh())) return { counts: { refused: 1 }, outcome: "failed", notes: ["fetch gate closed (the scrape cadence is off, or the emergency stop is set): the walk is refused"] };
  return shapeResearch(await walkResearch(d.producers, { dry: call.dry, walk: planResearch(call.input) }));
}
