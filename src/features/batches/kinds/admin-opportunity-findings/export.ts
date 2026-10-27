// New in ENGINE-UNBLOCK-1 lane C (scripts/ci/new-files/engine-unblock-1c.txt), operator rulings 2026-10-26: the admin kind's export reads the GRAPH, not a detector list. Lane B's assembleClusters returns the multi-angle neighbourhoods (rows of the four surfaces tied by a shared entity,
// relation hops, a scope window or a threshold); each is a bundle with its rows' stored values, the verbatim text of each row's capture (capped per row, the cut stated), the angles and the axes that joined it. The current detector patterns attached to a cluster (their
// evidence rows overlap it) ride as one more input, citable by a finding. A cluster already answered by a current finding is not exported, and neither is a cluster waiting on a coverage gap it raised that is still open (the hunt will bring the source). The reader's output
// is stored behind the platform-admin gate. Nothing here gates what the reader sees by a mechanical detector.
import { allRows, rowsByIds, type Db } from "@/core/db";
import { LENSES, WINDOWS } from "@/core/digest/kinds";
import { secondReaderBlock } from "@/core/digest/review";
import { assembleClusters, type Cluster } from "@/core/flywheel/clusters";

import { GAP_CREATED_BY, SOURCE_CLASSES } from "../../kit/writeback";
import type { BatchExport, Obj } from "../../kit/session-batch";

import { ANGLE_DEFINITIONS } from "./angles";
import { clusterOfComputedBy } from "./validate";

export type AssembleClusters = (db: Db, o: { limit: number; minSurfaces?: number; maxRows?: number }) => Promise<{ clusters: Cluster[]; truncated: number }>;
const LENS_DEFINITIONS: Readonly<Record<(typeof LENSES)[number], string>> = {
  supply_demand_bottleneck: "Mandated supply-demand bottlenecks: a locked statutory demand ratchet against physical capacity (feedstock, grid, fleet, port) that cannot meet it on the date.",
  penalty_abatement_crossover: "Penalty versus abatement: where the statutory penalty per tonne crosses or nears the abatement cost of a technology or fuel that is ready (TRL 8 or above).",
  capital_offtake_grant: "Commercial capital, offtake and grant telemetry: filings, offtakes, capex and public grants that show where capital is forced to flow next, months before the market.",
};
const SPENT = new Set(["superseded", "obsolete", "falsified"]);
const DEFAULT_QUOTE_CHARS = 2000;
const DEFAULT_MAX_ROWS = 40;

interface DetectorRow { value_id: string; method_id: string; method_version: string; entity_id: string | null; value: number | null; unit: string | null; lifecycle: string; admissibility: string; inputs: { table?: string; pk?: string }[] | null }

/** SYNTH-FIX-1 B1: the stored claim text and kind of every section_claim_provenance row of the clusters, whether or not the claim quotes a capture (key table:pk). */
export async function claimsOfRows(sb: Db, clusters: readonly Cluster[]): Promise<Map<string, { claim_text: string | null; claim_kind: string | null }>> {
  const ids = [...new Set(clusters.flatMap((c) => c.rows.filter((r) => r.table === "section_claim_provenance").map((r) => r.pk)))];
  return new Map((await rowsByIds<{ id: string; claim_text: string | null; claim_kind: string | null }>(sb, "section_claim_provenance", "id, claim_text, claim_kind", ids, "id", "id")).map((r) => [`section_claim_provenance:${r.id}`, { claim_text: r.claim_text, claim_kind: r.claim_kind }]));
}

export function adminFindingsExporter(sb: Db, now: () => Date, o: { assemble?: AssembleClusters; quoteChars?: number; maxRows?: number } = {}) {
  return async (x: { limit: number; ids?: readonly string[] }): Promise<BatchExport> => {
    try {
      const [cap, quoteChars] = [o.maxRows ?? DEFAULT_MAX_ROWS, o.quoteChars ?? DEFAULT_QUOTE_CHARS];
      const wanted = x.ids?.length ? new Set(x.ids) : null;
      const { clusters, truncated } = await (o.assemble ?? assembleClusters)(sb, { limit: Math.max(x.limit * 4, 60), minSurfaces: 2, maxRows: cap });
      const ours = (await allRows<{ value_id: string; computed_by: string; lifecycle: string; admissibility: string }>(sb, "derived_values", "value_id, computed_by, lifecycle, admissibility", { order: "value_id", where: (q) => q.like("method_id", "pattern_ai_%").is("invalidated_at", null) })).filter((r) => clusterOfComputedBy(r.computed_by) !== null && !SPENT.has(r.lifecycle) && r.admissibility !== "stale");
      const answeredValues = new Set((await allRows<{ pattern_value_id: string }>(sb, "admin_opportunity_findings", "pattern_value_id", { where: (q) => q.is("superseded_by", null) })).map((f) => f.pattern_value_id));
      const answered = new Set(ours.filter((r) => answeredValues.has(r.value_id)).flatMap((r) => clusterOfComputedBy(r.computed_by) ?? []));
      const openGaps = await allRows<{ recommended_actions: unknown }>(sb, "integrity_flags", "recommended_actions", { where: (q) => q.eq("created_by", GAP_CREATED_BY).in("status", ["open", "in_review"]) });
      const waiting = new Set(openGaps.flatMap((f) => (Array.isArray(f.recommended_actions) ? (f.recommended_actions as Obj[]) : []).flatMap((a) => (typeof a.subject === "string" ? [a.subject] : []))));
      const eligible = clusters.filter((c) => (wanted ? wanted.has(c.id) : !answered.has(c.id) && !waiting.has(c.id)));
      const chosen = eligible.slice(0, x.limit);
      const captureIds = [...new Set(chosen.flatMap((c) => c.rows.slice(0, cap).flatMap((r) => r.quote_capture_id ?? [])))];
      const captures = new Map((await rowsByIds<{ id: string; result_content: string | null }>(sb, "agent_run_searches", "id, result_content", captureIds, "id", "id")).map((c) => [c.id, c.result_content ?? ""]));
      const detectors = (await allRows<DetectorRow>(sb, "derived_values", "value_id, method_id, method_version, entity_id, value, unit, lifecycle, admissibility, inputs", { order: "value_id", where: (q) => q.like("method_id", "pattern_%").is("invalidated_at", null) })).filter((r) => !r.method_id.startsWith("pattern_ai_") && !SPENT.has(r.lifecycle) && r.admissibility !== "stale");
      const attachedTo = (c: Cluster): DetectorRow[] => { const keys = new Set(c.rows.map((r) => `${r.table}/${r.pk}`)); return detectors.filter((d) => (d.inputs ?? []).some((i) => keys.has(`${i.table}/${i.pk}`))); };
      const claims = await claimsOfRows(sb, chosen);
      const attachedAny = new Set<string>();
      const items: Obj[] = chosen.map((c) => {
        const text = (id: string | null): string => (id ? (captures.get(id) ?? "") : "");
        const det = attachedTo(c);
        det.forEach((d) => attachedAny.add(d.value_id));
        return {
          cluster_id: c.id, anchor_entity_ids: c.anchor_entity_ids, hops: c.hops, surfaces: c.surfaces, angles: c.angles, axes: c.axes,
          rows: c.rows.slice(0, cap).map((r) => ({ ref: `${r.table}:${r.pk}`, table: r.table, pk: r.pk, surface: r.surface, entity_ids: r.entity_ids, date: r.date, figure: r.figure, quote_capture_id: r.quote_capture_id, quote_text: text(r.quote_capture_id).slice(0, quoteChars), quote_chars_total: text(r.quote_capture_id).length, quote_truncated: text(r.quote_capture_id).length > quoteChars, ...(claims.get(`${r.table}:${r.pk}`) ?? {}) })),
          truncation: { rows_total: c.rows.length, rows_omitted: Math.max(0, c.rows.length - cap), quote_chars_per_row: quoteChars, dropped_year_only_target_events: c.dropped.year_only_events, dropped_research_assessments_without_a_0_hop_entity: c.dropped.generic_assessments },
          detector_patterns: det.map((d) => ({ pattern_value_id: d.value_id, method_id: d.method_id, method_version: d.method_version, entity_id: d.entity_id, value: d.value, unit: d.unit, lifecycle: d.lifecycle, admissibility: d.admissibility, evidence_rows: (d.inputs ?? []).map((i) => `${i.table}:${i.pk}`) })),
        };
      });
      const rowsCut = items.reduce((n, b) => n + ((b.truncation as { rows_omitted: number }).rows_omitted), 0);
      return {
        ok: true, items, source: { type: "table", table: "derived_values" },
        summary: { second_reader: secondReaderBlock("admin-opportunity-findings"), generated_at: now().toISOString(), clusters_assembled: clusters.length, clusters_cut_by_the_assembler: truncated, already_answered: clusters.filter((c) => answered.has(c.id)).length, awaiting_a_coverage_gap: clusters.filter((c) => waiting.has(c.id) && !answered.has(c.id)).length, eligible: eligible.length, exported: items.length, rows_omitted_in_bundles: rowsCut, detector_patterns_attached: attachedAny.size, detector_patterns_unattached: detectors.length - attachedAny.size, lens_definitions: LENS_DEFINITIONS, angle_definitions: ANGLE_DEFINITIONS, windows: WINDOWS, source_classes: SOURCE_CLASSES, authoring: "docs/authoring/admin-opportunity-findings.md" },
        residue: wanted ? [...wanted].filter((id) => !chosen.some((c) => c.id === id)).map((id) => ({ cluster_id: id, reason: "no cluster of this id assembles now" })) : [],
      };
    } catch (e) {
      return { ok: false, items: [], error: (e as Error).message };
    }
  };
}
