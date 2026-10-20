// Ported from old_repo/src/lib/sources/host-authority.ts (lines 549-565)
// Ported from old_repo/src/lib/tier-labels.ts (lines 1-15)
// Ported from old_repo/src/lib/customer-source-tier.ts (lines 1-44)
// Ported from old_repo/src/lib/trust.ts (lines 215-223)
import { z } from "zod";

import raw from "./data/tier-contract.json";

/** The one tier contract (the credibility skill's table, as data). Every label, legend, class tier and citation weight reads it. */
const schema = z.object({
  tiers: z.array(z.object({ tier: z.number().int().min(1).max(7), label: z.string().min(1), meaning: z.string().min(1), examples: z.array(z.string()) })).length(7),
  classTier: z.record(z.string(), z.number().int().min(1).max(7)),
  citationWeights: z.record(z.string(), z.number().min(0).max(1)),
});
export const tierContract = schema.parse(raw);

export const TIER_LABELS: Readonly<Record<number, string>> = Object.freeze(Object.fromEntries(tierContract.tiers.map((t) => [t.tier, t.label])));
export const HOST_CLASS_TIER: Readonly<Record<string, number>> = Object.freeze({ ...tierContract.classTier });
export const TIER_WEIGHTS: Readonly<Record<number, number>> = Object.freeze(Object.fromEntries(Object.entries(tierContract.citationWeights).map(([k, v]) => [Number(k), v])));

const SOURCE_TIER_MIN = Math.min(...tierContract.tiers.map((t) => t.tier));
export const SOURCE_TIER_MAX = Math.max(...tierContract.tiers.map((t) => t.tier));

/** True when `cls` is a class the table carries (own-property check, so "toString" is never a class). */
export function isKnownHostClass(cls: unknown): cls is string {
  return typeof cls === "string" && Object.prototype.hasOwnProperty.call(HOST_CLASS_TIER, cls);
}

/** Label lookup that never leaks a status word for an unknown or null tier. */
export function tierLabelOf(tier: number | null | undefined): string {
  if (tier == null) return "Unrated";
  return TIER_LABELS[tier] ?? `Tier ${tier}`;
}

interface SourceTierColumns {
  tier_override?: number | null;
  effective_tier?: number | null;
  base_tier?: number | null;
}
const inVocabulary = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= SOURCE_TIER_MIN && n <= SOURCE_TIER_MAX;

/** The tier a customer sees: override, then the dynamic effective tier, then the static base tier; null when none is valid. */
export function customerTierOf(src: SourceTierColumns | null | undefined): number | null {
  if (!src) return null;
  if (inVocabulary(src.tier_override)) return src.tier_override;
  if (inVocabulary(src.effective_tier)) return src.effective_tier;
  if (inVocabulary(src.base_tier)) return src.base_tier;
  return null;
}

/** The scale in one line for a legend, built from the contract: "T1 binding law -> T7 overflow / uncategorized". */
export function tierScaleSpan(joiner: string): string {
  const first = `T${SOURCE_TIER_MIN} ${(TIER_LABELS[SOURCE_TIER_MIN] ?? "").toLowerCase()}`;
  const last = `T${SOURCE_TIER_MAX} ${(TIER_LABELS[SOURCE_TIER_MAX] ?? "").toLowerCase()}`;
  return `${first} ${joiner} ${last}`;
}
