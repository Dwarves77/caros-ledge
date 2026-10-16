// Ported from old_repo/src/lib/spec09/grid-queue.mjs (lines 1-36)
// The grid connection queue is a GATE, not a cost line: p90 (the worse case) against the caller's own horizon; absent p90 is UNKNOWN, never CLEAR.
import { labelled, missing } from "@/core/values/label";

/** BLOCKED when the p90 queue exceeds the horizon, CLEAR when it does not, UNKNOWN when there is no p90. The horizon is the caller's, never invented here. */
export function gridQueueGate({ queueMonthsP90, horizonMonths }: { queueMonthsP90: number | null | undefined; horizonMonths: number }) {
  if (typeof horizonMonths !== "number" || !Number.isFinite(horizonMonths) || horizonMonths < 0) return missing("horizonMonths (the caller's own decision horizon) must be a non-negative finite number.");
  if (queueMonthsP90 === null || queueMonthsP90 === undefined) return labelled("UNKNOWN", "calculated", { status: "UNKNOWN" as const, reason: "no queue_months_p90 on file for this DSO/capacity band: never treated as CLEAR (a gate, not a cost line)." });
  if (typeof queueMonthsP90 !== "number" || !Number.isFinite(queueMonthsP90) || queueMonthsP90 < 0) return missing("queueMonthsP90 must be a non-negative finite number when present.");
  const status = queueMonthsP90 > horizonMonths ? ("BLOCKED" as const) : ("CLEAR" as const);
  return labelled<string, { status: "BLOCKED" | "CLEAR"; queueMonthsP90: number; horizonMonths: number; note: string }>(status, "calculated", {
    status, queueMonthsP90, horizonMonths,
    note: status === "BLOCKED" ? `the p90 connection queue (${queueMonthsP90} mo) exceeds the ${horizonMonths}-month decision horizon: BLOCKED regardless of EUR/kWh.` : `the p90 connection queue (${queueMonthsP90} mo) clears the ${horizonMonths}-month decision horizon.`,
  });
}
