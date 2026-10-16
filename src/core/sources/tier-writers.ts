// Ported from old_repo/src/lib/sources/tier-override-guard.mjs (lines 1-36)
// Ported from old_repo/src/lib/trust.ts (lines 1266-1606)
import type { Db } from "@/core/db";

import type { TierMovementDecision, TierMovementPlan } from "./tier-movement";
import type { SourceTier } from "./types";

// The override guard: every automatic tier writer states `tier_override IS NULL` inside the UPDATE itself (INV-073).
type Filterable<T> = { is(column: string, value: null): T };
export const notUnderTierOverride = <T extends Filterable<T>>(qb: T): T => qb.is("tier_override", null);

/**
 * Write sources.effective_tier with the override guard in the statement. `written` is false when it matched nothing, which for this
 * statement means the row is under an admin override at write time (or was removed). A database error is returned, never read as "not written".
 */
export async function writeEffectiveTierUnlessOverridden(db: Db, sourceId: string, tier: number): Promise<{ written: boolean; error: { message: string } | null }> {
  const { data, error } = await notUnderTierOverride(db.from("sources").update({ effective_tier: tier }).eq("id", sourceId)).select("id");
  if (error) return { written: false, error };
  return { written: Array.isArray(data) && data.length > 0, error: null };
}


/** The source_trust_events row recorded for one applied movement. */
export function tierMovementEvent(sourceId: string, d: TierMovementDecision) {
  return {
    source_id: sourceId,
    event_type: d.after_tier < d.before_tier ? ("tier_promotion" as const) : ("tier_demotion" as const),
    details: { applied: true, rule: d.rules.join("+"), rules: d.rules, before_tier: d.before_tier, after_tier: d.after_tier, base_tier: d.base_tier, deltas: d.deltas, outcome_driven: d.outcome_driven, inputs: d.inputs },
    created_by: "worker" as const,
  };
}
export interface TierMovementWriters {
  setEffectiveTier(sourceId: string, tier: SourceTier): Promise<void | { written: boolean }>;
  insertEvent(event: ReturnType<typeof tierMovementEvent>): Promise<void>;
}
/** The writers over the database: the tier write is the guarded UPDATE, and a database error throws (it is a failed write, not a skipped one). */
export function tierMovementWriters(db: Db): TierMovementWriters {
  return {
    setEffectiveTier: async (sourceId, tier) => {
      const r = await writeEffectiveTierUnlessOverridden(db, sourceId, tier);
      if (r.error) throw new Error(r.error.message);
      return { written: r.written };
    },
    insertEvent: async (event) => {
      const { error } = await db.from("source_trust_events").insert(event);
      if (error) throw new Error(error.message);
    },
  };
}
export interface TierMovementApplyResult {
  attempted: number;
  applied: number;
  promotions: number;
  demotions: number;
  write_failed: number;
  event_failed: number;
  /** Writes the database refused because an admin override was set after the plan was read: not applied, no event. */
  override_skipped: number;
  failures: string[];
}
/** Applies planned movements: a tier write, then its audit event. A failed write records no event; a failed event after a good write is counted and never rolled back. Fail-soft per source. */
export async function applyTierMovements(movements: TierMovementPlan["movements"], writers: TierMovementWriters): Promise<TierMovementApplyResult> {
  const result: TierMovementApplyResult = { attempted: movements.length, applied: 0, promotions: 0, demotions: 0, write_failed: 0, event_failed: 0, override_skipped: 0, failures: [] };
  for (const m of movements) {
    const label = m.name ?? m.source_id;
    try {
      const w = await writers.setEffectiveTier(m.source_id, m.decision.after_tier);
      if (w && w.written === false) {
        result.override_skipped += 1;
        continue;
      }
    } catch (e) {
      result.write_failed += 1;
      result.failures.push(`${label}: effective_tier write failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    result.applied += 1;
    if (m.decision.after_tier < m.decision.before_tier) result.promotions += 1;
    else result.demotions += 1;
    try {
      await writers.insertEvent(tierMovementEvent(m.source_id, m.decision));
    } catch (e) {
      result.event_failed += 1;
      result.failures.push(`${label}: source_trust_events insert failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

