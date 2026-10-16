import type { Db } from "@/core/db";
import type { RunResult } from "@/core/types/run-result";

export type { RunResult };
/** What every runtime entry receives: the service client and the clock. A runtime never reads the wall clock any other way. */
export interface RunDeps {
  db: Db;
  now: () => Date;
}
/** Roll a list of per-unit errors into an outcome: none is ok, some is partial, all is failed. */
export function outcomeOf(done: number, failed: number): RunResult["outcome"] {
  return failed === 0 ? "ok" : done > 0 ? "partial" : "failed";
}
