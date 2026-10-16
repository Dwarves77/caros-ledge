// Ported from old_repo/src/lib/spec09/reroute.mjs (lines 1-32)
// Reroute arithmetic: a pure multiplication, and the five-surface compounding chain as a describable structure (not a computation).
import { labelled, missing } from "@/core/values/label";

/** Scale a baseline fuel-burn figure by a reroute's fuel_burn_multiplier. The only arithmetic this module performs. */
export function applyFuelBurnMultiplier({ baselineFuelBurn, fuelBurnMultiplier }: { baselineFuelBurn: number; fuelBurnMultiplier: number }) {
  if (typeof baselineFuelBurn !== "number" || !Number.isFinite(baselineFuelBurn) || baselineFuelBurn < 0) return missing("baselineFuelBurn must be a non-negative finite number.");
  if (typeof fuelBurnMultiplier !== "number" || !Number.isFinite(fuelBurnMultiplier) || fuelBurnMultiplier <= 0) return missing("fuelBurnMultiplier must be a positive finite number.");
  return labelled(baselineFuelBurn * fuelBurnMultiplier, "calculated", { fuelBurnMultiplier, deltaPct: (fuelBurnMultiplier - 1) * 100 });
}

export interface ChainStep {
  step: string;
  detail: string;
  computedHere: boolean;
  note?: string;
}
/** What moves when a corridor reroutes, in order, and why each downstream step is not computed here (bracketed penalties are not linear). */
export function compoundingChain(): readonly ChainStep[] {
  return Object.freeze([
    { step: "reroute", detail: "reroute → higher fuel burn", computedHere: true },
    { step: "intensity", detail: "higher fuel burn → higher GHG intensity", computedHere: false, note: "downstream of applyFuelBurnMultiplier()'s output; not computed by this module" },
    { step: "fueleu", detail: "FuelEU compliance balance worsens → penalty crosses into a higher bracket", computedHere: false, note: "bracketed, not linear: belongs to the statutory computations domain" },
    { step: "ets", detail: "EU ETS allowance cost rises → the corridor's carbon-per-FEU moves", computedHere: false },
    { step: "indexation", detail: "the forwarder's indexation clause triggers", computedHere: false, note: "see indexation.ts" },
    { step: "scope3", detail: "the customer's Scope 3 figure changes", computedHere: false },
  ]);
}
