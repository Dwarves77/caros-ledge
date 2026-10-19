// Ported from old_repo/src/components/operations/AuxiliaryEnergyPanelView.tsx (lines 1-60)
// Ported from old_repo/src/components/operations/GridQueuePanelView.tsx (lines 1-87)
// The rows the Operations profile's two spec-09 panels draw, and their words: the workspace's auxiliary loads, the grid connection queue rows, a sourced grid intensity, the standing decision horizon.
export interface AuxiliaryEnergyRow {
  profile_id: string;
  load_type: string;
  kw_draw: number;
  duty_cycle: number;
  hours_typical: number;
  setpoint_c: number | null;
  setpoint_rh_pct: number | null;
  grid_intensity_source: string | null;
}
export interface GridQueueRow {
  queue_id: string;
  dso_name: string;
  capacity_band_mw: string | null;
  queue_months_p50: number | null;
  queue_months_p90: number | null;
  as_of: string;
  substation_name: string | null;
  demand_firm_mw: number | null;
  demand_available_mw: number | null;
  demand_constraint: string | null;
  demand_constraint_limiting_factor: string | null;
}
/** A sourced grid intensity for the region the profile is about, in gCO2e per kWh, with whom it is from and when. */
export interface GridIntensity {
  gco2ePerKwh: number;
  sourceName: string | null;
  period: string | null;
}
export const DECISION_HORIZON_MONTHS = 24;
export const AUXILIARY_ENERGY_ASIDE = "energy and emissions of loads that run in place";
/** The horizon is an assumption applied to every operator, and the heading says so with its value. */
export const GRID_QUEUE_ASIDE = `p90 queue months against an assumed ${DECISION_HORIZON_MONTHS}-month planning horizon`;

/** The one-line substation evidence: headroom against the firm demand, and the constraint with its limiting factor. */
export function substationEvidence(row: GridQueueRow): string | null {
  const parts: string[] = [];
  if (row.demand_available_mw != null) parts.push(`${row.demand_available_mw} MW demand headroom${row.demand_firm_mw != null ? ` of ${row.demand_firm_mw} MW firm` : ""}`);
  if (row.demand_constraint != null) parts.push(`constraint ${row.demand_constraint}${row.demand_constraint_limiting_factor ? ` (${row.demand_constraint_limiting_factor})` : ""}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

