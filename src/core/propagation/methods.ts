// Ported from old_repo/src/lib/propagation/methods/index.ts (lines 1-138)
// Ported from old_repo/src/lib/propagation/methods/carbon-intensity.ts (lines 1-71)
// Ported from old_repo/src/lib/propagation/methods/market-series-delta.ts (lines 1-86)
// Ported from old_repo/src/lib/propagation/methods/infer-from-question.ts (lines 1-74)
// Ported from old_repo/src/lib/propagation/methods/infer-from-question.ts (lines 291-310)
// ONE registry keyed by (target table, method@version), never overwritten (INV-202): changed behaviour takes a new version, so every derived row
// stays reproducible against the code its computed_by names. A method that nothing can dispatch is not registered (signpost_watch was dead). The
// two market methods call into the market slice through MarketMethodDeps (carbonIntensity, computeSeriesDeltas); P2-08 wires them.
import { patternMethod } from "@/core/flywheel/patterns/method";
import { scoreImpact, type ImpactInput, type ImpactScore } from "@/core/impact/score";

import { FLOOR } from "./admissible";
import { CARBON } from "./carbon-rules";
import { INFER_METHOD_ID, INFER_METHOD_VERSION, INFER_METHOD_VERSION_V1, type StatusToken } from "./register";
import type { Admissibility, Derivation, Lifecycle, OriginClass } from "./types";

export interface ResolvedMethodInput {
  table: string;
  pk: string;
  version?: string | null;
  row: unknown;
  kind?: string;
  entities?: string[];
  relation?: string;
  surface?: string;
  at?: string;
  summary?: Record<string, number>;
  role?: string;
  dueSource?: string;
  trl?: number;
  onto?: Record<string, { class: string; modes: string[] }>;
  marker?: Record<string, string | number | boolean>;
}
export interface MethodContext {
  entityId: string | null;
  inputs: ResolvedMethodInput[];
  priorValue: unknown | null;
  now: Date;
}
export type MethodResult =
  | { ok: true; value?: number | null; valueLow?: number | null; valueHigh?: number | null; unit?: string | null; currency?: string | null; derivation: Derivation; originClass: OriginClass; lifecycle: Lifecycle; admissibility: Admissibility; confidence: number; halfLifeDays?: number | null; basis?: string }
  | { ok: false; reason: string };
export type InferenceResult =
  | { ok: true; claimText: string; statusToken: StatusToken; confidence: number; citedItemIds: string[]; originClass: "derived" | "modelled"; reopenQuestionRef?: string | null }
  | { ok: false; reason: string };
export type MethodFn = (ctx: MethodContext) => Promise<MethodResult> | MethodResult;
export type InferenceFn = (ctx: MethodContext) => Promise<InferenceResult> | InferenceResult;
/** The impact score of an item (IMPACT-1): pure, over what the item holds, stored in item_impact_scores. */
export type ImpactFn = (input: ImpactInput) => ImpactScore;
export type MethodTable = "derived_values" | "inference_records" | "item_impact_scores";

const methodKey = (methodId: string, methodVersion: string): string => `${methodId}@${methodVersion}`;

class MethodRegistry {
  private readonly derived = new Map<string, MethodFn>();
  private readonly inference = new Map<string, InferenceFn>();
  private readonly impact = new Map<string, ImpactFn>();
  private readonly newest = new Map<string, string>();

  /** Register once. A second registration of the same key (in either table) throws: the key is a promise about the code. */
  register(table: "derived_values", id: string, version: string, fn: MethodFn): void;
  register(table: "inference_records", id: string, version: string, fn: InferenceFn): void;
  register(table: "item_impact_scores", id: string, version: string, fn: ImpactFn): void;
  register(table: MethodTable, id: string, version: string, fn: MethodFn | InferenceFn | ImpactFn): void {
    const key = methodKey(id, version);
    if (this.derived.has(key) || this.inference.has(key) || this.impact.has(key)) throw new Error(`registerMethod: "${key}" is already registered; a method is never silently overwritten. Register a NEW version for changed behaviour.`);
    if (table === "derived_values") this.derived.set(key, fn as MethodFn);
    else if (table === "inference_records") this.inference.set(key, fn as InferenceFn);
    else this.impact.set(key, fn as ImpactFn);
    this.newest.set(`${table}:${id}`, version);
  }
  /** The version registered last for a method id: a row computed by an older version is recomputed by this one, and its successor is written under this version. */
  latestVersion(table: MethodTable, id: string): string | undefined {
    return this.newest.get(`${table}:${id}`);
  }
  get(table: "derived_values", id: string, version: string): MethodFn | undefined;
  get(table: "inference_records", id: string, version: string): InferenceFn | undefined;
  get(table: "item_impact_scores", id: string, version: string): ImpactFn | undefined;
  get(table: MethodTable, id: string, version: string): MethodFn | InferenceFn | ImpactFn | undefined {
    return this.of(table).get(methodKey(id, version));
  }
  has(table: MethodTable, id: string, version: string): boolean {
    return this.of(table).has(methodKey(id, version));
  }
  keys(table: MethodTable): string[] {
    return [...this.of(table).keys()].sort();
  }
  private of(table: MethodTable): Map<string, MethodFn | InferenceFn | ImpactFn> {
    return table === "derived_values" ? this.derived : table === "inference_records" ? this.inference : this.impact;
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
const computeInferFromQuestion: InferenceFn = (ctx) => {
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

export const IMPACT_METHOD_ID = "impact_scores";
export const IMPACT_METHOD_VERSION = "1.0.0";
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
const lifecycleFromOriginClasses = (classes: readonly (string | null | undefined)[]): "verified" | "corroborated" => (classes.length > 0 && classes.every((oc) => oc === "official" || oc === "verified") ? "verified" : "corroborated");

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

function buildMarketDeltaMethod(deps: Pick<MarketMethodDeps, "computeSeriesDeltas">): MethodFn {
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

export const PRICE_METHOD_ID = "carbon_price_eur_t", PRICE_METHOD_VERSION = "1.0.0";
export const DISTANCE_METHOD_ID = "corridor_distance_km", DISTANCE_METHOD_VERSION = "1.0.0";
export const PAYLOAD_METHOD_ID = "feu_payload_tonnes", PAYLOAD_METHOD_VERSION = "1.0.0";
export const COST_METHOD_ID = "carbon_cost_per_feu", COST_METHOD_VERSION = "1.0.0";

/** A dated observation of a market series as a method input; `source_tier` is the rating of its source (the stage reads it). */
interface ObservedRow {
  series_key: string;
  value_numeric: number | string | null;
  unit: string | null;
  currency: string | null;
  derivation: Derivation;
  origin_class: OriginClass;
  as_at_date: string | null;
  reference_period: string | null;
  source_tier?: number | null;
}
const refuse = (reason: string): MethodResult => ({ ok: false, reason });
const dateOf = (r: ObservedRow): string => r.as_at_date ?? r.reference_period ?? "";

/** The latest dated observation among the rows given (the carbon price, the payload default), in the unit the rules accept; the rating of its source decides whether the value may serve a filing. */
function buildObservedMethod(spec: { units: readonly string[]; unit: string; currency: string | null }): MethodFn {
  return (ctx) => {
    const latest = ctx.inputs.map((i) => i.row as ObservedRow | null).filter((r): r is ObservedRow => !!r).sort((a, b) => dateOf(b).localeCompare(dateOf(a)))[0];
    if (!latest) return refuse("no observation supplied");
    const value = Number(latest.value_numeric);
    if (!Number.isFinite(value) || value <= 0) return refuse(`the latest observation of ${latest.series_key} holds no positive number`);
    if (!spec.units.includes(String(latest.unit))) return refuse(`${latest.series_key} is in "${latest.unit}", not ${spec.units.join(" or ")}`);
    if (spec.currency && latest.currency !== spec.currency) return refuse(`${latest.series_key} is in ${latest.currency}, not ${spec.currency}`);
    const tier = latest.source_tier ?? null;
    return { ok: true, value, unit: spec.unit, currency: spec.currency, derivation: latest.derivation, originClass: latest.origin_class, lifecycle: lifecycleFromFactorOriginClass(latest.origin_class), admissibility: tier !== null && tier <= CARBON.filingMaxTier ? "filing_ok" : "display_only", confidence: CARBON.observedConfidence, halfLifeDays: null, basis: `${latest.series_key}, observed ${dateOf(latest)}` };
  };
}

const radians = (degrees: number): number => (degrees * Math.PI) / 180;
/** The great-circle distance between the two ports of a corridor (inputs: origin then destination, each row a position or null). An end with no position refuses and names its code. */
const corridorDistance: MethodFn = (ctx) => {
  if (ctx.inputs.length !== 2) return refuse("a corridor has an origin and a destination");
  const missing = ctx.inputs.filter((i) => !i.row).map((i) => i.pk);
  if (missing.length) return refuse(CARBON.absence.distance.replace("{codes}", missing.join(", ")));
  const [a, b] = ctx.inputs.map((i) => i.row as { lat: number; lon: number }) as [{ lat: number; lon: number }, { lat: number; lon: number }];
  const h = Math.sin(radians(b.lat - a.lat) / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.lon - a.lon) / 2) ** 2;
  const km = 2 * CARBON.distance.earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
  return { ok: true, value: Math.round(km * 10) / 10, unit: "km", derivation: "calculated", originClass: "derived", lifecycle: "corroborated", admissibility: CARBON.distance.admissibility, confidence: CARBON.distance.confidence, halfLifeDays: null, basis: `${CARBON.distance.basis}: ${ctx.inputs[0]?.pk} to ${ctx.inputs[1]?.pk}` };
};

/** The derived values the cost is computed from, as the rows the store holds them. */
interface ValueRow {
  method_id: string;
  value: number | string | null;
  unit: string | null;
  currency: string | null;
  admissibility: Admissibility;
  base_confidence: number | string;
}
/** distance x intensity x payload x price, from the four derived values (inputs: any order, found by method). Statutory-grade only when every input is filing-grade; otherwise display-grade, and the ceiling refuses it for a filing. */
const costPerFeu: MethodFn = (ctx) => {
  const rows = ctx.inputs.map((i) => i.row as ValueRow | null);
  const [price, km, tonnes, grams] = [PRICE_METHOD_ID, DISTANCE_METHOD_ID, PAYLOAD_METHOD_ID, CARBON_METHOD_ID].map((id) => rows.find((r) => r?.method_id === id) ?? null);
  if (!price || !km || !tonnes || !grams) return refuse("the cost needs the price, the distance, the payload and the intensity");
  if (grams.unit !== CARBON.cost.intensityUnit) return refuse(`the intensity is in "${grams.unit}", not ${CARBON.cost.intensityUnit}`);
  const value = Number(km.value) * (Number(grams.value) / CARBON.cost.gramsPerTonne) * Number(tonnes.value) * Number(price.value);
  if (!Number.isFinite(value)) return refuse("an input holds no number");
  const inputs = [price, km, tonnes, grams];
  const filing = inputs.every((r) => r.admissibility === "filing_ok");
  return { ok: true, value, unit: CARBON.cost.unit, currency: price.currency, derivation: filing ? "calculated" : "estimated", originClass: "derived", lifecycle: filing ? "verified" : "corroborated", admissibility: filing ? "filing_ok" : "display_only", confidence: Math.min(...inputs.map((r) => Number(r.base_confidence))), halfLifeDays: null, basis: CARBON.cost.basis };
};

const VELOCITY_ID = "pattern_velocity_burst", VELOCITY_VERSION = "1.4.0";
const MANDATE_ID = "pattern_mandate_capacity", MANDATE_VERSION = "1.4.0";
const LEADLAG_ID = "pattern_lead_lag", LEADLAG_VERSION = "1.4.0";
const CROSSMODAL_ID = "pattern_cross_modal", CROSSMODAL_VERSION = "1.4.0";
const ABATEMENT_ID = "pattern_penalty_abatement", ABATEMENT_VERSION = "1.5.0";
const STACKING_ID = "pattern_regulatory_stacking", STACKING_VERSION = "1.0.0";
/** The six pattern detectors (CONNECT-2, ENGINE-CORE-FIX-1) by kind: the id and version a pattern is registered under. */
export const PATTERN_METHODS = {
  velocity: { id: VELOCITY_ID, version: VELOCITY_VERSION }, mandateCapacity: { id: MANDATE_ID, version: MANDATE_VERSION }, leadLag: { id: LEADLAG_ID, version: LEADLAG_VERSION },
  crossModal: { id: CROSSMODAL_ID, version: CROSSMODAL_VERSION }, penaltyAbatement: { id: ABATEMENT_ID, version: ABATEMENT_VERSION }, regulatoryStacking: { id: STACKING_ID, version: STACKING_VERSION },
} as const;

export type { MethodRegistry };

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
  r.register("item_impact_scores", IMPACT_METHOD_ID, IMPACT_METHOD_VERSION, scoreImpact);
  // The carbon cost per FEU (CARBON-1): the four inputs and the cost, each written by the propagate stage with its version, basis and ceiling.
  r.register("derived_values", PRICE_METHOD_ID, PRICE_METHOD_VERSION, buildObservedMethod(CARBON.price));
  r.register("derived_values", PAYLOAD_METHOD_ID, PAYLOAD_METHOD_VERSION, buildObservedMethod(CARBON.payload));
  r.register("derived_values", DISTANCE_METHOD_ID, DISTANCE_METHOD_VERSION, corridorDistance);
  r.register("derived_values", COST_METHOD_ID, COST_METHOD_VERSION, costPerFeu);
  // The five pattern detectors (CONNECT-2): each recomputes a stored pattern from its evidence rows; the thresholds in flywheel/patterns/data are part of the method.
  r.register("derived_values", VELOCITY_ID, VELOCITY_VERSION, patternMethod("velocity"));
  r.register("derived_values", MANDATE_ID, MANDATE_VERSION, patternMethod("mandateCapacity"));
  r.register("derived_values", LEADLAG_ID, LEADLAG_VERSION, patternMethod("leadLag"));
  r.register("derived_values", CROSSMODAL_ID, CROSSMODAL_VERSION, patternMethod("crossModal"));
  r.register("derived_values", ABATEMENT_ID, ABATEMENT_VERSION, patternMethod("penaltyAbatement"));
  r.register("derived_values", STACKING_ID, STACKING_VERSION, patternMethod("regulatoryStacking"));
  return r;
}
/** The process-wide registry the drain and authorEdges default to. */
export const METHODS: MethodRegistry = createMethodRegistry();
