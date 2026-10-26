// The admin kind's test world: one derived pattern, its packet (member rows across four tables and three surfaces, each offering its verbatim text), the registration function the database owns, and a finding authored from the packet.
import type { Packet } from "@/core/digest/packets-client";

import { passingReview } from "../batches/world.ts";
import { qaWorld } from "../batches/worlds.ts";

export const PATTERN = "d1000000-0000-4000-8000-0000000000a1";
const ROW_A = "cl:obligation:aaaaaaaaaaaaaaaa";
export const ROWS = {
  mandate: `obligation_objects:${ROW_A}`,
  oem: "oem_tech_roadmaps:00000000-0000-4000-8000-0000000000b1",
  grid: "grid_connection_queues:00000000-0000-4000-8000-0000000000b2",
  series: "market_series:00000000-0000-4000-8000-0000000000b3",
};
export const TEXT = {
  mandate: "Operators shall make 50 MW of charging capacity available within 24 months.",
  oem: "The first series-production unit is planned for 2029.",
  grid: "The median grid connection queue is 31 months.",
};
const member = (key: keyof typeof ROWS, surface: string, text: string | null, item: string | null) => {
  const [table, id] = ROWS[key].split(/:(.*)/s) as [string, string];
  return { table, id, text, surface, item_id: item };
};

export const packet = (): Packet => ({
  kind: "pattern",
  id: PATTERN,
  members: [member("mandate", "regulations", TEXT.mandate, "a0000000-0000-4000-8000-000000000001"), member("oem", "research", TEXT.oem, null), member("grid", "operations", TEXT.grid, null), member("series", "market", "EUR 4,100 per tonne", null)],
});

export function adminWorld(packets: Packet[] = [packet()]) {
  const w = qaWorld();
  w.db.seed("derived_values", [{ value_id: PATTERN, method_id: "pattern_mandate_capacity", method_version: "1.0.0", entity_id: "e1", derivation: "calculated", origin_class: "derived", lifecycle: "emerging", admissibility: "analysis_ok", base_confidence: 0.7, asserted_at: "2026-10-10T00:00:00.000Z", invalidated_at: null }]);
  w.db.tables.admin_opportunity_findings = [];
  const deps = { ...w.deps, packets: async (ids: readonly string[]) => ({ packets: packets.filter((p) => ids.includes(p.id)), marker: null }) };
  return { ...w, deps };
}

export function adminEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  const entry = {
    pattern_value_id: PATTERN, lens: "supply_demand_bottleneck", window: "6-18m", title: "A 50 MW charging mandate meets a 31-month grid queue",
    sourced_finding_md: `The mandate requires 50 MW of charging capacity within 24 months [${ROWS.mandate}], while the median grid connection takes 31 months [${ROWS.grid}], and the first series unit is planned for 2029 [${ROWS.oem}].`,
    inferences: [{ text: "Capacity in the stated window is unlikely to be met through new grid connections alone.", status_token: "HYPOTHESIS", basis: [ROWS.mandate, ROWS.grid] }],
    signposts: [{ claim_text: "A Member State reports its 24-month capacity target met", falsification_condition: "a published report showing the target met inside the window", by: "2027-09-01" }],
    claim_provenance: [{ row: ROWS.grid, span: "median grid connection queue is 31 months" }],
    ...over,
  };
  return { ...entry, review: passingReview(entry, "admin-opportunity-findings") };
}
