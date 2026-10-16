// Ported from old_repo/src/lib/spec09/oem-payload.mjs (lines 1-70)
// Payload penalty from a PACK-level density only (spec 09 section 5 decision 3), and the TCO crossover refusal (spec 08 section 4: a fitted date is refused).
import { labelled, missing } from "@/core/values/label";

export interface PayloadInput {
  dieselPowertrainKg: number;
  usableKwh: number;
  energyDensityWhKg: number;
  densityBasis: string | null | undefined;
  ePowertrainKg: number;
  legalPayloadKg: number;
}
/**
 * delta payload kg = diesel powertrain kg - usable kWh / (Wh/kg / 1000) - e-powertrain kg; delta pct = delta kg / legal payload kg. REFUSES (M) unless the
 * density basis is 'pack': a cell or module density is never scaled up to a synthetic pack estimate (it would flatter the result by roughly 20-30 percent).
 * Always `modelled`; the range is the caller's job (a low/high pair of calls over a density band).
 */
export function computePayloadPenalty(i: PayloadInput) {
  if (i.densityBasis !== "pack") return missing(`density_basis is '${i.densityBasis ?? "null"}', not 'pack': a payload-penalty delta is never computed from a cell or module level density (it would flatter the result by roughly 20-30%).`);
  for (const [name, v] of Object.entries({ dieselPowertrainKg: i.dieselPowertrainKg, usableKwh: i.usableKwh, energyDensityWhKg: i.energyDensityWhKg, ePowertrainKg: i.ePowertrainKg, legalPayloadKg: i.legalPayloadKg })) if (typeof v !== "number" || !Number.isFinite(v)) return missing(`${name} must be a finite number to compute a payload-penalty delta.`);
  if (i.energyDensityWhKg <= 0) return missing("energyDensityWhKg must be > 0.");
  if (i.legalPayloadKg <= 0) return missing("legalPayloadKg must be > 0.");
  const batteryKg = i.usableKwh / (i.energyDensityWhKg / 1000);
  const deltaPayloadKg = i.dieselPowertrainKg - batteryKg - i.ePowertrainKg;
  return labelled(deltaPayloadKg, "modelled", { deltaPayloadPct: deltaPayloadKg / i.legalPayloadKg, batteryKg, densityBasis: i.densityBasis, note: "Negative deltaPayloadKg/deltaPayloadPct means the electrified powertrain displaces cargo capacity." });
}

/** TCO diesel-parity crossover: a crossover interval with a probability, never a date. No cost-structure inputs or Monte Carlo engine exist at $0, so this refuses and names the inputs a real answer needs. */
export function tcoCrossoverBand() {
  return missing(
    "not forecastable this build: a diesel-parity crossover interval requires ICCT cost-structure inputs plus a Monte Carlo engine over our own electricity/diesel series, neither of which is sourced at $0. " +
      "Required inputs (named, not built here): ICCT TCO cost-structure series per tech_category, a diesel price series, an electricity price series per duty-cycle jurisdiction, and a fitted Monte Carlo model. A fitted point or date is refused rather than guessed.",
  );
}
