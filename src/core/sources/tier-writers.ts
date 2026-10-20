// Ported from old_repo/src/lib/sources/tier-override-guard.mjs (lines 1-36)
// Ported from old_repo/src/lib/trust.ts (lines 1266-1606)
import type { Db } from "@/core/db";

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


