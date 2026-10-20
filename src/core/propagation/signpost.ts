// Ported from old_repo/src/lib/propagation/methods/signpost-watch.ts (lines 1-124)
// Ported from old_repo/src/lib/propagation/methods/signpost-watch.ts (lines 161-266)
// Signposts: evaluate a machine-observable predicate against the watched entity's row, decide the lifecycle transition a firing causes, and fire
// the signpost as ONE database call (public.fire_signpost, migration 0013): the stamp, the propagation event and the assessment lifecycle move happen
// in a single transaction, so a fired signpost whose assessment never moved can no longer exist (flywheel-b gap 7). Firing is idempotent on the stamp.
import type { Db } from "@/core/db";

import type { Lifecycle } from "./types";

export type SignpostPredicate = (
  | { op: "date_passed"; field: string }
  | { op: "threshold"; metric: string; gte: number }
  | { op: "count_gte"; relation: string; n: number }
) & { by?: string };

/** Whether the watched row satisfies the predicate. A row that cannot be resolved, or a field of the wrong type, is not fired, with the reason. */
export function evaluateSignpostPredicate(predicate: SignpostPredicate, watchedRow: Record<string, unknown> | null, now: Date): { fired: boolean; reason: string } {
  if (!watchedRow) return { fired: false, reason: "watched entity's attribute row could not be resolved" };
  switch (predicate.op) {
    case "date_passed": {
      const raw = watchedRow[predicate.field];
      if (typeof raw !== "string" && !(raw instanceof Date)) return { fired: false, reason: `field "${predicate.field}" is not a date on the watched row` };
      const d = raw instanceof Date ? raw : new Date(raw);
      if (Number.isNaN(d.getTime())) return { fired: false, reason: `field "${predicate.field}" did not parse as a date` };
      return d.getTime() <= now.getTime() ? { fired: true, reason: `${predicate.field} (${d.toISOString()}) has passed` } : { fired: false, reason: `${predicate.field} (${d.toISOString()}) has not passed yet` };
    }
    case "threshold": {
      const raw = watchedRow[predicate.metric];
      if (typeof raw !== "number" || !Number.isFinite(raw)) return { fired: false, reason: `metric "${predicate.metric}" is not a finite number on the watched row` };
      return raw >= predicate.gte ? { fired: true, reason: `${predicate.metric}=${raw} >= ${predicate.gte}` } : { fired: false, reason: `${predicate.metric}=${raw} < ${predicate.gte}` };
    }
    case "count_gte": {
      const key = `${predicate.relation}_count`;
      const raw = watchedRow[key];
      if (typeof raw !== "number" || !Number.isFinite(raw)) return { fired: false, reason: `"${key}" is not a finite number on the watched row` };
      return raw >= predicate.n ? { fired: true, reason: `${key}=${raw} >= ${predicate.n}` } : { fired: false, reason: `${key}=${raw} < ${predicate.n}` };
    }
    default:
      return { fired: false, reason: `unrecognised predicate op "${(predicate as { op: string }).op}"` };
  }
}

export type Direction = "confirms" | "refutes" | "delays";

export interface FireResult {
  fired: true;
  firstFiring: boolean;
  signpostEntityId: string;
  previousLifecycleState: Lifecycle;
  newLifecycleState: Lifecycle;
}

/** Fire one signpost in one transaction. Throws on any database error (nothing was written). */
export async function fireSignpost(sb: Db, args: { signpostEntityId: string; now: Date; reason?: string | null }): Promise<FireResult> {
  const { data, error } = await sb.rpc("fire_signpost", { p_entity_id: args.signpostEntityId, p_at: args.now.toISOString(), p_reason: args.reason ?? null });
  if (error) throw new Error(`fireSignpost: fire_signpost failed for ${args.signpostEntityId}: ${error.message}`);
  const r = data as { fired?: boolean; first_firing?: boolean; signpost_entity_id?: string; previous_lifecycle_state?: Lifecycle; new_lifecycle_state?: Lifecycle } | null;
  if (!r?.fired || !r.previous_lifecycle_state || !r.new_lifecycle_state) throw new Error(`fireSignpost: fire_signpost returned no result for ${args.signpostEntityId}`);
  return { fired: true, firstFiring: r.first_firing === true, signpostEntityId: r.signpost_entity_id ?? args.signpostEntityId, previousLifecycleState: r.previous_lifecycle_state, newLifecycleState: r.new_lifecycle_state };
}
