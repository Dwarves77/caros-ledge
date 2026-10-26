// Ported from old_repo/scripts/lib/run-artifact.mjs (lines 241-281)
// Ported from old_repo/scripts/lib/emit-workflow-run-artifact.mjs (lines 15-26)
// The outcome, mode and trigger vocabularies, how a runtime's result becomes an outcome, and the no-op contract.
import type { RunResult } from "@/core/types/run-result";

/**
 * `partial` is a run that did its work and some of its units failed (migration 0070): it is neither success nor failure, and no proof counts it as the former.
 * `unknown` is a firing that started and has not concluded: the row a crashed process leaves behind (migration 0008 allows it; nothing treats it as work done).
 */
export type Outcome = "success" | "partial" | "noop" | "refused" | "failed" | "unknown";
export type Mode = "dry" | "apply";
export type Trigger = "dispatch" | "chained" | "push" | "schedule" | "manual";

/** The problems of a counts object: every count must be a non-negative finite number. A malformed count is refused (the row is unrecordable), never coerced to zero. */
const countProblems = (counts: Record<string, unknown>): string[] => Object.entries(counts).filter(([, v]) => typeof v !== "number" || !Number.isFinite(v) || v < 0).map(([k, v]) => `count ${k} is ${JSON.stringify(v)}: counts are non-negative finite numbers`);

/** The counts of a ledger row's outputs: `counts` of an apply row, `planned` of a dry row, `{}` for a row that carries neither (a skipped or legacy row). The one extraction (it was written three times with a silent default). */
export function countsOf(outputs: Record<string, unknown>): Record<string, number> {
  const counts = outputs.counts ?? outputs.planned ?? {};
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) throw new Error(`a ledger row's counts are ${JSON.stringify(counts)}, not an object of numbers`);
  return counts as Record<string, number>;
}

/** The sum of the counts a family declares as writes (counts are validated by noopContractErrors; an absent key adds nothing). */
const writeCount = (counts: Record<string, number> | undefined, writes: readonly string[]): number => writes.reduce((n, k) => n + (counts?.[k] ?? 0), 0);

/**
 * How a runtime's result becomes a ledger outcome. A failed result is `failed`; a result that refused (counts.refused above zero and nothing written, a held
 * producer or a closed gate) is `refused`; an apply run that wrote nothing is `noop` (the no-op contract: success needs apply evidence); a result with failed units is `partial`; everything else is `success`.
 * A dry run claims no write: its counts move under `planned` (INV-200).
 */
export function classify(result: RunResult, writes: readonly string[], mode: Mode): { outcome: Outcome; reason: string | null } {
  const note = result.notes[0] ?? null;
  const wrote = writeCount(result.counts, writes);
  if (result.outcome === "failed") return (result.counts.refused ?? 0) > 0 && wrote === 0 ? { outcome: "refused", reason: note } : { outcome: "failed", reason: note };
  // Units that failed are not "nothing to write": a run whose units all failed attempted its work and is `partial` (HEAL-1b: two items failed, nothing was written, and the row read noop).
  if (mode === "apply" && wrote === 0) return (result.counts.failed ?? 0) > 0 ? { outcome: "partial", reason: note ?? "units failed; nothing written" } : { outcome: "noop", reason: note ?? "applied with nothing to write" };
  return result.outcome === "partial" ? { outcome: "partial", reason: note ?? "some units failed" } : { outcome: "success", reason: null };
}

/** Errors that make a row unrecordable: a malformed count, a noop that claims a write, a success or partial in apply mode that claims none (a forged or unsound row), a dry row that claims counts as writes. */
export function noopContractErrors(row: { outcome: string; mode: string | null; outputs: Record<string, unknown> }, writes: readonly string[]): string[] {
  const counts = (row.outputs.counts ?? {}) as Record<string, number>;
  const errors = [...countProblems(counts), ...countProblems((row.outputs.planned ?? {}) as Record<string, unknown>)];
  const wrote = writeCount(errors.length ? {} : counts, writes);
  if (row.outcome === "noop" && wrote > 0) errors.push(`a noop row claims ${wrote} write(s): a run that wrote cannot record itself as one`);
  const failedUnits = counts.failed ?? 0;
  if ((row.outcome === "success" || (row.outcome === "partial" && !(failedUnits > 0))) && row.mode === "apply" && wrote === 0) errors.push(`a ${row.outcome} row in apply mode claims no write: no apply evidence`);
  if (row.mode === "dry" && row.outputs.counts !== undefined) errors.push("a dry row carries write counts: a dry run's counts belong under planned");
  return errors;
}

