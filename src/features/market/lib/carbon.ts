// Ported from old_repo/src/lib/market/carbon-intensity.mjs (lines 1-60)
// Ported from old_repo/src/lib/market/carbon-cost-per-feu.mjs (lines 1-166)
// Ported from old_repo/src/lib/market/select-modal-factor.mjs (lines 23-104)
// Ported from old_repo/src/lib/market/resolve-item-corridor.mjs (lines 24-135)
// Ported from old_repo/src/lib/market/carbon-overlay-view.mjs (lines 1-195)
// Ported from old_repo/src/app/market/page.tsx (lines 72-114)
// The market side of the carbon methods. ONE factor selector (INV-255: an exact single match or a named state, never a pick among several), ONE headline pick (tank-to-wheel, then well-to-wheel, then well-to-tank), and the
// per-FEU arithmetic (INV-254): a range only when factor, distance, payload and carbon price are all present, each number carrying a derivation and a basis; a missing input is a named gap and nothing is invented.
import { isContractable, isStatutory, DERIVATIONS } from "@/core/contracts";
import type { CorridorScope } from "@/core/entities";
import { formatCorridorLabel, parseCorridorName } from "@/core/entities";
import { sensitivityBand } from "@/core/figures";
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

export interface CorridorCandidate extends Corridor {
  entityId: string;
}
/** Corridor entities to candidates by parsing their canonical name; a name that does not parse is skipped and named, never guessed. */
export function candidatesFromCorridorEntities(rows: ReadonlyArray<{ entity_id: string; canonical_name: string }>): { candidates: CorridorCandidate[]; skipped: string[] } {
  const candidates: CorridorCandidate[] = [];
  const skipped: string[] = [];
  for (const r of rows ?? []) {
    const parsed = parseCorridorName(r?.canonical_name);
    if (parsed) candidates.push({ entityId: r.entity_id, ...parsed });
    else skipped.push(String(r?.canonical_name));
  }
  return { candidates, skipped };
}

export type CorridorMatch = { state: "resolved"; corridor: Corridor; matchedCandidateIds: string[] } | { state: "ambiguous"; corridor: null; matchedCandidateIds: string[] } | { state: "no_corridor_identity"; corridor: null; matchedCandidateIds: [] };
const countriesOf = (c: Corridor): Set<string> => new Set([c.origin.slice(0, 2), c.dest.slice(0, 2)].map((x) => x.toUpperCase()).filter(Boolean));
/**
 * The seeded corridor a signal means, from its jurisdiction set (UNORDERED: no direction is invented) and its single mode. Two corridors sharing the country set are ambiguous (picking by mode would still invent which route);
 * a mode that differs from the one corridor, or none or several modes on the item, is no identity.
 */
export function resolveItemCorridor({ jurisdictionIso, modes, candidates }: { jurisdictionIso?: unknown; modes?: unknown; candidates?: readonly CorridorCandidate[] }): CorridorMatch {
  const item = new Set((Array.isArray(jurisdictionIso) ? jurisdictionIso : []).map(token).filter(Boolean));
  const same = (c: Corridor) => {
    const set = countriesOf(c);
    return set.size === item.size && [...set].every((x) => item.has(x));
  };
  const matches = (candidates ?? []).filter(same);
  if (matches.length === 0) return { state: "no_corridor_identity", corridor: null, matchedCandidateIds: [] };
  if (matches.length > 1) return { state: "ambiguous", corridor: null, matchedCandidateIds: matches.map((c) => c.entityId) };
  const only = matches[0] as CorridorCandidate;
  const list = (Array.isArray(modes) ? modes : []).filter((m): m is string => typeof m === "string" && !!m.trim());
  if (list.length !== 1 || (list[0] as string).trim().toLowerCase() !== only.mode.trim().toLowerCase()) return { state: "no_corridor_identity", corridor: null, matchedCandidateIds: [] };
  return { state: "resolved", corridor: { origin: only.origin, dest: only.dest, mode: only.mode }, matchedCandidateIds: [only.entityId] };
}

/** Named gap reasons: stable customer-facing sentences, never composed per call site. */
export const GAP = Object.freeze({
  NO_FACTOR: "no emission factor supplied for this corridor's mode",
  NO_DISTANCE: "no corridor routing distance available yet (no licence-clear distance dataset in this product today)",
  NO_PAYLOAD: "no cited tonnes-per-FEU payload convention available (GLEC and ISO 14083 are both licence-prohibited; no substitute is registered)",
  NO_CARBON_PRICE: "no EU ETS/FuelEU/CBAM/UKA carbon-price input from carrier-published surcharges",
});

export interface Provenanced {
  value: number;
  derivation: string;
  basis: string;
}
export interface CarbonPrice extends Provenanced {
  currency: string;
  sourceKey: string;
  asOf: string | null;
}
export interface CarbonCostInput {
  corridor: Corridor;
  factor?: FactorRow | null;
  distance?: Provenanced | null;
  payload?: Provenanced | null;
  carbonPrice?: CarbonPrice | null;
}
export type CarbonCostResult =
  | { ok: true; corridor: Corridor; unit: "FEU"; currency: string; low: number; point: number; high: number; classification: "statutory" | "derived" | "estimate"; intensity: Extract<IntensityResult, { ok: true }>; distance: Provenanced; payload: Provenanced; carbonPrice: CarbonPrice; gaps: [] }
  | { ok: false; corridor: Corridor; gaps: string[]; partial: { intensity: Extract<IntensityResult, { ok: true }> | null; distance: Provenanced | null; payload: Provenanced | null; carbonPrice: CarbonPrice | null } };

/** A number with no derivation or no basis citation is a caller bug, not a data gap: it throws rather than rendering an unlabelled number. */
function requireProvenance(name: string, p: Provenanced | null | undefined): void {
  if (p === null || p === undefined) return;
  if (!finite(p.value)) throw new Error(`carbonCostPerFeu: ${name} must be a finite number or null (got ${JSON.stringify(p.value)})`);
  if (!DERIVATIONS.includes(p.derivation)) throw new Error(`carbonCostPerFeu: ${name} derivation must be one of ${DERIVATIONS.join(", ")} (got ${JSON.stringify(p.derivation)})`);
  if (!p.basis?.trim()) throw new Error(`carbonCostPerFeu: ${name}=${p.value} was supplied with no basis citation; every number carries its provenance`);
}

export function carbonCostPerFeu(input: CarbonCostInput): CarbonCostResult {
  const { corridor, factor = null, distance = null, payload = null, carbonPrice = null } = input ?? ({} as CarbonCostInput);
  if (!corridor?.origin || !corridor.dest || !corridor.mode) throw new Error("carbonCostPerFeu: corridor { origin, dest, mode } is required");
  requireProvenance("distance", distance);
  requireProvenance("payload", payload);
  requireProvenance("carbonPrice", carbonPrice);
  if (carbonPrice && !carbonPrice.currency) throw new Error("carbonCostPerFeu: carbonPrice.currency is required whenever carbonPrice is supplied");

  const gaps: string[] = [];
  const intensity = factor ? carbonIntensity(factor) : null;
  if (!intensity) gaps.push(GAP.NO_FACTOR);
  else if (!intensity.ok) gaps.push(`${GAP.NO_FACTOR} (${intensity.reason})`);
  if (!distance) gaps.push(GAP.NO_DISTANCE);
  if (!payload) gaps.push(GAP.NO_PAYLOAD);
  if (!carbonPrice) gaps.push(GAP.NO_CARBON_PRICE);
  const resolved = intensity && intensity.ok ? intensity : null;
  if (gaps.length > 0 || !resolved || !distance || !payload || !carbonPrice || !factor) return { ok: false, corridor, gaps, partial: { intensity: resolved, distance, payload, carbonPrice } };

  // Only a non-contractable input varies by the sensitivity convention; a contractable one (observed, calculated, a published rate) is never second-guessed. The factor carries no published band, so none is invented.
  const bounds = (p: Provenanced) => (isContractable(p.derivation) ? { low: p.value, high: p.value } : sensitivityBand(p.value));
  const cost = (km: number, tonnes: number, price: number) => ((resolved.valueGPerUnit / 1000) * tonnes * km * price) / 1000;
  const [d, p, c] = [bounds(distance), bounds(payload), bounds(carbonPrice)];
  const derivations = [factor.derivation ?? "", distance.derivation, payload.derivation, carbonPrice.derivation];
  const classification = derivations.every(isStatutory) ? "statutory" : derivations.every(isContractable) ? "derived" : "estimate";
  return { ok: true, corridor, unit: "FEU", currency: carbonPrice.currency, low: cost(d.low, p.low, c.low), point: cost(distance.value, payload.value, carbonPrice.value), high: cost(d.high, p.high, c.high), classification, intensity: resolved, distance, payload, carbonPrice, gaps: [] };
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

export interface CarbonCostPerFeuView {
  state: "resolved" | "ambiguous";
  label: string | null;
  result: CarbonCostResult | null;
  body: string | null;
}
/** The detail page's per-FEU block; null exactly when the signal has no corridor identity (nothing extra renders). */
export function buildCarbonCostPerFeuView(o: { jurisdictionIso?: unknown; modes?: unknown; factors?: readonly FactorRow[]; corridorCandidates?: readonly CorridorCandidate[] }): CarbonCostPerFeuView | null {
  const match = resolveItemCorridor({ jurisdictionIso: o.jurisdictionIso, modes: o.modes, candidates: o.corridorCandidates ?? [] });
  if (match.state === "no_corridor_identity") return null;
  if (match.state === "ambiguous") return { state: "ambiguous", label: null, result: null, body: "This signal's jurisdictions match more than one corridor. Caro's Ledge will not guess which one applies, so no per-FEU figure is shown here." };
  const sel = selectFactor(o.factors, { mode: match.corridor.mode });
  return { state: "resolved", label: formatCorridorLabel(match.corridor), result: carbonCostPerFeu({ corridor: match.corridor, factor: sel.state === "resolved" ? sel.factor : null }), body: null };
}

export interface CarbonOverlayEntry {
  label: string;
  corridor: Corridor;
  entityId: string;
  jurisdictions: ReadonlyArray<{ code: string; name: string | null }>;
  result: CarbonCostResult;
}
/** One overlay entry per live corridor entity whose name parsed. Distance, payload and carbon price are inputs no licence-clear source carries yet, so each is a named gap until one does. */
export function buildCarbonCostOverlays(corridors: readonly CorridorScope[], factors: readonly FactorRow[]): CarbonOverlayEntry[] {
  return corridors
    .filter((c) => c.parsed !== null)
    .map((c) => {
      const corridor = c.parsed as Corridor;
      const sel = selectFactor(factors, { mode: corridor.mode });
      return { label: c.label, corridor, entityId: c.entityId, jurisdictions: c.jurisdictions.map((j) => ({ code: j.code, name: j.name })), result: carbonCostPerFeu({ corridor, factor: sel.state === "resolved" ? sel.factor : null }) };
    });
}
