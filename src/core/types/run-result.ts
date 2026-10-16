export type RunOutcome = "ok" | "partial" | "failed";

/** What every runtime entry returns: counts, an outcome and notes (plus an optional typed payload for its caller). The one shape; the harness writes the ledger row from it. */
export interface RunResult<T = unknown> {
  counts: Record<string, number>;
  outcome: RunOutcome;
  notes: string[];
  data?: T;
}

export const runResult = (outcome: RunOutcome, counts: Record<string, number> = {}, notes: string[] = []): RunResult => ({ counts, outcome, notes });

/** The worst of several outcomes: failed over partial over ok. */
export const worst = (...outcomes: RunOutcome[]): RunOutcome => (outcomes.includes("failed") ? "failed" : outcomes.includes("partial") ? "partial" : "ok");
