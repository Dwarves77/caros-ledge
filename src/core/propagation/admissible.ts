// Ported from old_repo/src/lib/propagation/admissible-for.ts (lines 1-39)
// Ported from old_repo/src/lib/propagation/effective-confidence.mjs (lines 15-36)
// Ported from old_repo/src/lib/entities/decisions.mjs (lines 27-31)
// The ONE gate (spec 08 section 3.3): a figure is admissible for a use only when its lifecycle is not falsified or obsolete, it is not stale,
// it is not community in a calculation or filing, its observation status is not missing, its derivation is contractable for filing, and its
// decayed confidence clears the floor (analysis 0.50, calculation 0.75, filing 0.90; display has none). Six refusals, in this order.
import { isContractable } from "@/core/contracts/envelope";
import { isMissing } from "@/core/contracts/vocabularies";

import type { Use, Value, Verdict } from "./types";

export const FLOOR = Object.freeze({ analysis: 0.5, calculation: 0.75, filing: 0.9 });

/** base x 0.5^(age / half-life), rounded to three places; no decay when the half-life is null. Throws on a non-finite base or a bad date. */
export function effectiveConfidence(base: number, assertedAt: string | Date, halfLifeDays: number | null | undefined, now: string | Date): number {
  if (typeof base !== "number" || !Number.isFinite(base)) throw new TypeError(`effectiveConfidence: base must be a finite number (got ${JSON.stringify(base)})`);
  if (halfLifeDays === null || halfLifeDays === undefined) return base;
  if (typeof halfLifeDays !== "number" || !Number.isFinite(halfLifeDays) || halfLifeDays <= 0) throw new TypeError(`effectiveConfidence: halfLifeDays must be null or a positive finite number (got ${JSON.stringify(halfLifeDays)})`);
  const assertedMs = assertedAt instanceof Date ? assertedAt.getTime() : Date.parse(assertedAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(assertedMs)) throw new TypeError(`effectiveConfidence: assertedAt is not a parseable date (${JSON.stringify(assertedAt)})`);
  if (!Number.isFinite(nowMs)) throw new TypeError(`effectiveConfidence: now is not a parseable date (${JSON.stringify(now)})`);
  const ageDays = (nowMs - assertedMs) / 86_400_000;
  return Math.round(base * Math.pow(0.5, ageDays / halfLifeDays) * 1000) / 1000;
}

const refuse = (reason: string): Verdict => ({ ok: false, reason });

export function admissibleFor(v: Value, use: Use, now: Date): Verdict {
  if (v.lifecycle === "falsified" || v.lifecycle === "obsolete") return refuse("lifecycle");
  if (v.admissibility === "stale") return refuse("pending recompute");
  if (use === "filing" || use === "calculation") {
    if (v.originClass === "community" || v.originClass === "community-corroborated") return refuse("community is never admissible in a calculation, at any corroboration level");
    if (v.obsStatus && isMissing(v.obsStatus)) return refuse("missing is not zero");
  }
  if (use === "filing" && !isContractable(v.derivation)) return refuse("non-contractable derivation");
  const eff = effectiveConfidence(v.baseConfidence, v.assertedAt, v.halfLifeDays, now.toISOString());
  if (use !== "display" && eff < FLOOR[use]) return refuse(`decayed below floor (${eff})`);
  return { ok: true, effectiveConfidence: eff, mustLabel: v.originClass };
}
