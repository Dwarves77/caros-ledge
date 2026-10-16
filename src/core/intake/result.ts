export type RunOutcome = "ok" | "partial" | "failed";

/** What every runtime entry returns (the recorder in P2-08 writes the ledger row from it); an entry never exits the process. */
export interface RunResult {
  counts: Record<string, number>;
  outcome: RunOutcome;
  notes: string[];
}

export const runResult = (outcome: RunOutcome, counts: Record<string, number> = {}, notes: string[] = []): RunResult => ({ counts, outcome, notes });

/** The worst of several outcomes: failed over partial over ok. */
export const worst = (...outcomes: RunOutcome[]): RunOutcome => (outcomes.includes("failed") ? "failed" : outcomes.includes("partial") ? "partial" : "ok");
