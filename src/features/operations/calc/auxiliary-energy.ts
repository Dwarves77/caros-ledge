// Ported from old_repo/src/lib/spec09/auxiliary-energy.mjs (lines 1-52)
// Stationary auxiliary load: kWh, then gCO2e against a SOURCED grid intensity (never assumed), then the ratio to the transport leg it accompanies.
import { labelled, missing } from "@/core/values/label";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** kWh consumed over the load's typical duration: kwDraw x dutyCycle x hoursTypical. */
export function computeEnergyConsumedKwh({ kwDraw, dutyCycle, hoursTypical }: { kwDraw: number; dutyCycle: number; hoursTypical: number }) {
  for (const [name, v] of Object.entries({ kwDraw, dutyCycle, hoursTypical })) if (!finite(v)) return missing(`${name} must be a finite number.`);
  if (kwDraw < 0 || hoursTypical < 0) return missing("kwDraw and hoursTypical must be non-negative.");
  if (dutyCycle < 0 || dutyCycle > 1) return missing("dutyCycle must be between 0 and 1.");
  return labelled(kwDraw * dutyCycle * hoursTypical, "calculated");
}

/** kWh to gCO2e at a grid intensity in gCO2e/kWh. A separate step: the load is the profile's own, the intensity is an external dated series; without one this step is M while the kWh stands. */
export function convertKwhToGco2e({ energyKwh, gridIntensityGco2ePerKwh }: { energyKwh: number; gridIntensityGco2ePerKwh: number | null | undefined }) {
  if (!finite(energyKwh)) return missing("energyKwh must be a finite number (from computeEnergyConsumedKwh).");
  if (!finite(gridIntensityGco2ePerKwh)) return missing("no grid intensity value available for this node: cannot convert kWh to gCO2e without one (never assumed).");
  return labelled(energyKwh * gridIntensityGco2ePerKwh, "calculated");
}

/** The honest ratio of the auxiliary footprint to the leg's own emissions; a missing side is M, never a silent zero. */
export function compareToLegEmissions({ auxiliaryGco2e, legGco2e }: { auxiliaryGco2e: number; legGco2e: number | null | undefined }) {
  if (!finite(auxiliaryGco2e)) return missing("auxiliaryGco2e is required to compare against the leg's own emissions.");
  if (!finite(legGco2e) || legGco2e <= 0) return missing("legGco2e (the transport leg's own emissions) is required and must be > 0 for a ratio.");
  const ratio = auxiliaryGco2e / legGco2e;
  return labelled(ratio, "calculated", { exceedsLeg: ratio > 1, note: ratio > 1 ? "the stationary auxiliary load's own footprint exceeds the transport leg's." : null });
}

/** The three steps in order; each later step is M when its own input is missing, and the earlier figures still stand. */
export function auxiliaryEnergy(i: { kwDraw: number; dutyCycle: number; hoursTypical: number; gridIntensityGco2ePerKwh?: number | null; legGco2e?: number | null }) {
  const kwh = computeEnergyConsumedKwh(i);
  const gco2e = kwh.label === "M" ? kwh : convertKwhToGco2e({ energyKwh: kwh.value as number, gridIntensityGco2ePerKwh: i.gridIntensityGco2ePerKwh });
  const ratio = gco2e.label === "M" ? gco2e : compareToLegEmissions({ auxiliaryGco2e: gco2e.value as number, legGco2e: i.legGco2e });
  return { kwh, gco2e, ratio };
}
