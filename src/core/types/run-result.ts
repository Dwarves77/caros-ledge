export type RunOutcome = "ok" | "partial" | "failed";

/** What every runtime entry returns: counts, an outcome and notes (plus an optional typed payload for its caller). The one shape; the harness writes the ledger row from it. */
export interface RunResult<T = unknown> {
  counts: Record<string, number>;
  outcome: RunOutcome;
  notes: string[];
  data?: T;
}

export const runResult = (outcome: RunOutcome, counts: Record<string, number> = {}, notes: string[] = []): RunResult => ({ counts, outcome, notes });

/** The notes of several parts as one list, the failed parts first, then the partial, then the ok (each in its own order). The ledger names a failed run by its first note, so a benign note of a part that was ok ("nothing new to insert") must never lead a failure. */
export const leadWithFailures = (parts: ReadonlyArray<RunResult | null | undefined>): string[] => {
  const rank = (p: RunResult) => (p.outcome === "failed" ? 0 : p.outcome === "partial" ? 1 : 2);
  const live = parts.filter((p): p is RunResult => !!p);
  return [0, 1, 2].flatMap((r) => live.filter((p) => rank(p) === r).flatMap((p) => p.notes));
};

/** The worst of several outcomes: failed over partial over ok. */
export const worst = (...outcomes: RunOutcome[]): RunOutcome => (outcomes.includes("failed") ? "failed" : outcomes.includes("partial") ? "partial" : "ok");
