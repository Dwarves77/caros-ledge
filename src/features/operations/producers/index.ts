// Barrel: every operations producer spec and parser by name (new in P2-07). Each spec is run by the one runner in @/core/producers.
export { nesoCarbonIntensity, parseNesoStats } from "./neso-carbon-intensity";
export { auxiliaryEnergyRows, indexationRows } from "./operator-rows";
export { blsOews, eurostatElectricity, eurostatLabourCost } from "./regional-envelope";
export { stateCostFacts } from "./state-cost-facts";
export { mapHeatmapFile, ukpnHeatmap } from "./ukpn-heatmap";
