import type { Db } from "@/core/db";

/** What every runtime entry returns to its caller (P2-08's recorder writes the ledger row from it). */
export interface RunResult<T = unknown> {
  counts: Record<string, number>;
  outcome: "ok" | "partial" | "failed";
  notes: string[];
  data?: T;
}
/** What every runtime entry receives: the service client and the clock. A runtime never reads the wall clock any other way. */
export interface RunDeps {
  db: Db;
  now: () => Date;
}
/** Roll a list of per-unit errors into an outcome: none is ok, some is partial, all is failed. */
export function outcomeOf(done: number, failed: number): RunResult["outcome"] {
  return failed === 0 ? "ok" : done > 0 ? "partial" : "failed";
}
