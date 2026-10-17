// Ported from old_repo/src/lib/operations/labour-chain.ts (lines 1-236)
// The fully-loaded labour chain (spec 04 section 5, INV-231): five numerator terms summed in order, divided by a positive productive-hours divisor. The unit error of the old tree is fixed here: a numerator
// term is accepted only in a PER-HOUR unit (the annual USD/year wage was found first and the chain printed "USD/year per productive hour") and every term must be in ONE currency; otherwise the figure is
// suppressed, every missing term is named, and each gap carries its own cause. Nothing is defaulted or imputed.
export type ChainTermKey = "baseWage" | "employerContributions" | "leaveAbsence" | "turnoverRecruitment" | "shiftPremium" | "productiveHours";
export const NUMERATOR_TERM_ORDER: readonly ChainTermKey[] = ["baseWage", "employerContributions", "leaveAbsence", "turnoverRecruitment", "shiftPremium"];
export const CHAIN_TERM_ORDER: readonly ChainTermKey[] = [...NUMERATOR_TERM_ORDER, "productiveHours"];
const LABELS: Readonly<Record<ChainTermKey, string>> = { baseWage: "Base wage", employerContributions: "Employer social contributions", leaveAbsence: "Leave and absence", turnoverRecruitment: "Turnover and recruitment", shiftPremium: "Shift premium", productiveHours: "Productive hours" };
/** One matcher per term; deliberately broad so a new producer's label for a term is found without a code change. */
const MATCHERS: Readonly<Record<ChainTermKey, RegExp>> = {
  baseWage: /\b(wage|salary|earnings)\b/i,
  employerContributions: /\b(employer|non-?wage|social contribution|social security)\b/i,
  leaveAbsence: /\b(leave|absence|sick|holiday)\b/i,
  turnoverRecruitment: /\b(turnover|recruitment|hiring)\b/i,
  shiftPremium: /\bshift premium\b/i,
  productiveHours: /\bproductive hours?\b/i,
};
const PER_HOUR = /\/\s*(hour|hr)$/i;

export interface ChainTermValue {
  valueNumeric: number;
  unit: string | null;
  currency: string | null;
  sourceKey: string | null;
  sourceRef: string | null;
  originClass: string | null;
  derivation: string | null;
  referencePeriod: string | null;
  asAtDate: string | null;
  factLabel: string | null;
}
export interface LabourFactLike {
  factLabel?: string | null;
  valueNumeric?: number | null;
  unit?: string | null;
  currency?: string | null;
  sourceKey?: string | null;
  sourceRef?: string | null;
  originClass?: string | null;
  derivation?: string | null;
  referencePeriod?: string | null;
  asAtDate?: string | null;
}
export type LabourChainInput = Partial<Record<ChainTermKey, ChainTermValue>>;
export interface ChainTermResult {
  key: ChainTermKey;
  label: string;
  present: boolean;
  value: ChainTermValue | null;
  /** Cumulative sum of the numerator terms through this one; null the moment this or an earlier term is missing, and for the divisor. */
  runningSubtotal: number | null;
  /** Why the term is absent: no figure held, only an annual figure, a different currency. Null when present. */
  cause: string | null;
}
export interface LabourChainResult {
  terms: ChainTermResult[];
  missingTerms: ChainTermKey[];
  numeratorTotal: number | null;
  currency: string | null;
  /** The currencies the numerator terms are denominated in when they are not one; null when they agree. */
  currencyMismatch: string[] | null;
  suppressed: boolean;
  finalValue: number | null;
  finalUnit: string | null;
  gapReason: string | null;
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
/** The bare currency of a term: its own currency column, else the unit's leading code ("EUR/hour" is EUR). */
export const currencyOf = (v: { unit: string | null; currency: string | null }): string | null => v.currency || (v.unit ? v.unit.replace(PER_HOUR, "").trim() || null : null);

/**
 * The five terms and the divisor from a cell's facts. A numerator term takes the first fact whose label matches AND whose unit is per hour; a match in another unit (an annual figure) is not a term, and the
 * cause says what was held instead. Returns the input and the cause per term that could not be filled.
 */
export function extractLabourChainTerms(facts: readonly LabourFactLike[]): { input: LabourChainInput; causes: Partial<Record<ChainTermKey, string>> } {
  const input: LabourChainInput = {};
  const causes: Partial<Record<ChainTermKey, string>> = {};
  for (const key of CHAIN_TERM_ORDER) {
    const matches = facts.filter((f) => typeof f.factLabel === "string" && MATCHERS[key].test(f.factLabel) && finite(f.valueNumeric ?? null));
    const usable = key === "productiveHours" ? matches[0] : matches.find((f) => PER_HOUR.test(f.unit ?? ""));
    if (usable) {
      input[key] = { valueNumeric: usable.valueNumeric as number, unit: usable.unit ?? null, currency: usable.currency ?? null, sourceKey: usable.sourceKey ?? null, sourceRef: usable.sourceRef ?? null, originClass: usable.originClass ?? null, derivation: usable.derivation ?? null, referencePeriod: usable.referencePeriod ?? null, asAtDate: usable.asAtDate ?? null, factLabel: usable.factLabel ?? null };
    } else if (matches[0]) causes[key] = `held only as ${matches[0].unit ?? "a figure with no unit"}, not per hour`;
    else causes[key] = "no figure held for this term";
  }
  return { input, causes };
}

export function computeLabourChain(input: LabourChainInput, causes: Partial<Record<ChainTermKey, string>> = {}): LabourChainResult {
  const terms: ChainTermResult[] = [];
  const missingTerms: ChainTermKey[] = [];
  let total = 0;
  let broken = false;
  for (const key of NUMERATOR_TERM_ORDER) {
    const value = input[key] ?? null;
    const present = value !== null && finite(value.valueNumeric) && PER_HOUR.test(value.unit ?? "");
    if (present) total += (value as ChainTermValue).valueNumeric;
    else {
      missingTerms.push(key);
      broken = true;
    }
    terms.push({ key, label: LABELS[key], present, value: present ? value : null, runningSubtotal: broken ? null : total, cause: present ? null : (causes[key] ?? "no figure held for this term") });
  }
  const hours = input.productiveHours ?? null;
  const hoursUsable = hours !== null && finite(hours.valueNumeric) && hours.valueNumeric > 0;
  if (!hoursUsable) missingTerms.push("productiveHours");
  terms.push({ key: "productiveHours", label: LABELS.productiveHours, present: hoursUsable, value: hoursUsable ? hours : null, runningSubtotal: null, cause: hoursUsable ? null : (causes.productiveHours ?? "no usable divisor held") });
  const currencies = [...new Set(terms.filter((t) => t.present && t.key !== "productiveHours").map((t) => currencyOf(t.value as ChainTermValue) ?? "unknown"))];
  const currencyMismatch = currencies.length > 1 ? currencies : null;
  const suppressed = broken || !hoursUsable || currencyMismatch !== null;
  const currency = currencyMismatch || currencies[0] === "unknown" ? null : (currencies[0] ?? null);
  const finalValue = suppressed ? null : total / (hours as ChainTermValue).valueNumeric;
  const named = missingTerms.map((k) => LABELS[k]).join(", ");
  const gapReason = !suppressed ? null : currencyMismatch ? `terms are in different currencies (${currencyMismatch.join(", ")})${named ? `; missing: ${named}` : ""}` : `missing: ${named}`;
  return { terms, missingTerms, numeratorTotal: broken ? null : total, currency, currencyMismatch, suppressed, finalValue, finalUnit: suppressed || !currency ? null : `${currency} per productive hour`, gapReason };
}
