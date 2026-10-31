// Ported from old_repo/src/lib/propagation/types.ts (lines 1-106)
// The shared vocabulary of decision propagation and the typed home of the derivation inputs jsonb shape.
export type Contractable = "statutory_fixed" | "statutory_formula" | "observed" | "transacted_index" | "assessed" | "calculated";
export type NonContractable = "interpolated" | "modelled" | "estimated";
export type Derivation = Contractable | NonContractable;
export type OriginClass = "community" | "community-corroborated" | "modelled" | "derived" | "partner" | "verified" | "official";
export type Lifecycle = "forming" | "emerging" | "strengthening" | "corroborated" | "verified" | "stalled" | "falsified" | "superseded" | "obsolete";
export type Admissibility = "display_only" | "analysis_ok" | "calculation_ok" | "filing_ok" | "stale";
export type Use = "display" | "analysis" | "calculation" | "filing";

/** One declared input of a derived value: the table and primary key it was computed from. */
export interface InputRef {
  table: string;
  pk: string;
  version?: string | null;
  /** The edge kind the input is registered under (default 'input'; a pattern's evidence is 'member', 'evidence' or 'key'). */
  kind?: string;
  /** What a pattern's recompute needs of an evidence row besides its columns: the entities it is filed under and the relation a cross-modal pattern crossed. */
  entities?: string[];
  relation?: string;
  surface?: string;
  /** The day a claim counts from (its item's added date), which the claim row does not hold. */
  at?: string;
  /** How precise the evidence row's due date is when less than a day (month or year): a ratchet's year-precision mandate is not a day. */
  due_precision?: "month" | "year";
  /** The counts a capped pattern's summary edge carries. */
  summary?: Record<string, number>;
  /** What a pattern's recompute and its reader need of an evidence row beyond its columns: the role it was read as, the column that supplied its due date, its technical maturity, the class and modes of its entities, and what the detector states about the finding (the condition that fired, a unit or maturity gap, the window). */
  role?: string;
  dueSource?: string;
  trl?: number;
  onto?: Record<string, { class: string; modes: string[] }>;
  marker?: Record<string, string | number | boolean>;
}

/** A derived value as a figure component or the gate sees it. */
export interface Value {
  valueId: string | null;
  entityId: string | null;
  methodId: string;
  methodVersion: string;
  value: number | null;
  valueLow: number | null;
  valueHigh: number | null;
  unit: string | null;
  currency: string | null;
  derivation: Derivation;
  originClass: OriginClass;
  lifecycle: Lifecycle;
  admissibility: Admissibility;
  baseConfidence: number;
  assertedAt: string;
  halfLifeDays: number | null;
  inputs: InputRef[];
  supersedes: string | null;
  computedAt: string;
  computedBy: string;
  /** SDMX CL_OBS_STATUS code when the value wraps an observation (the gate's missing-is-not-zero check). */
  obsStatus?: string | null;
}

/** The gate's answer: refuse with a reason, or admit with the decayed confidence and the label the figure must carry. */
export type Verdict = { ok: false; reason: string } | { ok: true; effectiveConfidence: number; mustLabel: OriginClass };

export interface AsOfTriple {
  eventDate: string;
  sourcePublishedAt?: string | null;
  ingestedAt?: string | null;
}

/** An input to a statutory computation. */
export interface StatutoryInput {
  derivation: Contractable;
  value: number;
  unit: string;
  citation: string;
  asOf: AsOfTriple;
}
export interface StatutoryResult {
  result: number;
  resultUnit: string;
  formulaVersion: string;
}
