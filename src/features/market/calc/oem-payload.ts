// Ported from old_repo/src/lib/spec09/oem-payload.mjs (lines 1-70)
// Payload penalty from a PACK-level density only (spec 09 section 5 decision 3), and the TCO crossover refusal (spec 08 section 4: a fitted date is refused).
import { missing } from "@/core/values/label";

/** TCO diesel-parity crossover: a crossover interval with a probability, never a date. No cost-structure inputs or Monte Carlo engine exist at $0, so this refuses and names the inputs a real answer needs. */
export function tcoCrossoverBand() {
  return missing(
    "not forecastable this build: a diesel-parity crossover interval requires ICCT cost-structure inputs plus a Monte Carlo engine over our own electricity/diesel series, neither of which is sourced at $0. " +
      "Required inputs (named, not built here): ICCT TCO cost-structure series per tech_category, a diesel price series, an electricity price series per duty-cycle jurisdiction, and a fitted Monte Carlo model. A fitted point or date is refused rather than guessed.",
  );
}
