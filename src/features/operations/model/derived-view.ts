// New in P2-12: the customer view of a derived value the flywheel recomputed (spec 04 section 8: comparisons are produced by the flywheel and only read here). Pure: the reader supplies rows and the
// resolved inputs, this file words them. No internal id, table or method name reaches a customer string; a figure carries its inputs and the weakest rating among them, and an unrated input is an absence.
import { originClassLabel } from "./region-grid";

/** The tables whose rows are Operations inputs: cost and fuel prices and exchange rates (market series), emission factors (grid and fuel intensity) and the regional facts themselves. */
export const OPERATIONS_INPUT_TABLES: readonly string[] = ["market_series", "emission_factors", "regional_data_facts"];
const METHOD_WORDS: Readonly<Record<string, string>> = { market_series_delta: "One-week movement", carbon_intensity_tkm: "Carbon intensity per tonne-kilometre", carbon_price_eur_t: "Carbon price benchmark", corridor_distance_km: "Corridor distance", feu_payload_tonnes: "Default container payload", carbon_cost_per_feu: "Carbon cost per FEU" };
/** UI-RADAR-1: the six cross-surface pattern methods in a reader's words (the flywheel radar draws them; they are not Operations figures): the name, what it means for the reader's cost or compliance, and the family it is called while still forming. */
export const PATTERN_COPY: Readonly<Record<string, { label: string; means: string; forming: string }>> = {
  pattern_velocity_burst: { label: "Signal velocity burst", means: "Many sources started reporting on the same subject at once, which often comes before a rule, price or supply change reaches you.", forming: "Signal velocity burst forming" },
  pattern_mandate_capacity: { label: "Mandate vs. capacity collision", means: "A rule requires something by a date while the capacity to comply (fuel, ports, grid) is not yet there, so expect extra cost or delay.", forming: "Mandate vs capacity collision forming" },
  pattern_lead_lag: { label: "Regulatory-to-market lead/lag", means: "A dated regulatory step is followed by a move in a related market price, so watch that price after the date.", forming: "Regulatory lead/lag forming" },
  pattern_cross_modal: { label: "Cross-modal spillover", means: "A change in one transport mode or fuel is reaching another that competes for the same fuel or feedstock.", forming: "Cross-modal or feedstock spillover forming" },
  pattern_penalty_abatement: { label: "Penalty vs. abatement crossover", means: "Paying the penalty and cutting the emissions cost about the same, so the cheaper route for your lanes may change.", forming: "Economic/abatement crossover forming" },
  pattern_regulatory_stacking: { label: "Multi-regulation stacking", means: "Several rules fall due on the same subject within a short window, so the obligations add up instead of arriving one by one.", forming: "Regulatory stacking forming" },
};

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
  /** The two "Why this matters" lines; empty when the facts join was not available. */
  why: readonly string[];
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
export const inputRefs = (inputs: unknown): InputRef[] => (Array.isArray(inputs) ? inputs.filter((i): i is InputRef => !!i && typeof (i as InputRef).table === "string" && (i as InputRef).pk !== undefined && (i as InputRef).pk !== null).map((i) => ({ table: i.table, pk: String(i.pk) })) : []);
/** A recomputed row belongs on Operations when any of its inputs is an Operations input table; a cross-surface pattern belongs to the radar. */
export const isOperationsFigure = (r: DerivedRow): boolean => !(r.method_id in PATTERN_COPY) && inputRefs(r.inputs).some((i) => OPERATIONS_INPUT_TABLES.includes(i.table));

export function toDerivedFigure(r: DerivedRow, inputs: ResolvedInput[], previous: number | null): DerivedFigure {
  const subject = inputs[0]?.label ?? null;
  const method = METHOD_WORDS[r.method_id] ?? "Recalculated figure";
  const tiers = inputs.map((i) => i.tier);
  return {
    valueId: r.value_id, title: subject ? `${method} · ${subject}` : method, value: num(r.value), unit: r.unit, currency: r.currency, originClass: originClassLabel(r.origin_class), lifecycle: r.lifecycle,
    confidence: num(r.base_confidence) ?? 0, computedAt: r.computed_at, previous, inputs, tier: inputs.length > 0 && tiers.every((t) => t !== null) ? Math.max(...(tiers as number[])) : null, why: [],
  };
}
