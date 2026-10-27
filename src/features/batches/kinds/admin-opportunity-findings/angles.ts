// New in ENGINE-UNBLOCK-1 lane C (scripts/ci/new-files/engine-unblock-1c.txt): the six angles a graph neighbourhood is read from (lane B's Angle type) as the pattern kinds the reader emits, and what each angle asks. The definitions are shown to the reader in the export; they are not matched against any text.
import type { Angle } from "@/core/flywheel/clusters";

export const ANGLES = ["mandate_vs_capacity", "penalty_vs_abatement", "cross_modal_competition", "regulatory_stacking", "lead_lag", "maturity_vs_statute"] as const satisfies readonly Angle[];
export const ANGLE_DEFINITIONS: Readonly<Record<Angle, string>> = {
  mandate_vs_capacity: "A statutory demand ratchet against physical capacity (feedstock, grid, fleet, port) that cannot meet it on the date.",
  penalty_vs_abatement: "The statutory penalty or price per unit set against the abatement cost of a technology or fuel that is ready.",
  cross_modal_competition: "Two modes or sectors drawing on the same scarce feedstock, grid zone or corridor.",
  regulatory_stacking: "Several instruments binding the same duty holder, asset or movement, whose obligations compound or conflict.",
  lead_lag: "A signal on one surface that has historically preceded a change on another (capital, filings, offtakes before statute or price).",
  maturity_vs_statute: "The technology readiness of what a statute assumes against the date the statute binds.",
};
