// Ported from old_repo/scripts/turns/io-preflight.mjs (lines 7-34)
// Ported from old_repo/scripts/turns/io-preflight.mjs (lines 78-133)
// Ported from old_repo/scripts/turns/io-preflight.mjs (lines 215-256)
// Ported from old_repo/scripts/turns/apply-record-briefs.mjs (lines 812-955)
// The brief-apply cooldown, in-flight guard and byte budget. The run record is the harness ledger (brief-apply rows): there is no parallel run table, no metrics endpoint and no sleep. A previous apply that wrote
// (or crashed unfinished) holds the next one off for the cooldown; the byte budget is metered in process from the pools the apply reads. All thresholds are data (opts), none a hidden constant.
import type { Db } from "@/core/db";

const DEFAULT_COOLDOWN_MIN = 30;
/** An unfinished apply row younger than this is presumed still running; an older one is ignored (no evidence it is alive, and refusing forever would wedge every dispatch). */
const IN_FLIGHT_STALE_MIN = 60;
const DEFAULT_IO_BUDGET_MB = 400;
const BYTES_PER_MB = 1024 * 1024;
/** The apply reads an item's pool in its generate and again in its ground step: a budget estimate, calibrated from the first metered runs. */
export const POOL_REREADS = 2;
export const BUDGET_STOP_REASON = "io_budget";

export interface LastRun { id: string; started_at: string; finished_at: string | null; outcome: string }

/** Why an apply must not start now, or null. Pure over the previous run, the clock and the thresholds. */
function decideCooldown(a: { now: Date; lastRun: LastRun | null; cooldownMinutes?: number }): string | null {
  const { now, lastRun } = a;
  if (!lastRun) return null;
  const cooldown = a.cooldownMinutes ?? DEFAULT_COOLDOWN_MIN;
  if (lastRun.outcome === "unknown") {
    const ago = (now.getTime() - Date.parse(lastRun.started_at)) / 60000;
    return ago < IN_FLIGHT_STALE_MIN ? `in-flight: the previous apply (${lastRun.id}) started ${ago.toFixed(1)} minute(s) ago and has not concluded; refusing until ${IN_FLIGHT_STALE_MIN} minute(s) have passed since it started` : null;
  }
  const since = (now.getTime() - Date.parse(lastRun.finished_at ?? lastRun.started_at)) / 60000;
  return since < cooldown ? `cooldown: the previous apply (${lastRun.id}) finished ${since.toFixed(1)} minute(s) ago, under the ${cooldown}-minute cooldown` : null;
}

/** The latest brief-apply row that applied (or began to) in apply mode, excluding this firing's own row. A read error throws: an unreadable ledger is never "no previous run". */
async function readLastApplyRun(sb: Db, exceptId?: string): Promise<LastRun | null> {
  let q = sb.from("harness_runs").select("id, started_at, finished_at, outcome").eq("family", "brief-apply").eq("mode", "apply").in("outcome", ["success", "partial", "failed", "unknown"]);
  if (exceptId) q = q.neq("id", exceptId);
  const { data, error } = await q.order("started_at", { ascending: false }).limit(1);
  if (error) throw new Error(`harness_runs read failed: ${error.message}`);
  return ((data ?? [])[0] as LastRun | undefined) ?? null;
}

/** The apply's one pre-flight: the cooldown and the in-flight guard from the ledger. */
export async function preflight(deps: { sb: Db; now(): Date }, o: { runId?: string; cooldownMinutes?: number }): Promise<string | null> {
  return decideCooldown({ now: deps.now(), lastRun: await readLastApplyRun(deps.sb, o.runId), ...(o.cooldownMinutes !== undefined ? { cooldownMinutes: o.cooldownMinutes } : {}) });
}

/** The byte budget in bytes: megabytes in, 0 meaning unlimited. */
export const budgetBytes = (mb: number | undefined): number => Math.max(0, Math.floor((mb ?? DEFAULT_IO_BUDGET_MB) * BYTES_PER_MB));
