// The reaper: a firing writes its row as `unknown` ("in progress") before it runs, and concludes the row when it ends. A process that dies in between leaves that row behind. Nothing else ever closes it, and a
// run left `unknown` forever reads as one still going (the brief-apply in-flight guard waits on it). This closes every such row older than the lease as `failed`, reason `crashed`, so the ledger says what happened.
import type { Db } from "@/core/db";

/** The reason a started run's row carries until it concludes. Legacy rows (outcome `unknown`, migration 0008) carry no such reason and are never touched. */
export const IN_PROGRESS = "in progress";
/** Longer than a job may run (30 minutes) and than the brief-apply in-flight guard waits (60), so a run still going is never reaped. */
const RUN_LEASE_MS = 2 * 60 * 60 * 1000;
const CRASHED = "crashed";

/** Close the started-and-never-concluded rows older than the lease. Returns how many were closed; a failed update throws (an unreapable ledger is not a quiet one). */
export async function reapStaleRuns(sb: Db, now: Date, leaseMs: number = RUN_LEASE_MS): Promise<number> {
  const cutoff = new Date(now.getTime() - leaseMs).toISOString();
  const { data, error } = await sb
    .from("harness_runs")
    .update({ outcome: "failed", reason: CRASHED, error: `${CRASHED}: the process that began this run never concluded it (no conclusion within ${Math.round(leaseMs / 60000)} minutes)`, finished_at: now.toISOString() })
    .eq("outcome", "unknown")
    .eq("reason", IN_PROGRESS)
    .lt("started_at", cutoff)
    .select("id");
  if (error) throw new Error(`harness_runs reaper failed: ${error.message}`);
  return (data ?? []).length;
}
