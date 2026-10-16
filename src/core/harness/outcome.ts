// Ported from old_repo/scripts/lib/run-artifact.mjs (lines 241-281)
// Ported from old_repo/scripts/lib/emit-workflow-run-artifact.mjs (lines 15-26)
// The outcome, mode and trigger vocabularies, how a runtime's result becomes an outcome, and the no-op contract.
import type { RunResult } from "@/core/types/run-result";

/** `unknown` is a firing that started and has not concluded: the row a crashed process leaves behind (migration 0008 allows it; nothing treats it as work done). */
export const OUTCOMES = ["success", "noop", "refused", "failed", "unknown"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const MODES = ["dry", "apply"] as const;
export type Mode = (typeof MODES)[number];
export const TRIGGERS = ["dispatch", "chained", "push", "schedule", "manual"] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** The sum of the counts a family declares as writes. */
export const writeCount = (counts: Record<string, number> | undefined, writes: readonly string[]): number => writes.reduce((n, k) => n + (Number.isFinite(counts?.[k]) ? Math.max(0, counts?.[k] as number) : 0), 0);

/**
 * How a runtime's result becomes a ledger outcome. A failed result is `failed`; a result that refused (counts.refused above zero and nothing written, a held
 * producer or a closed gate) is `refused`; an apply run that wrote nothing is `noop` (the no-op contract: success needs apply evidence); everything else is `success`.
 * A dry run claims no write: its counts move under `planned` (INV-200).
 */
export function classify(result: RunResult, writes: readonly string[], mode: Mode): { outcome: Outcome; reason: string | null } {
  const note = result.notes[0] ?? null;
  const wrote = writeCount(result.counts, writes);
  if (result.outcome === "failed") return (result.counts.refused ?? 0) > 0 && wrote === 0 ? { outcome: "refused", reason: note } : { outcome: "failed", reason: note };
  if (mode === "apply" && wrote === 0) return { outcome: "noop", reason: note ?? "applied with nothing to write" };
  return { outcome: "success", reason: result.outcome === "partial" ? `partial: ${note ?? "some units failed"}` : null };
}

/** Errors that make a row unrecordable: a noop that claims a write, a success in apply mode that claims none (a forged or unsound row), a dry row that claims counts as writes. */
export function noopContractErrors(row: { outcome: string; mode: string | null; outputs: Record<string, unknown> }, writes: readonly string[]): string[] {
  const counts = (row.outputs.counts ?? {}) as Record<string, number>;
  const wrote = writeCount(counts, writes);
  const errors: string[] = [];
  if (row.outcome === "noop" && wrote > 0) errors.push(`a noop row claims ${wrote} write(s): a run that wrote cannot record itself as one`);
  if (row.outcome === "success" && row.mode === "apply" && wrote === 0) errors.push("a success row in apply mode claims no write: no apply evidence");
  if (row.mode === "dry" && row.outputs.counts !== undefined) errors.push("a dry row carries write counts: a dry run's counts belong under planned");
  return errors;
}

/** The one outcome of a workflow from its jobs' results: a failure outranks a cancellation outranks success; every job skipped means it did not run. */
export function outcomeOf(results: readonly string[]): "failure" | "cancelled" | "skipped" | "success" {
  const rs = results.map((r) => String(r).trim()).filter(Boolean);
  if (rs.includes("failure")) return "failure";
  if (rs.includes("cancelled")) return "cancelled";
  return rs.length === 0 || rs.every((r) => r === "skipped") ? "skipped" : "success";
}
