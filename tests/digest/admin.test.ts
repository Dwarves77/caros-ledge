// The admin kind over CLUSTERS (ENGINE-UNBLOCK-1 lane C): the export reads the graph, the apply verifies every cited row, entity, figure, date and quote against the stored records and refuses a failing element by name, and a valid synthesis stores a pattern row, a finding,
// its signposts, a queued coverage gap and a connection. INV-DIG-7 (a single table or surface is residue), the second reader's gate, supersession and the hunt (a gap is queued for needs-search, never fetched) are attacked here. INV-DIG-8's database half is migration 0122's self-check.
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyBatch, drainExporters } from "@/features/batches";
import type { BatchExport } from "@/features/batches";
import { needsExporter } from "@/features/batches/kinds/needs-search/needs";

import { batchFile } from "../batches/world.ts";

import { adminEntry, adminWorld, CAP, CLUSTER, cluster, E, ref, ROWS } from "./admin-world.ts";

const apply = (w: ReturnType<typeof adminWorld>, entries: unknown[], dry = false) => applyBatch("admin-opportunity-findings", w.deps, { content: JSON.stringify(batchFile("admin-opportunity-findings", entries)), dry, runId: "a1" });
const notes = (r: { notes: string[] }) => r.notes.join("\n");
const exportIt = async (w: ReturnType<typeof adminWorld>, ids?: string[]) => (await drainExporters(w.deps)["admin-opportunity-findings"]!({ limit: 5, mode: "pending", ...(ids ? { ids } : {}) })) as BatchExport;
const patterns = (w: ReturnType<typeof adminWorld>) => w.db.rows("derived_values").filter((v) => String(v.method_id).startsWith("pattern_ai_"));
const nothingWritten = (w: ReturnType<typeof adminWorld>) => assert.deepEqual([patterns(w).length, w.db.rows("admin_opportunity_findings").length, w.db.rows("inference_records").length, w.db.rows("integrity_flags").filter((f) => f.created_by === "holdings-need:synthesis-gap").length, w.db.rows("entity_relations").length], [0, 0, 0, 0, 0]);

test("a valid synthesis of a cluster stores one pattern row and one finding, with its signpost, tagged inference, queued gap and connection; a re-apply writes nothing new", async () => {
  const w = adminWorld();
  assert.equal((await apply(w, [adminEntry()], true)).counts.valid, 1);
  nothingWritten(w);
  const r = await apply(w, [adminEntry()]);
  assert.equal(r.counts.applied, 1, notes(r));
  const [p] = patterns(w);
  assert.deepEqual([patterns(w).length, p?.method_id, p?.method_version, p?.lifecycle, String(p?.computed_by).startsWith(`reader-synthesis:${CLUSTER}:mandate_vs_capacity:`)], [1, "pattern_ai_mandate_vs_capacity", "reader-synthesis@1.0.0", "emerging", true]);
  const inputs = p?.inputs as { table: string; pk: string; kind: string; basis: { links: { quote: { capture_id: string } }[] } }[];
  assert.deepEqual(inputs.map((i) => [i.table, i.kind]).sort(), [["grid_connection_queues", "evidence"], ["intelligence_items", "evidence"], ["oem_tech_roadmaps", "evidence"]], "the cited rows are the evidence edges");
  assert.ok(inputs.every((i) => i.basis.links.length === 1 && i.basis.links[0]?.quote.capture_id), "each carries its reasoning link and quote");
  const f = w.db.rows("admin_opportunity_findings")[0] as Record<string, unknown>;
  assert.deepEqual([w.db.rows("admin_opportunity_findings").length, f.pattern_value_id, f.lens, f.window, (f.signpost_inference_ids as string[]).length, f.superseded_by ?? null], [1, p?.value_id, "supply_demand_bottleneck", "6-18m", 1, null]);
  assert.equal(w.db.rows("inference_records").length, 2, "the signpost and the tagged inference");
  assert.match(String(w.db.rows("inference_records").find((i) => i.method_id === "admin-opportunity-findings-signpost")?.claim_text), /source class: govIntergov; confirmed if: fewer than all.*falsified if: every member state/);
  assert.equal(w.db.rows("brief_reviews").filter((b) => b.kind === "admin-opportunity-findings").length, 1);
  assert.equal(w.db.rows("entity_relations").length, 1, "the connection went through the emission writer");
  const again = await apply(w, [adminEntry()]);
  assert.equal(again.counts.already_applied, 1, notes(again));
  assert.deepEqual([patterns(w).length, w.db.rows("admin_opportunity_findings").length, w.db.rows("inference_records").length, w.db.rows("entity_relations").length], [1, 1, 2, 1]);
});

test("a fabricated pk is refused by name, and nothing of the entry is written", async () => {
  const w = adminWorld();
  const fake = { table: "grid_connection_queues", pk: "00000000-0000-4000-8000-0000000fffff" };
  const bad = adminEntry();
  const p = (bad.patterns as { rows_cited: unknown[] }[])[0]!;
  p.rows_cited = [...p.rows_cited, fake];
  assert.match(notes(await apply(w, [bad])), new RegExp(`${fake.table}:${fake.pk} is not a row of the cluster`));
  assert.match(notes(await apply(w, [adminEntry({ findings: [{ ...(adminEntry().findings as object[])[0], sourced_finding_md: `The queue [${ref(fake)}] and the mandate [${ref(ROWS.item)}].` }] })])), new RegExp(`cites ${fake.table}:${fake.pk}, which is not a row of the cluster`));
  assert.match(notes(await apply(w, [adminEntry({ tagged_inferences: [{ text: "x", status_token: "HYPOTHESIS", basis: [ref(fake)] }] })])), /basis .* is not a row of the cluster/);
  nothingWritten(w);
});

test("a wrong figure and a wrong date are each refused by name against the stored value", async () => {
  const w = adminWorld();
  const mutate = (k: "figure" | "date", v: unknown) => { const e = adminEntry(); ((e.patterns as { reasoning: Record<string, unknown>[] }[])[0]!.reasoning[0] as Record<string, unknown>)[k] = v; return e; };
  assert.match(notes(await apply(w, [mutate("figure", { value: 55, unit: "MW" })])), /reasoning\[0\]: figure \{"value":55,"unit":"MW"\} differs from the stored value of intelligence_items:.* \(\{"value":50,"unit":"MW"\}\)/);
  assert.match(notes(await apply(w, [mutate("figure", { value: 50, unit: "GW" })])), /figure .* differs from the stored value/);
  assert.match(notes(await apply(w, [mutate("date", "2027-02-01")])), /reasoning\[0\]: date "2027-02-01" differs from the stored date of intelligence_items:.* \("2027-01-01"\)/);
  const noFigure = adminEntry();
  ((noFigure.patterns as { reasoning: Record<string, unknown>[] }[])[0]!.reasoning[2] as Record<string, unknown>).figure = { value: 1, unit: "x" };
  assert.match(notes(await apply(w, [noFigure])), /reasoning\[2\]: figure .* differs from the stored value of oem_tech_roadmaps:.* \(null\)/, "a figure on a row that stores none is refused");
  nothingWritten(w);
});

test("a quote that is not verbatim in the capture is refused by name; so is a quote from another row's capture and a provenance span the row does not offer", async () => {
  const w = adminWorld();
  const quote = (text: string, capture_id = CAP.grid) => { const e = adminEntry(); ((e.patterns as { reasoning: { quote: unknown }[] }[])[0]!.reasoning[1]!).quote = { capture_id, text }; return e; };
  assert.match(notes(await apply(w, [quote("median grid connection queue is 29 months")])), new RegExp(`reasoning\\[1\\]\\.quote: the quote is not verbatim in capture ${CAP.grid}`));
  assert.match(notes(await apply(w, [quote("median grid connection queue is 31 months", CAP.oem)])), new RegExp(`capture ${CAP.oem} is not the capture of grid_connection_queues`));
  assert.match(notes(await apply(w, [adminEntry({ findings: [{ ...(adminEntry().findings as object[])[0], claim_provenance: [{ row: ref(ROWS.grid), span: "median grid connection queue is 29 months" }] }] })])), /claim_provenance\[0\]: the quote is not verbatim in capture/);
  const conn = adminEntry({ connections: [{ from_entity_id: E.mandate, to_entity_id: E.grid, relation: "competes_for_feedstock", reason_token: "queue_blocks_mandate", quote: { capture_id: CAP.grid, text: "the queue is 29 months" } }] });
  assert.match(notes(await apply(w, [conn])), /connections\[0\]\.quote: the quote is not in capture/);
  nothingWritten(w);
});

test("an entity id that does not exist, a link without cause and effect, a cited row no link quotes, a past signpost date and an unknown source class are each refused by name", async () => {
  const w = adminWorld();
  assert.match(notes(await apply(w, [adminEntry({ connections: [{ from_entity_id: E.gone, to_entity_id: E.grid, relation: "competes_for_feedstock", reason_token: "queue_blocks_mandate", quote: { capture_id: CAP.grid, text: "median grid connection queue is 31 months" } }] })])), new RegExp(`connections\\[0\\].from_entity_id: entity id "${E.gone}" does not exist`));
  const own = adminEntry();
  ((own.patterns as { entity_ids: string[] }[])[0]!).entity_ids = [E.gone];
  assert.match(notes(await apply(w, [own])), /patterns\[0\]\.entity_ids\[0\]: entity id .* does not exist/);
  const noEffect = adminEntry();
  delete ((noEffect.patterns as { reasoning: Record<string, unknown>[] }[])[0]!.reasoning[0] as Record<string, unknown>).effect;
  assert.match(notes(await apply(w, [noEffect])), /reasoning\[0\]: must be \{ cause, effect, row/);
  const unquoted = adminEntry();
  (unquoted.patterns as { reasoning: unknown[] }[])[0]!.reasoning.pop();
  assert.match(notes(await apply(w, [unquoted])), /oem_tech_roadmaps:.* is cited but no reasoning link quotes it/);
  const sp = (over: Record<string, unknown>) => adminEntry({ signposts: [{ ...(adminEntry().signposts as object[])[0], ...over }] });
  assert.match(notes(await apply(w, [sp({ by: "2026-01-01" })])), /signposts\[0\]: by 2026-01-01 is not in the future/);
  assert.match(notes(await apply(w, [sp({ source_class: "blogs" })])), /signposts\[0\]: source_class "blogs" is not an institution class/);
  assert.match(notes(await apply(w, [adminEntry({ signposts: [] })])), /signposts: a pattern or a finding carries at least one signpost/);
  assert.match(notes(await apply(w, [adminEntry({ coverage_gaps: [{ missing_input: "x", source_class: "nonsense" }] })])), /coverage_gaps\[0\]: source_class "nonsense"/);
  assert.match(notes(await apply(w, [adminEntry({ patterns: [{ ...(adminEntry().patterns as object[])[0], kind: "guess" }] })])), /patterns\[0\]: must be \{ ref, kind/);
  assert.match(notes(await apply(adminWorld([]), [adminEntry()])), /this cluster does not assemble from the stored records now/);
  nothingWritten(w);
});

test("INV-DIG-7: a synthesis that cites rows from a single table, or a single surface, is residue with the reason, and nothing is written", async () => {
  const w = adminWorld();
  const one = adminEntry({ patterns: [{ ...(adminEntry().patterns as { reasoning: unknown[] }[])[0]!, rows_cited: [ROWS.grid], reasoning: [(adminEntry().patterns as { reasoning: unknown[] }[])[0]!.reasoning[1]] }], findings: [{ ...(adminEntry().findings as object[])[0], sourced_finding_md: `The queue is long [${ref(ROWS.grid)}].`, inferences: [], claim_provenance: [] }], tagged_inferences: [] });
  assert.match(notes(await apply(w, [one])), /every cited row is from grid_connection_queues table, at least two tables are required/);
  nothingWritten(w);
});

test("the second reader gates the synthesis: a missing verdict set, a failed judge and a verdict with no evidence each keep it out and name the criterion", async () => {
  const w = adminWorld();
  const noReview = { ...adminEntry() } as Record<string, unknown>;
  delete noReview.review;
  assert.match(notes(await apply(w, [noReview])), /second reader.*verdicts are missing/);
  const ok = adminEntry();
  const judges = (ok.review as { judges: Record<string, { pass: boolean; evidence: string }> }).judges;
  const failing = (id: string, v: { pass: boolean; evidence: string }) => ({ ...ok, review: { ...(ok.review as object), judges: { ...judges, [id]: v } } });
  assert.match(notes(await apply(w, [failing("J23", { pass: false, evidence: "the grid row alone states the direction" })])), /J23 cross-surface-direction: failed/);
  assert.match(notes(await apply(w, [failing("J05", { pass: true, evidence: "" })])), /J05 cause-effect-sourced: a verdict without its evidence/);
  assert.deepEqual(Object.keys(judges).sort(), ["J04", "J05", "J06", "J07", "J08", "J12", "J15", "J16", "J17", "J23", "J24"], "the proposed judges J25 and J26 are not required of any entry");
  nothingWritten(w);
});

test("a re-authored synthesis supersedes the pattern and the finding it replaces: one current finding per pattern", async () => {
  const w = adminWorld();
  await apply(w, [adminEntry()]);
  const again = await apply(w, [adminEntry({ findings: [{ ...(adminEntry().findings as object[])[0], title: "A 50 MW charging mandate meets a 31-month queue, restated" }] })]);
  assert.equal(again.counts.applied, 1, notes(again));
  assert.equal(w.db.rows("admin_opportunity_findings").length, 2);
  assert.equal(w.db.rows("admin_opportunity_findings").filter((x) => !x.superseded_by).length, 1);
  assert.equal(patterns(w).length, 1, "the same reading is the same pattern row");
  const reread = adminEntry();
  ((reread.patterns as { reasoning: { cause: string }[] }[])[0]!.reasoning[0]!).cause = "the statute fixes the date";
  const third = await apply(w, [{ ...reread, findings: [{ ...(adminEntry().findings as object[])[0], title: "Read again with a different cause" }] }]);
  assert.equal(third.counts.applied, 1, notes(third));
  assert.deepEqual(patterns(w).map((p) => p.lifecycle).sort(), ["emerging", "superseded"]);
  assert.equal(w.db.rows("admin_opportunity_findings").filter((x) => !x.superseded_by).length, 1, "the finding of the replaced pattern is superseded too");
});

test("HUNT: a coverage gap is queued once as a find-source need that needs-search exports, carries its source class and raiser, and nothing is fetched", async () => {
  const w = adminWorld();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("a network call was attempted"); }) as never;
  try {
    const r = await apply(w, [adminEntry({ patterns: [], findings: [], tagged_inferences: [], signposts: [], connections: [] })]);
    assert.equal(r.counts.applied, 1, notes(r));
  } finally { globalThis.fetch = realFetch; }
  const flags = w.db.rows("integrity_flags").filter((f) => f.created_by === "holdings-need:synthesis-gap");
  assert.equal(flags.length, 1);
  const action = (flags[0]?.recommended_actions as Record<string, unknown>[])[0]!;
  assert.deepEqual([flags[0]?.status, flags[0]?.category, action.action, action.need, action.source_class, action.subject, action.raised_by], ["open", "coverage_gap", "find-source", "the installed charging capacity of the transmission zone at the mandate date", "govIntergov", CLUSTER, "admin-opportunity-findings"]);
  assert.deepEqual([w.db.rows("census_worklist").length, w.db.rows("sources").length, w.db.rows("portal_link_candidates").length], [w.db.rows("census_worklist").length, w.db.rows("sources").length, 0], "no source was registered, no fetch queued");
  const needs = (await needsExporter(w.db.client)({ limit: 50 })) as BatchExport;
  assert.ok((needs.items as { kind: string; text: string }[]).some((n) => n.kind === "holdings-need" && n.text.includes("installed charging capacity")), "the hunt reads the gap as a need");
  // the same gap from the same entry again, and from a second raiser, is one row
  await apply(w, [{ ...adminEntry({ patterns: [], findings: [], tagged_inferences: [], signposts: [], connections: [] }) }]);
  assert.equal(w.db.rows("integrity_flags").filter((f) => f.created_by === "holdings-need:synthesis-gap").length, 1, "deduplicated");
  // while its gap is open the cluster is not exported again
  const out = await exportIt(w);
  assert.equal((out.summary as { awaiting_a_coverage_gap: number }).awaiting_a_coverage_gap, 1);
  assert.equal(out.items.length, 0);
});

test("the export: a cluster bundle carries rows with stored values, the capture text with the cut stated, the angles, the axes and the attached detector pattern; an answered cluster is excluded", async () => {
  const w = adminWorld();
  w.db.seed("derived_values", [{ value_id: "d1000000-0000-4000-8000-0000000000a1", method_id: "pattern_mandate_capacity", method_version: "1.0.0", entity_id: "e1", value: 0.7, unit: "ratio", derivation: "calculated", origin_class: "derived", lifecycle: "emerging", admissibility: "analysis_ok", base_confidence: 0.7, asserted_at: "2026-10-20T00:00:00.000Z", inputs: [{ table: ROWS.grid.table, pk: ROWS.grid.pk, kind: "member" }], computed_by: "t", invalidated_at: null }]);
  const out = await exportIt(w);
  assert.equal(out.ok, true, out.error);
  const b = out.items[0] as { cluster_id: string; axes: string[]; angles: string[]; hops: number; rows: { ref: string; quote_text: string; quote_truncated: boolean; figure: unknown; date: string | null }[]; detector_patterns: { method_id: string }[]; truncation: { rows_omitted: number } };
  assert.deepEqual([b.cluster_id, b.axes, b.angles, b.hops, b.rows.length, b.truncation.rows_omitted, b.detector_patterns.map((d) => d.method_id)], [CLUSTER, ["shared_entity", "threshold"], ["mandate_vs_capacity"], 1, 4, 0, ["pattern_mandate_capacity"]]);
  assert.equal(b.rows.find((r) => r.ref === ref(ROWS.grid))?.quote_text.includes("31 months"), true);
  assert.deepEqual(b.rows.find((r) => r.ref === ref(ROWS.item))?.figure, { value: 50, unit: "MW" });
  assert.equal((out.summary as { detector_patterns_attached: number }).detector_patterns_attached, 1);
  const cut = (await drainExporters(w.deps)["admin-opportunity-findings"]!({ limit: 5, mode: "pending" })) as BatchExport;
  assert.equal(cut.ok, true);
  await apply(w, [adminEntry()]);
  const after = await exportIt(w);
  assert.equal(after.items.length, 0, "a cluster answered by a current finding is excluded");
  assert.equal((after.summary as { already_answered: number }).already_answered, 1);
  assert.equal((await exportIt(w, [CLUSTER])).items.length, 1, "named by id it is exported again");
});

test("the export states every cut: rows over the cap are counted, a long capture is cut and says so", async () => {
  const w = adminWorld();
  const big = cluster();
  const out = (await drainExporters({ ...w.deps, assembleClusters: async () => ({ clusters: [big], truncated: 3 }) })["admin-opportunity-findings"]!({ limit: 5, mode: "pending" })) as BatchExport;
  const s = out.summary as { clusters_cut_by_the_assembler: number };
  assert.equal(s.clusters_cut_by_the_assembler, 3);
  const w2 = adminWorld();
  w2.db.rows("agent_run_searches").find((r) => r.id === CAP.grid)!.result_content = `${"x".repeat(2500)} ${"median grid connection queue is 31 months"}`;
  const out2 = await exportIt(w2);
  const row = (out2.items[0] as { rows: { ref: string; quote_text: string; quote_truncated: boolean; quote_chars_total: number }[] }).rows.find((r) => r.ref === ref(ROWS.grid))!;
  assert.deepEqual([row.quote_text.length, row.quote_truncated, row.quote_chars_total > 2000], [2000, true, true]);
});

test("LOCK-NO-BLOAT-1: a gaps-only entry is reviewed like any other: a missing or failing verdict set is residue, a passing one is valid", async () => {
  const w = adminWorld();
  const gaps = { patterns: [], findings: [], tagged_inferences: [], connections: [], signposts: [] };
  const bare = { ...adminEntry(gaps) } as Record<string, unknown>;
  delete bare.review;
  assert.match(notes(await apply(w, [bare])), /second reader.*verdicts are missing/);
  assert.equal((await apply(w, [adminEntry(gaps)], true)).counts.valid, 1, "the passing twin stays valid");
  nothingWritten(w);
});

test("LOCK-NO-BLOAT-1: a signpost's figure is held to the cited rows even when the entry has no pattern or finding", async () => {
  const w = adminWorld();
  const sign = (text: string) => adminEntry({ patterns: [], findings: [], tagged_inferences: [], connections: [], signposts: [{ claim_text: text, observable: "the published index", source_class: "govIntergov", confirms_if: "it rises", falsified_if: "it falls", by: "2028-09-01" }], coverage_gaps: [{ missing_input: "the feedstock series", source_class: "govIntergov" }] });
  assert.match(notes(await apply(w, [sign("The price passes 9999 EUR/t")])), /grounding pre-check: figure .*9999/);
  assert.equal((await apply(w, [sign("The price stays near the stated level")], true)).counts.valid, 1, "a signpost without a figure stays valid");
});
