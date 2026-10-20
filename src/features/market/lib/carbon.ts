// Ported from old_repo/src/lib/market/carbon-intensity.mjs (lines 1-60)
// Ported from old_repo/src/lib/market/carbon-cost-per-feu.mjs (lines 1-166)
// Ported from old_repo/src/lib/market/select-modal-factor.mjs (lines 23-104)
// Ported from old_repo/src/lib/market/resolve-item-corridor.mjs (lines 24-135)
// Ported from old_repo/src/lib/market/carbon-overlay-view.mjs (lines 1-195)
// Ported from old_repo/src/app/market/page.tsx (lines 72-114)
// The market side of the carbon methods. ONE factor selector (INV-255: an exact single match or a named state, never a pick among several), ONE headline pick (tank-to-wheel, then well-to-wheel, then well-to-tank), and the
// per-FEU arithmetic (INV-254): a range only when factor, distance, payload and carbon price are all present, each number carrying a derivation and a basis; a missing input is a named gap and nothing is invented.
import { CARBON_METHOD_ID, CARBON_METHOD_VERSION, confidenceFromPedigree, lifecycleFromFactorOriginClass } from "@/core/propagation/methods";
import type { Value } from "@/core/propagation/types";

export interface FactorRow {
  factor_id?: string | null;
  mode?: string | null;
  vehicle_class?: string | null;
  jurisdiction?: string | null;
  quantity_basis?: string | null;
  ttw_co2e?: number | null;
  wtt_co2e?: number | null;
  wtw_co2e?: number | null;
  source_key?: string | null;
  tier?: string | null;
  derivation?: string | null;
  origin_class?: string | null;
  method_version?: string | null;
  n_observations?: number | null;
  as_at_date?: string | null;
  pedigree?: number | null;
}
export interface Corridor {
  origin: string;
  dest: string;
  mode: string;
}

const KG_TO_G = 1000;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
/** The headline number of a factor row: tank-to-wheel, then well-to-wheel, then well-to-tank. Never an average across them. */
const headline = (f: FactorRow): { kg: number; label: string } | null => (finite(f.ttw_co2e) ? { kg: f.ttw_co2e, label: "tank-to-wheel" } : finite(f.wtw_co2e) ? { kg: f.wtw_co2e, label: "well-to-wheel" } : finite(f.wtt_co2e) ? { kg: f.wtt_co2e, label: "well-to-tank" } : null);

export type IntensityResult = { ok: true; valueGPerUnit: number; unit: string; basis: string; headlineLabel: string; factorId: string | null; sourceKey: string | null } | { ok: false; reason: string };
/** gCO2e per tonne-km from one emission_factors row. The method registry calls this too (MarketMethodDeps.carbonIntensity). */
export function carbonIntensity(factor: FactorRow | null | undefined): IntensityResult {
  if (!factor || typeof factor !== "object") return { ok: false, reason: "no emission factor row supplied" };
  if (factor.quantity_basis !== "tonne_km") return { ok: false, reason: `quantity basis "${factor.quantity_basis}" has no confirmed per-unit convention; only tonne_km does` };
  const h = headline(factor);
  return h ? { ok: true, valueGPerUnit: h.kg * KG_TO_G, unit: "gCO2e/tonne-km", basis: factor.quantity_basis, headlineLabel: h.label, factorId: factor.factor_id ?? null, sourceKey: factor.source_key ?? null } : { ok: false, reason: "the factor row carries no usable emissions value" };
}

/**
 * The intensity of a resolved factor as a derived figure for display (the method's own arithmetic, not a stored row: a member cannot read the stored values). The figure is asserted at the factor's own date and computed at the
 * request's instant; the confidence is the factor's pedigree, never an invented one.
 */
export function intensityFigure(factor: FactorRow, nowIso: string): Value | null {
  const r = carbonIntensity(factor);
  if (!r.ok) return null;
  return {
    valueId: null, entityId: null, methodId: CARBON_METHOD_ID, methodVersion: CARBON_METHOD_VERSION, value: r.valueGPerUnit, valueLow: null, valueHigh: null, unit: r.unit, currency: null, derivation: "calculated", originClass: "derived",
    lifecycle: lifecycleFromFactorOriginClass(factor.origin_class), admissibility: "calculation_ok", baseConfidence: confidenceFromPedigree(factor.pedigree), assertedAt: factor.as_at_date ?? nowIso, halfLifeDays: null,
    inputs: [{ table: "emission_factors", pk: r.factorId ?? "" }], supersedes: null, computedAt: nowIso, computedBy: `${CARBON_METHOD_ID}@${CARBON_METHOD_VERSION}:render`,
  };
}

export type FactorSelection = { state: "resolved"; factor: FactorRow } | { state: "ambiguous"; jurisdictions: string[] } | { state: "no_factor"; jurisdiction: string | null; reason: "empty" | "global" | "no_match" | "no_mode_basis" };
const token = (raw: unknown): string => (typeof raw === "string" ? raw.trim().toUpperCase() : "");

/**
 * The factor for a signal or a corridor. `jurisdictionIso` given: more than one element is ambiguous (checked before any match), none or GLOBAL is no factor, and a single jurisdiction resolves on one candidate (with `mode`,
 * on one candidate of that mode). `jurisdictionIso` omitted (a corridor): the mode alone, on exactly one candidate of that mode.
 */
export function selectFactor(factors: readonly FactorRow[] | null | undefined, o: { mode?: string | null; jurisdictionIso?: unknown } = {}): FactorSelection {
  const candidates = Array.isArray(factors) ? factors : [];
  const mode = typeof o.mode === "string" && o.mode.trim() ? o.mode.trim().toLowerCase() : null;
  const byMode = (list: readonly FactorRow[]) => (mode ? list.filter((f) => typeof f?.mode === "string" && f.mode.trim().toLowerCase() === mode) : list);
  if (o.jurisdictionIso === undefined) {
    const hit = mode ? byMode(candidates) : [];
    return hit.length === 1 ? { state: "resolved", factor: hit[0] as FactorRow } : { state: "no_factor", jurisdiction: null, reason: mode ? "no_match" : "no_mode_basis" };
  }
  const arr = Array.isArray(o.jurisdictionIso) ? o.jurisdictionIso : [];
  if (arr.length > 1) return { state: "ambiguous", jurisdictions: arr.map(String) };
  const norm = token(arr[0]);
  if (!norm) return { state: "no_factor", jurisdiction: null, reason: "empty" };
  if (norm === "GLOBAL") return { state: "no_factor", jurisdiction: String(arr[0]), reason: "global" };
  const inJurisdiction = candidates.filter((f) => token(f?.jurisdiction) === norm);
  if (inJurisdiction.length === 0) return { state: "no_factor", jurisdiction: String(arr[0]), reason: "no_match" };
  if (mode) {
    const hit = byMode(inJurisdiction);
    return hit.length === 1 ? { state: "resolved", factor: hit[0] as FactorRow } : { state: "no_factor", jurisdiction: String(arr[0]), reason: "no_match" };
  }
  return inJurisdiction.length === 1 ? { state: "resolved", factor: inJurisdiction[0] as FactorRow } : { state: "no_factor", jurisdiction: String(arr[0]), reason: "no_mode_basis" };
}

export interface CarbonOverlayView {
  state: "resolved" | "ambiguous" | "no_factor";
  header: string;
  body: string;
  figure: { value: number; unit: string; mode: string | null; vehicleClass: string | null; jurisdiction: string; sourceKey: string | null } | null;
}
const NO_FACTOR_TEXT: Record<string, (j: string | null) => string> = {
  empty: () => "This signal carries no jurisdiction to key a factor from.",
  global: (j) => `"${j ?? "GLOBAL"}" is not a jurisdiction a national modal default can key off.`,
  no_match: (j) => `No emission factor is available for ${j ?? "this jurisdiction"}.`,
  no_mode_basis: (j) => `${j} has more than one modal-default factor (different transport modes) and this signal gives no basis to pick between them.`,
};
/** The detail block for a signal's national modal default: three honest states, and a figure only from a real resolved selection. */
export function buildCarbonOverlayView({ jurisdictionIso, factors, mode = null }: { jurisdictionIso?: unknown; factors?: readonly FactorRow[]; mode?: string | null }): CarbonOverlayView {
  const sel = selectFactor(factors, { mode, jurisdictionIso: jurisdictionIso ?? [] });
  if (sel.state === "ambiguous") return { state: "ambiguous", header: "Carbon intensity · jurisdiction spans multiple countries", body: `This signal spans multiple jurisdictions (${sel.jurisdictions.join(", ")}), so no single national emission factor applies. Picking one would mean inventing a corridor the signal never named.`, figure: null };
  if (sel.state === "no_factor") return { state: "no_factor", header: "Carbon intensity · not available", body: (NO_FACTOR_TEXT[sel.reason] as (j: string | null) => string)(sel.jurisdiction), figure: null };
  const f = sel.factor;
  const h = headline(f);
  return {
    state: "resolved",
    header: "Carbon intensity · national modal default",
    body: `This is a national ${f.jurisdiction} modal-default factor${f.vehicle_class ? ` for ${String(f.vehicle_class).replace(/_/g, " ")}` : ""}, not a corridor-specific figure.`,
    figure: h ? { value: h.kg, unit: f.quantity_basis === "tonne_km" ? "kg CO2e / tonne-km" : `per ${f.quantity_basis || "unit"}`, mode: f.mode ?? null, vehicleClass: f.vehicle_class ?? null, jurisdiction: String(f.jurisdiction), sourceKey: f.source_key ?? null } : null,
  };
}

