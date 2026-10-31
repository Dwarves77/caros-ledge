// New in P2-12: the customer view of a derived value the flywheel recomputed (spec 04 section 8: comparisons are produced by the flywheel and only read here). Pure: the reader supplies rows and the
// resolved inputs, this file words them. No internal id, table or method name reaches a customer string; a figure carries its inputs and the weakest rating among them, and an unrated input is an absence.
import { originClassLabel } from "./region-grid";

/** The tables whose rows are Operations inputs: cost and fuel prices and exchange rates (market series), emission factors (grid and fuel intensity) and the regional facts themselves. */
export const OPERATIONS_INPUT_TABLES: readonly string[] = ["market_series", "emission_factors", "regional_data_facts"];
const METHOD_WORDS: Readonly<Record<string, string>> = { carbon_intensity_tkm: "Carbon intensity per tonne-kilometre", carbon_price_eur_t: "Carbon price benchmark", corridor_distance_km: "Corridor distance", feu_payload_tonnes: "Default container payload", carbon_cost_per_feu: "Carbon cost per FEU" };

/** A movement is named for the span its two observations actually cover: a week only when they are 5 to 9 days apart, otherwise the real span ("7-week movement"); unknown dates name no span. */
function movementWords(inputs: readonly ResolvedInput[]): string {
  const at = inputs.map((i) => (i.period && /^\d{4}-\d{2}-\d{2}/.test(i.period) ? Date.parse(i.period.slice(0, 10)) : NaN)).filter(Number.isFinite);
  if (at.length < 2) return "Movement";
  const days = Math.round((Math.max(...at) - Math.min(...at)) / 86_400_000);
  return days >= 5 && days <= 9 ? "One-week movement" : days >= 14 ? `${Math.round(days / 7)}-week movement` : `${days}-day movement`;
}

export interface DerivedRow {
  value_id: string;
  method_id: string;
  value: number | string | null;
  unit: string | null;
  currency: string | null;
  origin_class: string;
  lifecycle: string;
  base_confidence: number | string;
  computed_at: string;
  supersedes: string | null;
  inputs: unknown;
}
export interface InputRef {
  table: string;
  pk: string;
}
export interface ResolvedInput {
  label: string;
  period: string | null;
  sourceName: string | null;
  tier: number | null;
}
export interface DerivedFigure {
  valueId: string;
  title: string;
  value: number | null;
  unit: string | null;
  currency: string | null;
  originClass: string | null;
  lifecycle: string;
  confidence: number;
  computedAt: string;
  /** The value this one replaced when a source changed, or null for a first computation. */
  previous: number | null;
  inputs: ResolvedInput[];
  /** The weakest (highest-numbered) rating among the inputs; null when any input is unrated, which the surface draws as an absence. */
  tier: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
export const inputRefs = (inputs: unknown): InputRef[] => (Array.isArray(inputs) ? inputs.filter((i): i is InputRef => !!i && typeof (i as InputRef).table === "string" && (i as InputRef).pk !== undefined && (i as InputRef).pk !== null).map((i) => ({ table: i.table, pk: String(i.pk) })) : []);
/** A recomputed row belongs on Operations when any of its inputs is an Operations input table; a pattern row is drawn by its own surface. */
export const isOperationsFigure = (r: DerivedRow): boolean => !r.method_id.startsWith("pattern_") && inputRefs(r.inputs).some((i) => OPERATIONS_INPUT_TABLES.includes(i.table));

export function toDerivedFigure(r: DerivedRow, inputs: ResolvedInput[], previous: number | null): DerivedFigure {
  const subject = inputs[0]?.label ?? null;
  const method = r.method_id === "market_series_delta" ? movementWords(inputs) : (METHOD_WORDS[r.method_id] ?? "Recalculated figure");
  const tiers = inputs.map((i) => i.tier);
  return {
    valueId: r.value_id, title: subject ? `${method} · ${subject}` : method, value: num(r.value), unit: r.unit, currency: r.currency, originClass: originClassLabel(r.origin_class), lifecycle: r.lifecycle,
    confidence: num(r.base_confidence) ?? 0, computedAt: r.computed_at, previous, inputs, tier: inputs.length > 0 && tiers.every((t) => t !== null) ? Math.max(...(tiers as number[])) : null,
  };
}
