// Ported from old_repo/src/lib/propagation/methods/index.ts (lines 1-138)
// Ported from old_repo/src/lib/propagation/methods/carbon-intensity.ts (lines 1-71)
// Ported from old_repo/src/lib/propagation/methods/market-series-delta.ts (lines 1-86)
// Ported from old_repo/src/lib/propagation/methods/infer-from-question.ts (lines 1-74)
// Ported from old_repo/src/lib/propagation/methods/infer-from-question.ts (lines 291-310)
// ONE registry keyed by (target table, method@version), never overwritten (INV-202): changed behaviour takes a new version, so every derived row
// stays reproducible against the code its computed_by names. A method that nothing can dispatch is not registered (signpost_watch was dead). The
// two market methods call into the market slice through MarketMethodDeps (carbonIntensity, computeSeriesDeltas); P2-08 wires them.
import { FLOOR } from "./admissible";
import { INFER_METHOD_ID, INFER_METHOD_VERSION, INFER_METHOD_VERSION_V1, type StatusToken } from "./register";
import type { Admissibility, Derivation, Lifecycle, OriginClass } from "./types";

export interface ResolvedMethodInput {
  table: string;
  pk: string;
  version?: string | null;
  row: unknown;
}
export interface MethodContext {
  entityId: string | null;
  inputs: ResolvedMethodInput[];
  priorValue: unknown | null;
  now: Date;
}
export type MethodResult =
  | { ok: true; value?: number | null; valueLow?: number | null; valueHigh?: number | null; unit?: string | null; currency?: string | null; derivation: Derivation; originClass: OriginClass; lifecycle: Lifecycle; admissibility: Admissibility; confidence: number; halfLifeDays?: number | null }
  | { ok: false; reason: string };
export type InferenceResult =
  | { ok: true; claimText: string; statusToken: StatusToken; confidence: number; citedItemIds: string[]; originClass: "derived" | "modelled"; reopenQuestionRef?: string | null }
  | { ok: false; reason: string };
export type MethodFn = (ctx: MethodContext) => Promise<MethodResult> | MethodResult;
export type InferenceFn = (ctx: MethodContext) => Promise<InferenceResult> | InferenceResult;
export type MethodTable = "derived_values" | "inference_records";

export const methodKey = (methodId: string, methodVersion: string): string => `${methodId}@${methodVersion}`;

export class MethodRegistry {
  private readonly derived = new Map<string, MethodFn>();
  private readonly inference = new Map<string, InferenceFn>();
  private readonly newest = new Map<string, string>();

  /** Register once. A second registration of the same key (in either table) throws: the key is a promise about the code. */
  register(table: "derived_values", id: string, version: string, fn: MethodFn): void;
  register(table: "inference_records", id: string, version: string, fn: InferenceFn): void;
  register(table: MethodTable, id: string, version: string, fn: MethodFn | InferenceFn): void {
    const key = methodKey(id, version);
    if (this.derived.has(key) || this.inference.has(key)) throw new Error(`registerMethod: "${key}" is already registered; a method is never silently overwritten. Register a NEW version for changed behaviour.`);
    if (table === "derived_values") this.derived.set(key, fn as MethodFn);
    else this.inference.set(key, fn as InferenceFn);
    this.newest.set(`${table}:${id}`, version);
  }
  /** The version registered last for a method id: a row computed by an older version is recomputed by this one, and its successor is written under this version. */
  latestVersion(table: MethodTable, id: string): string | undefined {
    return this.newest.get(`${table}:${id}`);
  }
  get(table: "derived_values", id: string, version: string): MethodFn | undefined;
  get(table: "inference_records", id: string, version: string): InferenceFn | undefined;
  get(table: MethodTable, id: string, version: string): MethodFn | InferenceFn | undefined {
    return (table === "derived_values" ? this.derived : this.inference).get(methodKey(id, version));
  }
  has(table: MethodTable, id: string, version: string): boolean {
    return (table === "derived_values" ? this.derived : this.inference).has(methodKey(id, version));
  }
  keys(table: MethodTable): string[] {
    return [...(table === "derived_values" ? this.derived : this.inference).keys()].sort();
  }
}

export interface PriorInferenceRow {
  inference_id: string;
  claim_text: string;
  cited_item_ids: string[];
  trigger_question_ref: string | null;
  status_token: StatusToken;
  confidence: number;
  origin_class: "derived" | "modelled";
}

/** Recompute an inference against its resolved inputs: HYPOTHESIS at the analysis floor, never self-labelled CONFIRMED (ADR-044). */
export const computeInferFromQuestion: InferenceFn = (ctx) => {
  const prior = ctx.priorValue as PriorInferenceRow | null;
  const cited = Array.isArray(prior?.cited_item_ids) ? prior.cited_item_ids.filter(Boolean) : [];
  if (!prior || cited.length === 0) return { ok: false, reason: "no prior inference_records row with cited_item_ids to recompute from" };
  const resolved = (ctx.inputs ?? []).filter((i) => i.row !== null);
  if ((ctx.inputs ?? []).length > 0 && resolved.length === 0) return { ok: false, reason: "every declared input is unresolvable" };
  const token: StatusToken = "HYPOTHESIS";
  return { ok: true, claimText: `${prior.claim_text} (recomputed against ${resolved.length} resolved input(s)).`, statusToken: token, confidence: FLOOR.analysis, citedItemIds: cited, originClass: "derived", reopenQuestionRef: prior.trigger_question_ref ?? null };
};

/**
 * Re-evaluate an inference against the holdings it cites (R2d, I14): the declared inputs arrive resolved through the admissible-row rule, so a cited item that is archived, unverified, suppressed or replaced is
 * a null row. Every cited item still current: the inference stands, its text, status token and confidence carried over unchanged (a recompute proves nothing it did not check, and never edits what was said).
 * A cited item gone: the successor is REFUTED, same text, same confidence, same citations, so the history shows what was claimed and when it stopped holding. Never CONFIRMED (ADR-044): a prior CONFIRMED reads as HYPOTHESIS.
 */
const reevaluateInference: InferenceFn = (ctx) => {
  const prior = ctx.priorValue as PriorInferenceRow | null;
  const cited = Array.isArray(prior?.cited_item_ids) ? prior.cited_item_ids.filter(Boolean) : [];
  if (!prior || cited.length === 0) return { ok: false, reason: "no prior inference_records row with cited_item_ids to re-evaluate" };
  if (typeof prior.confidence !== "number" || !Number.isFinite(prior.confidence) || prior.confidence < 0 || prior.confidence > 1) return { ok: false, reason: "the prior inference carries no confidence to carry over" };
  if (!(ctx.inputs ?? []).length) return { ok: false, reason: "the inference declares no inputs, so there is nothing to re-evaluate it against" };
  const stands = ctx.inputs.every((i) => i.row !== null);
  const token: StatusToken = !stands || prior.status_token === "REFUTED" ? "REFUTED" : "HYPOTHESIS";
  return { ok: true, claimText: prior.claim_text, statusToken: token, confidence: prior.confidence, citedItemIds: cited, originClass: prior.origin_class === "modelled" ? "modelled" : "derived", reopenQuestionRef: prior.trigger_question_ref ?? null };
};

export const CARBON_METHOD_ID = "carbon_intensity_tkm";
export const CARBON_METHOD_VERSION = "1.0.0";
export const MARKET_DELTA_METHOD_ID = "market_series_delta";
export const MARKET_DELTA_METHOD_VERSION = "1.0.0";

/** Pedigree 1..5 (best..worst) to a base confidence; unscored factors read 0.7. */
export function confidenceFromPedigree(pedigree: number | null | undefined): number {
  return typeof pedigree === "number" && Number.isFinite(pedigree) && pedigree >= 1 && pedigree <= 5 ? (6 - pedigree) / 5 : 0.7;
}
export const lifecycleFromFactorOriginClass = (originClass: string | null | undefined): "verified" | "corroborated" => (originClass === "official" || originClass === "verified" ? "verified" : "corroborated");
/** Verified only when EVERY input is official or verified. */
export const lifecycleFromOriginClasses = (classes: readonly (string | null | undefined)[]): "verified" | "corroborated" => (classes.length > 0 && classes.every((oc) => oc === "official" || oc === "verified") ? "verified" : "corroborated");

export interface FactorRow {
  factor_id?: string;
  quantity_basis: string;
  ttw_co2e: number | null;
  wtw_co2e: number | null;
  wtt_co2e: number | null;
  source_key: string;
  origin_class: string;
  pedigree: number;
}
export interface SeriesRow {
  series_key: string;
  reference_period: string | null;
  as_at_date: string | null;
  value_numeric: number | string | null;
  unit: string | null;
  currency: string | null;
  origin_class: string;
}
type DeltaWindow = { value?: number; unitMismatch?: boolean; insufficientHistory?: boolean; fromDate?: string };
/** What the market slice supplies: the factor arithmetic and the series deltas. */
export interface MarketMethodDeps {
  carbonIntensity(factor: FactorRow): { ok: true; valueGPerUnit: number; unit: string } | { ok: false; reason: string };
  computeSeriesDeltas(rows: SeriesRow[]): { delta1w?: DeltaWindow | null; latest?: { unit?: string | null; currency?: string | null } | null };
}

export function buildCarbonMethod(deps: Pick<MarketMethodDeps, "carbonIntensity">): MethodFn {
  return (ctx) => {
    const ref = ctx.inputs.find((i) => i.table === "emission_factors" && i.row);
    if (!ref?.row) return { ok: false, reason: "no resolvable emission_factors input" };
    const factor = ref.row as FactorRow;
    const r = deps.carbonIntensity(factor);
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, value: r.valueGPerUnit, unit: r.unit, derivation: "calculated", originClass: "derived", lifecycle: lifecycleFromFactorOriginClass(factor.origin_class), admissibility: "calculation_ok", confidence: confidenceFromPedigree(factor.pedigree), halfLifeDays: null };
  };
}

export function buildMarketDeltaMethod(deps: Pick<MarketMethodDeps, "computeSeriesDeltas">): MethodFn {
  return (ctx) => {
    const rows = ctx.inputs.map((i) => i.row).filter((r): r is SeriesRow => Boolean(r));
    if (rows.length < 2) return { ok: false, reason: `fewer than 2 resolvable market_series inputs (got ${rows.length})` };
    const keys = new Set(rows.map((r) => r.series_key));
    if (keys.size !== 1) return { ok: false, reason: `inputs span more than one series_key: ${[...keys].join(", ")}` };
    const deltas = deps.computeSeriesDeltas(rows);
    const d = deltas.delta1w;
    if (!d) return { ok: false, reason: "no 1-week delta window in computeSeriesDeltas output" };
    if (d.unitMismatch) return { ok: false, reason: `unit/currency changed since ${d.fromDate}: refusing to compare across a unit change` };
    if (d.insufficientHistory) return { ok: false, reason: "insufficient history for a 1-week delta (need a resolvable prior observation)" };
    if (typeof d.value !== "number") return { ok: false, reason: "computeSeriesDeltas returned no usable delta1w value" };
    return { ok: true, value: d.value, unit: deltas.latest?.unit ?? null, currency: deltas.latest?.currency ?? null, derivation: "calculated", originClass: "derived", lifecycle: lifecycleFromOriginClasses(rows.map((r) => r.origin_class)), admissibility: "calculation_ok", confidence: 0.9, halfLifeDays: null };
  };
}

/** Register the two market methods on a registry once the market slice's functions are at hand. */
export function registerMarketMethods(registry: MethodRegistry, deps: MarketMethodDeps): void {
  registry.register("derived_values", CARBON_METHOD_ID, CARBON_METHOD_VERSION, buildCarbonMethod(deps));
  registry.register("derived_values", MARKET_DELTA_METHOD_ID, MARKET_DELTA_METHOD_VERSION, buildMarketDeltaMethod(deps));
}

/** A registry with the method that needs no other slice. */
export function createMethodRegistry(): MethodRegistry {
  const r = new MethodRegistry();
  // v1 stays registered unchanged (INV-202: the rows it computed stay reproducible); the drain recomputes with the latest version, so a v1 row is re-evaluated by v2 and its successor is written as v2.
  r.register("inference_records", INFER_METHOD_ID, INFER_METHOD_VERSION_V1, computeInferFromQuestion);
  r.register("inference_records", INFER_METHOD_ID, INFER_METHOD_VERSION, reevaluateInference);
  return r;
}
/** The process-wide registry the drain and authorEdges default to. */
export const METHODS: MethodRegistry = createMethodRegistry();
