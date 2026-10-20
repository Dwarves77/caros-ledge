// Ported from old_repo/src/lib/market/signal-promotion.mjs (lines 1-78)
// The four promotion states (INV-256). A signal is a Fact only when its origin class is fact-citable; two or more independent citers promote it to corroborated at most; with neither it is unclassified. An unrecognised
// origin class is the weakest signal state.
import { citableAsFact } from "@/core/contracts";

const PROMOTION_STATE = {
  unclassified: { code: "unclassified", label: "Not yet classified", chip: "Not yet classified", order: 1 },
  signal_unconfirmed: { code: "signal_unconfirmed", label: "Signal · unconfirmed", chip: "Unverified · early report", order: 2 },
  signal_corroborated: { code: "signal_corroborated", label: "Signal · corroborated", chip: "Unverified · corroborated", order: 3 },
  fact: { code: "fact", label: "Fact", chip: "Verified", order: 4 },
} as const;
export type PromotionCode = keyof typeof PROMOTION_STATE;
export interface Promotion {
  code: PromotionCode;
  label: string;
  chip: string;
  order: number;
  basis: "origin_class" | "origin_class+corroboration" | "corroboration" | "none";
  originClass: string | null;
  independentCiters: number | null;
}

const MIN_CORROBORATED_CITERS = 2;

export function derivePromotionState({ originClass = null, independentCiters = null }: { originClass?: string | null; independentCiters?: number | null } = {}): Promotion {
  const citers = typeof independentCiters === "number" && independentCiters > 0 ? independentCiters : null;
  const corroborated = citers !== null && citers >= MIN_CORROBORATED_CITERS;
  if (originClass) {
    if (citableAsFact(originClass)) return { ...PROMOTION_STATE.fact, basis: "origin_class", originClass, independentCiters: citers };
    return corroborated ? { ...PROMOTION_STATE.signal_corroborated, basis: "origin_class+corroboration", originClass, independentCiters: citers } : { ...PROMOTION_STATE.signal_unconfirmed, basis: "origin_class", originClass, independentCiters: citers };
  }
  // No origin class: corroboration alone, and never Fact (that needs primary-source evidence this branch does not have).
  if (corroborated) return { ...PROMOTION_STATE.signal_corroborated, basis: "corroboration", originClass: null, independentCiters: citers };
  if (citers !== null) return { ...PROMOTION_STATE.signal_unconfirmed, basis: "corroboration", originClass: null, independentCiters: citers };
  return { ...PROMOTION_STATE.unclassified, basis: "none", originClass: null, independentCiters: null };
}
