// The admin kind's test world (ENGINE-UNBLOCK-1 lane C): one cluster of the graph over four tables and four surfaces, each row offering its capture, a stand-in for lane B's assembleClusters, the registration functions the database owns, and a synthesis authored from the cluster.
import type { Cluster } from "@/core/flywheel/clusters";

import { installPropagationRpcs } from "../_support/memdb.ts";
import { ITEM } from "../batches/world.ts";
import { passingReview } from "../batches/world.ts";
import { qaWorld } from "../batches/worlds.ts";

export const CLUSTER = "cluster:mandate-grid:2026-10-26";
export const E = { mandate: "cl:mandate:ccc0000000000001", grid: "cl:node:ccc0000000000002", feedstock: "cl:feedstock:ccc0000000000003", gone: "cl:node:ffffffffffffffff" };
export const CAP = { mandate: "ca000000-0000-4000-8000-000000000001", grid: "ca000000-0000-4000-8000-000000000002", oem: "ca000000-0000-4000-8000-000000000003" };
export const TEXT = {
  mandate: "Operators shall make 50 MW of charging capacity available within 24 months of entry into force on 1 January 2027.",
  grid: "The median grid connection queue is 31 months in the transmission zone.",
  oem: "The first series-production unit is planned for 2029 according to the manufacturer.",
};
export const ROWS = {
  item: { table: "intelligence_items", pk: ITEM },
  grid: { table: "grid_connection_queues", pk: "00000000-0000-4000-8000-0000000000b2" },
  oem: { table: "oem_tech_roadmaps", pk: "00000000-0000-4000-8000-0000000000b1" },
  series: { table: "market_series", pk: "00000000-0000-4000-8000-0000000000b3" },
};
export const ref = (r: { table: string; pk: string }): string => `${r.table}:${r.pk}`;

export const cluster = (): Cluster => ({
  id: CLUSTER, anchor_entity_ids: [E.mandate], surfaces: ["regulations", "operations", "research", "market"], angles: ["mandate_vs_capacity"], axes: ["shared_entity", "threshold"], hops: 1, dropped: { year_only_events: 0, generic_assessments: 0 },
  rows: [
    { ...ROWS.item, surface: "regulations", entity_ids: [E.mandate], date: "2027-01-01", figure: { value: 50, unit: "MW" }, quote_capture_id: CAP.mandate },
    { ...ROWS.grid, surface: "operations", entity_ids: [E.grid], date: null, figure: { value: 31, unit: "months" }, quote_capture_id: CAP.grid },
    { ...ROWS.oem, surface: "research", entity_ids: [E.grid], date: "2029-01-01", figure: null, quote_capture_id: CAP.oem },
    { ...ROWS.series, surface: "market", entity_ids: [E.feedstock], date: null, figure: { value: 4100, unit: "EUR/t" }, quote_capture_id: null },
  ],
});

export function adminWorld(clusters: Cluster[] = [cluster()]) {
  const w = qaWorld();
  installPropagationRpcs(w.db);
  // the inference registration keeps the method id and the claim, as the database function does
  w.db.rpcs.register_inference_record = (a, d) => {
    const id = `e0000000-0000-4000-8000-${String(d.rows("inference_records").length + 1).padStart(12, "0")}`;
    d.rows("inference_records").push({ inference_id: id, subject_id: a.p_subject_id, claim_text: a.p_claim_text, status_token: a.p_status_token, confidence: a.p_confidence, cited_item_ids: a.p_cited_item_ids, method_id: a.p_method_id, computed_by: a.p_computed_by, inputs: a.p_inputs });
    return { data: id };
  };
  w.db.seed("agent_run_searches", [
    { id: CAP.mandate, intelligence_item_id: ITEM, result_url: "https://eur-lex.europa.eu/mandate", result_content: TEXT.mandate, result_index: 90 },
    { id: CAP.grid, intelligence_item_id: null, result_url: "https://tso.example/queue", result_content: TEXT.grid, result_index: 91 },
    { id: CAP.oem, intelligence_item_id: null, result_url: "https://oem.example/roadmap", result_content: TEXT.oem, result_index: 92 },
  ]);
  w.db.seed("entities", Object.values(E).filter((e) => e !== E.gone).map((entity_id) => ({ entity_id, status: "active" })));
  w.db.tables.admin_opportunity_findings = [];
  const deps = { ...w.deps, assembleClusters: async () => ({ clusters, truncated: 0 }) };
  return { ...w, deps };
}

/** A synthesis of the cluster the validator accepts: one pattern, one finding, a signpost, a gap and a connection, with the second reader's all-pass verdicts. */
export function adminEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  const link = (row: { table: string; pk: string }, cap: string, text: string, extra: Record<string, unknown> = {}) => ({ cause: `the ${row.table} row states it`, effect: "the capacity gap follows", row, quote: { capture_id: cap, text }, ...extra });
  const entry = {
    cluster_id: CLUSTER,
    patterns: [{
      ref: "p1", kind: "mandate_vs_capacity", rows_cited: [ROWS.item, ROWS.grid, ROWS.oem], entity_ids: [E.grid],
      reasoning: [
        link(ROWS.item, CAP.mandate, "50 MW of charging capacity available within 24 months", { figure: { value: 50, unit: "MW" }, date: "2027-01-01" }),
        link(ROWS.grid, CAP.grid, "median grid connection queue is 31 months", { figure: { value: 31, unit: "months" } }),
        link(ROWS.oem, CAP.oem, "first series-production unit is planned for 2029", { date: "2029-01-01" }),
      ],
    }],
    findings: [{
      pattern_ref: "p1", lens: "supply_demand_bottleneck", window: "6-18m", title: "A 50 MW charging mandate meets a 31-month grid queue",
      sourced_finding_md: `The mandate requires 50 MW within 24 months [${ref(ROWS.item)}], while the median grid connection takes 31 months [${ref(ROWS.grid)}], and the first series unit is planned for 2029 [${ref(ROWS.oem)}].`,
      inferences: [{ text: "Capacity in the stated window is unlikely to be met through new grid connections alone.", status_token: "HYPOTHESIS", basis: [ref(ROWS.item), ref(ROWS.grid)] }],
      claim_provenance: [{ row: ref(ROWS.grid), span: "median grid connection queue is 31 months" }],
    }],
    tagged_inferences: [{ text: "Vendors with grid-independent storage are positioned to supply the gap.", status_token: "HYPOTHESIS", basis: [ref(ROWS.oem)] }],
    signposts: [{ claim_text: "The 24-month capacity target is missed in at least one member state", observable: "the annual implementation report's count of member states reporting the target met", source_class: "govIntergov", confirms_if: "fewer than all member states report the target met", falsified_if: "every member state reports the target met by the deadline", by: "2028-09-01" }],
    coverage_gaps: [{ missing_input: "the installed charging capacity of the transmission zone at the mandate date", source_class: "govIntergov" }],
    connections: [{ from_entity_id: E.mandate, to_entity_id: E.grid, relation: "competes_for_feedstock", reason_token: "queue_blocks_mandate", quote: { capture_id: CAP.grid, text: "median grid connection queue is 31 months" } }],
    ...over,
  };
  return { ...entry, review: passingReview(entry, "admin-opportunity-findings") };
}
