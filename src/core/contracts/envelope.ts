// Ported from old_repo/src/lib/contracts/envelope.mjs (lines 1-330)
import { DERIVATION, ORIGIN_CLASS, OBS_STATUS, REFRESH_PERIOD_DAYS, isMissing } from "./vocabularies";

export { DERIVATION };

/** Derivation classes are DATA (data/vocabularies.json). `contractable` marks classes a customer may put in a contract or filing. */
export const DERIVATIONS: readonly string[] = Object.keys(DERIVATION);
export const isContractable = (derivation: string): boolean => DERIVATION[derivation]?.contractable === true;
/** Only a statutory class may be presented as what the law requires, and only it may carry a penalty figure. */
export const isStatutory = (derivation: string): boolean => DERIVATION[derivation]?.statutory === true;

export interface AsOf {
  event_date: string;
  source_published_at?: string | null;
  ingested_at?: string | null;
}
export interface Envelope {
  value: number | null;
  low: number | null;
  high: number | null;
  unit: string | null;
  currency: string | null;
  fx_date: string | null;
  basis: string | null;
  derivation: string | null;
  obs_status: string;
  origin_class: string | null;
  as_of: AsOf | null;
  expected_refresh: string | null;
  n: number | null;
  contributor_count: number | null;
  method: string | null;
  method_version: string | null;
  judgment_note: string | null;
  provenance: unknown;
}
export type EnvelopeInput = Partial<Record<keyof Envelope, unknown>>;

const REQUIRED = ["derivation", "unit", "as_of"] as const;
const isIsoDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}(T|$)/.test(s) && !Number.isNaN(Date.parse(s));
const stated = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
const count = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;

/** Errors for an envelope; empty means valid. Strict on the three fields without which a number is uninterpretable, permissive on optional richness. */
function validateEnvelope(env: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const f of REQUIRED) if (!stated(env[f])) errors.push(`missing required field: ${f}`);
  if (stated(env.derivation) && !DERIVATION[String(env.derivation)]) errors.push(`unknown derivation: ${String(env.derivation)}`);
  if (stated(env.obs_status) && !OBS_STATUS[String(env.obs_status)]) errors.push(`unknown obs_status: ${String(env.obs_status)}`);
  if (stated(env.origin_class) && !ORIGIN_CLASS[String(env.origin_class)]) errors.push(`unknown origin_class: ${String(env.origin_class)}`);

  // The as-of triple: when it happened, when the source published it, when we read it. A bare "last updated" conflates all three.
  const asOf = env.as_of as Record<string, unknown> | null | undefined;
  if (asOf !== undefined && asOf !== null) {
    if (typeof asOf !== "object" || Array.isArray(asOf)) errors.push("as_of must be an object with event_date / source_published_at / ingested_at");
    else {
      if (!isIsoDate(asOf.event_date)) errors.push("as_of.event_date must be an ISO date");
      for (const k of ["source_published_at", "ingested_at"]) if (stated(asOf[k]) && !isIsoDate(asOf[k])) errors.push(`as_of.${k} must be an ISO date when present`);
    }
  }
  if (stated(env.n) && !count(env.n)) errors.push("n must be a non-negative integer when present");
  if (stated(env.contributor_count) && !count(env.contributor_count)) errors.push("contributor_count must be a non-negative integer when present");

  const hasLo = env.low !== undefined && env.low !== null;
  const hasHi = env.high !== undefined && env.high !== null;
  if (hasLo !== hasHi) errors.push("low and high must be provided together");
  if (hasLo && hasHi) {
    if (typeof env.low !== "number" || typeof env.high !== "number") errors.push("low and high must be numbers");
    else if (env.low > env.high) errors.push("low must be <= high");
    else if (typeof env.value === "number" && (env.value < env.low || env.value > env.high)) errors.push("value must lie within [low, high]");
  }
  // INV-173: a missing observation never carries a value (the zero-fill guard).
  if (env.obs_status !== undefined && isMissing(env.obs_status) && env.value !== undefined && env.value !== null) {
    errors.push(`obs_status ${String(env.obs_status)} denotes a missing observation but a value is present (zero-fill guard)`);
  }
  return errors;
}

/** A validated, frozen envelope. THROWS on invalid input: a malformed number is unconstructable. `value` is null when obs_status denotes absence. */
export function makeEnvelope(input: EnvelopeInput): Readonly<Envelope> {
  const pick = <T>(k: keyof Envelope, fallback: T | null = null): T | null => (input?.[k] as T | undefined) ?? fallback;
  const env = {
    value: pick<number>("value"),
    low: pick<number>("low"),
    high: pick<number>("high"),
    unit: pick<string>("unit"),
    currency: pick<string>("currency"),
    fx_date: pick<string>("fx_date"),
    basis: pick<string>("basis"),
    derivation: pick<string>("derivation"),
    obs_status: pick<string>("obs_status", "A") as string,
    origin_class: pick<string>("origin_class"),
    as_of: pick<AsOf>("as_of"),
    expected_refresh: pick<string>("expected_refresh"),
    n: pick<number>("n"),
    contributor_count: pick<number>("contributor_count"),
    method: pick<string>("method"),
    method_version: pick<string>("method_version"),
    judgment_note: pick<string>("judgment_note"),
    provenance: pick<unknown>("provenance"),
  } satisfies Envelope;
  const errors = validateEnvelope(env);
  if (errors.length) throw new TypeError(`invalid number envelope: ${errors.join("; ")}`);
  return Object.freeze(env);
}

/**
 * Freshness is derived, never asserted: current within one nominal period, ageing within two, stale within four,
 * frozen beyond (the source stopped publishing, categorically not "late"); unknown when no cadence is declared.
 * Measured from source_published_at, falling back to event_date.
 */
export function stalenessOf(env: { expected_refresh?: string | null; as_of?: Partial<AsOf> | null } | null | undefined, nowIso: string): string {
  const cadence = env?.expected_refresh;
  const period = cadence ? REFRESH_PERIOD_DAYS[cadence] : undefined;
  if (period === undefined || period === null) return "unknown";
  const ref = env?.as_of?.source_published_at || env?.as_of?.event_date;
  if (!isIsoDate(ref) || !isIsoDate(nowIso)) return "unknown";
  const days = (Date.parse(nowIso) - Date.parse(ref)) / 86_400_000;
  if (days <= period) return "current";
  if (days <= period * 2) return "ageing";
  return days <= period * 4 ? "stale" : "frozen";
}

/** Significant figures a sample of size `n` honestly supports: none or 0 gives 1, under 5 gives 2, under 30 gives 3, else 4. */
const significantFigures = (n: unknown): number => (!Number.isInteger(n) || (n as number) <= 0 ? 1 : (n as number) < 5 ? 2 : (n as number) < 30 ? 3 : 4);

export function roundToSampleSupport(value: number | null, n: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0) return value;
  return Number(value.toPrecision(significantFigures(n)));
}

/** A change with the correct unit: ratios move in percentage points, quantities in percent. `kind` is required, never defaulted. */
export function formatDelta(delta: unknown, kind: "ratio" | "quantity", digits = 1): string | null {
  if (typeof delta !== "number" || !Number.isFinite(delta)) return null;
  if (kind !== "ratio" && kind !== "quantity") throw new TypeError("formatDelta: kind must be ratio (renders pp) or quantity (renders %)");
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  return `${sign}${Math.abs(delta).toFixed(digits)}${kind === "ratio" ? " pp" : "%"}`;
}

export interface Propagated {
  origin_class: string | null;
  derivation: string | null;
  freshness: string;
  count: number;
  /** Set when an input carried an unknown class and the aggregate fell to the weakest value (never silent). */
  notes: string[];
}

