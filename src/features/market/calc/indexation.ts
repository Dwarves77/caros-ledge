// Ported from old_repo/src/lib/spec09/indexation.mjs (lines 1-44)
// Clause mechanics and arithmetic only, never drafted clause text (spec 09 section 5 decision 2: drafted text reads as legal advice however it is captioned).
import { labelled, missing } from "@/core/values/label";

export interface IndexedInput {
  baseValue: number;
  indexBaseline: number;
  indexCurrent: number;
  passthroughPct: number;
  capPct?: number | null;
  floorPct?: number | null;
}
/**
 * The indexed value at a review point: base_value scaled by the index's movement since base_date, passed through at passthrough_pct, then clamped to
 * [floor_pct, cap_pct] of base_value. A commercial term, so `calculated`, never statutory. Anything unusable is M with its reason.
 */
function computeIndexedValue({ baseValue, indexBaseline, indexCurrent, passthroughPct, capPct = null, floorPct = null }: IndexedInput) {
  for (const [name, v] of Object.entries({ baseValue, indexBaseline, indexCurrent, passthroughPct })) if (typeof v !== "number" || !Number.isFinite(v)) return missing(`${name} must be a finite number to compute an indexed value.`);
  if (indexBaseline === 0) return missing("indexBaseline must be non-zero (division by zero).");
  if (passthroughPct < 0 || passthroughPct > 100) return missing("passthroughPct must be between 0 and 100.");
  const indexMovementPct = (indexCurrent - indexBaseline) / indexBaseline;
  const raw = 1 + indexMovementPct * (passthroughPct / 100);
  const lo = floorPct == null ? -Infinity : 1 + floorPct / 100;
  const hi = capPct == null ? Infinity : 1 + capPct / 100;
  if (lo > hi) return missing("floorPct exceeds capPct: an inverted band cannot be applied.");
  const clamped = Math.min(Math.max(raw, lo), hi);
  const wasClamped = clamped !== raw;
  return labelled(Math.round(baseValue * clamped * 100) / 100, "calculated", { indexMovementPct, rawValue: Math.round(baseValue * raw * 100) / 100, wasClamped, clampedBy: wasClamped ? (clamped === lo ? "floor" : "cap") : null });
}
