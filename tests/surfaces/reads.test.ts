// P2-12 readers (INV-263): a failed read is a failed state beside what did load, never an empty list, a zero or "none yet"; the facts carry their source's rating and a derived freshness; the recalculated figures are current rows
// with their inputs named, dated and rated; the history chain says when it is shorter than the real one; the raw assessments table is not a customer read.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { readOperationsPage, readDerivedFigures, readFacts, readMatrixEligibility, readRoster, type OperationsRegion } from "@/features/operations/read/operations-reads";
import { relatedItems } from "@/features/research/read/related-items";
import { readAssessmentBundle, readAssessmentsFor, readResearchPage } from "@/features/research/read/research-reads";

import { memoryDb, type Row } from "../_support/memory-db.ts";

const NOW = "2026-10-15T12:00:00.000Z";
type RpcReply = { data?: unknown; error?: { message: string } | null } | undefined;
/** The memory database with the listing rpcs the shared list read calls: an rpc answers like PostgREST (awaitable, and rangeable for the paged category read). */
function world(tables: Record<string, Row[]>, rpc: (name: string) => RpcReply, failures: Parameters<typeof memoryDb>[1] extends infer O ? (O extends { failures?: infer F } ? F : never) : never = []) {
  const m = memoryDb(tables, { failures });
  (m.db as unknown as { rpc: unknown }).rpc = (name: string) => {
    const run = Promise.resolve({ data: null, error: null, ...(rpc(name) ?? {}) });
    return Object.assign(run, { range: () => run });
  };
  return m.db;
}
const U1 = "a0000000-0000-4000-8000-000000000001";
const U2 = "a0000000-0000-4000-8000-000000000002";
const R_EU = "e0000000-0000-4000-8000-000000000001";
const R_US = "e0000000-0000-4000-8000-000000000002";
const SRC = "b0000000-0000-4000-8000-000000000001";
const regions: Row[] = [{ id: R_EU, code: "EU", label: "European Union", display_order: 1, iso_codes: ["DE", "FR"] }, { id: R_US, code: "US", label: "United States", display_order: 2, iso_codes: ["US-CA"] }];
const roster: OperationsRegion[] = [{ id: R_EU, code: "EU", label: "European Union", displayOrder: 1, isoCodes: ["DE", "FR"] }, { id: R_US, code: "US", label: "United States", displayOrder: 2, isoCodes: ["US-CA"] }];
const sources: Row = { id: SRC, name: "Eurostat", url: "https://ec.europa.eu/eurostat", base_tier: 1, tier_override: null, effective_tier: null };
const factRow = (o: Row = {}): Row => ({ id: "f0000000-0000-4000-8000-000000000001", region_id: R_EU, dimension: "labor_markets", fact_label: "EU - Labour cost", value: "40.4 EUR/hour", value_numeric: "40.4", unit: "EUR/hour", currency: "EUR", derivation: "observed", origin_class: "official", source_key: "eurostat", source_ref: "lc", n_observations: null, method_version: "v1", as_at_date: "2025-01-01", reference_period: "2025", last_updated: "2025-01-01", source_id: SRC, status: null, trend: "up", source_note: null, ...o });

test("INV-263: the facts carry the registered source's customer tier, a numeric envelope, and a freshness DERIVED from the row's date against the injected instant (1.8 years old against an annual cadence is ageing)", async () => {
  const { db } = memoryDb({ regions, sources: [sources], regional_data_facts: [factRow(), factRow({ id: "f0000000-0000-4000-8000-000000000002", region_id: "ffffffff-ffff-4fff-8fff-ffffffffffff" }), factRow({ id: "f0000000-0000-4000-8000-000000000003", last_updated: "2026-09-01", trend: "sideways", source_id: null })] });
  const facts = await readFacts(db, roster, NOW);
  assert.equal(facts.length, 2, "a fact whose region is not on the roster is dropped, not given a placeholder code");
  const f = facts.find((x) => x.sourceName === "Eurostat");
  assert.deepEqual([f?.regionCode, f?.valueNumeric, f?.sourceTier, f?.freshness, f?.trend], ["EU", 40.4, 1, "ageing", "up"]);
  const unsourced = facts.find((x) => x.sourceName === null);
  assert.deepEqual([unsourced?.sourceTier, unsourced?.freshness, unsourced?.trend], [null, "current", null], "an unsourced fact has no tier; an unknown trend is null; a recent date is current");
});

test("INV-263: every Operations read fails on its own; the roster failing leaves coverage and facts null (not empty), a facts failure leaves the roster, the list rows and the tallies standing", async () => {
  const rpc = (name: string) => (name === "get_operations_items_public" ? { data: [] } : name === "get_surface_counts" ? { data: { total_items: 0 } } : undefined);
  const base = { regions, region_dimension_coverage: [], regional_data_facts: [], state_cost_facts: [], intelligence_items: [], derived_values: [] };
  const rosterDown = world(base, rpc, [{ table: "regions", op: "select", message: "boom" }]);
  const a = await readOperationsPage(rosterDown, NOW);
  assert.deepEqual([a.roster, a.coverage, a.facts, a.linkedRegulations, a.rowsFailed], [null, null, null, null, false]);
  assert.ok(Array.isArray(a.stateCosts) && Array.isArray(a.derived), "the reads that need no roster still land");
  const factsDown = world(base, rpc, [{ table: "regional_data_facts", op: "select", message: "boom" }]);
  const b = await readOperationsPage(factsDown, NOW);
  assert.deepEqual([b.roster?.length, b.facts, Array.isArray(b.coverage)], [2, null, true]);
  const rowsDown = world(base, (name) => (name === "get_operations_items_public" ? { data: null, error: { message: "rpc down" } } : rpc(name)));
  assert.equal((await readOperationsPage(rowsDown, NOW)).rowsFailed, true, "a failed list is a failure, not an empty list");
});

test("the regulation count per region counts only the verified items the routing table sends to Regulations, into every region their codes fall in; nothing else is a regulation", async () => {
  const items: Row[] = [
    { id: "c0000000-0000-4000-8000-000000000001", item_type: "regulation", domain: 1, jurisdictions: ["EU"], jurisdiction_iso: ["DE"], is_archived: false, provenance_status: "verified" },
    { id: "c0000000-0000-4000-8000-000000000002", item_type: "regulation", domain: 1, jurisdictions: ["EU", "US"], jurisdiction_iso: null, is_archived: false, provenance_status: "verified" },
    { id: "c0000000-0000-4000-8000-000000000003", item_type: "regional_data", domain: 3, jurisdictions: ["EU"], jurisdiction_iso: null, is_archived: false, provenance_status: "verified" },
    { id: "c0000000-0000-4000-8000-000000000004", item_type: "regulation", domain: 1, jurisdictions: ["EU"], jurisdiction_iso: null, is_archived: false, provenance_status: "unverified" },
  ];
  const db = world({ regions, region_dimension_coverage: [], regional_data_facts: [], state_cost_facts: [], intelligence_items: items, derived_values: [] }, (n) => (n === "get_operations_items_public" ? { data: [] } : n === "get_surface_counts" ? { data: { total_items: 0 } } : undefined));
  assert.deepEqual((await readOperationsPage(db, NOW)).linkedRegulations, { EU: 2, US: 1 });
});

test("INV-233: the gate reads the roster and the sourced coverage over the item's whole jurisdiction list; a failed read closes it and says so", async () => {
  const cov: Row[] = [{ id: "d0000000-0000-4000-8000-000000000001", region_id: R_EU, dimension: "labor_markets", state: "populated", fact_count: 3, notes: null }, { id: "d0000000-0000-4000-8000-000000000002", region_id: R_US, dimension: "labor_markets", state: "partial", fact_count: 1, notes: null }, { id: "d0000000-0000-4000-8000-000000000003", region_id: R_US, dimension: "infrastructure", state: "missing", fact_count: 0, notes: null }];
  const ok = await readMatrixEligibility(memoryDb({ regions, region_dimension_coverage: cov }).db, { jurisdictionIso: ["DE"] });
  assert.deepEqual([ok.s3Eligible, ok.resolvedRegionCodes, ok.unavailable], [true, ["EU"], null]);
  const down = await readMatrixEligibility(memoryDb({ regions, region_dimension_coverage: cov }, { failures: [{ table: "region_dimension_coverage", op: "select", message: "boom" }] }).db, { jurisdictionIso: ["DE"] });
  assert.deepEqual([down.s3Eligible, typeof down.unavailable], [false, "string"]);
});

const MS = "5a000000-0000-4000-8000-000000000001";
const FX = "fa000000-0000-4000-8000-000000000001";
const derived = (o: Row = {}): Row => ({ value_id: "d1000000-0000-4000-8000-000000000001", entity_id: null, method_id: "market_series_delta", method_version: "1.0.0", value: "0.05", unit: "USD/EUR", currency: "USD", derivation: "calculated", origin_class: "derived", lifecycle: "verified", admissibility: "calculation_ok", base_confidence: "0.9", asserted_at: NOW, computed_at: NOW, supersedes: null, inputs: [{ table: "market_series", pk: MS }], ...o });
test("the recalculated figures are the CURRENT rows resting on Operations inputs, each with its inputs named, dated and rated by the publisher's class; a stale or unrelated row is not shown; the previous value rides along", async () => {
  const db = memoryDb({
    derived_values: [
      derived({ value_id: "d1000000-0000-4000-8000-000000000001", admissibility: "stale", value: "0.03" }),
      derived({ value_id: "d1000000-0000-4000-8000-000000000002", supersedes: "d1000000-0000-4000-8000-000000000001", computed_at: "2026-10-15T12:00:00Z" }),
      derived({ value_id: "d1000000-0000-4000-8000-000000000003", inputs: [{ table: "obligations", pk: "x" }] }),
      derived({ value_id: "d1000000-0000-4000-8000-000000000004", lifecycle: "falsified" }),
    ],
    market_series: [{ id: MS, label: "EUR/USD", reference_period: "2026-10-15", source_key: "ecb" }],
    data_sources: [{ source_key: "ecb", name: "European Central Bank", url: "https://www.ecb.europa.eu/stats/eurofxref/", redistribution: "free", embeddable: true, licence: "x", attribution: "x" }],
    emission_factors: [{ factor_id: FX, mode: "road", jurisdiction: "EU", quantity_basis: "tkm", as_at_date: "2025-01-01", source_key: "ecb" }],
  }).db;
  const figs = await readDerivedFigures(db);
  assert.equal(figs.length, 1, "the stale row, the falsified row and the unrelated row are not shown");
  const f = figs[0]!;
  assert.deepEqual([f.title, f.value, f.previous, f.originClass], ["One-week movement · EUR/USD", 0.05, 0.03, "Derived"]);
  assert.deepEqual(f.inputs.map((i) => [i.label, i.period, i.sourceName]), [["EUR/USD", "2026-10-15", "European Central Bank"]]);
  assert.equal(typeof f.tier, "number", "rated through the publisher's host class");
  assert.doesNotMatch(JSON.stringify(f), /market_series|derived_values|market_series_delta|obligations/, "no table or method name reaches a customer string");
  await assert.rejects(readDerivedFigures(memoryDb({}, { failures: [{ table: "derived_values", op: "select", message: "boom" }] }).db), /boom/, "a failed read throws; the page marks the panel failed");
});

test("a figure with an input that cannot be rated is an absence, never a tier: the weakest rating among the inputs, null when any input is unrated", async () => {
  const db = memoryDb({ derived_values: [derived({ inputs: [{ table: "market_series", pk: MS }, { table: "market_series", pk: "5a000000-0000-4000-8000-000000000002" }] })], market_series: [{ id: MS, label: "A", reference_period: "p", source_key: "ecb" }, { id: "5a000000-0000-4000-8000-000000000002", label: "B", reference_period: "p", source_key: null }], data_sources: [{ source_key: "ecb", name: "ECB", url: "https://www.ecb.europa.eu/", redistribution: "free", embeddable: true, licence: "x", attribution: "x" }] }).db;
  assert.equal((await readDerivedFigures(db))[0]?.tier, null);
});

const ROW = (itemId: string, o: Row = {}): Row => ({ id: `a1${itemId.slice(2)}`, item_id: itemId, supersedes: null, is_current: true, lifecycle_state: null, technical_maturity_low: 8, technical_maturity_high: 9, technical_maturity_method: "m", commercial_maturity_low: null, commercial_maturity_high: null, commercial_maturity_method: null, horizon_kind: "availability", horizon_band: "NEAR", horizon_rule: "R4", horizon_confidence: "low", horizon_trigger_note: "inferred", refusal_reason: null, credibility_evidence_score: "limited", credibility_authority_score: null, status_token: "HYPOTHESIS", computed_at: NOW, ...o });
test("the batch of assessments is keyed by the LIST id: a legacy id is looked up to its uuid (the old page passed legacy ids to a uuid column and swallowed the error)", async () => {
  const { db } = memoryDb({ intelligence_items: [{ id: U1, legacy_id: "r1" }, { id: U2, legacy_id: null }], research_assessments_current: [ROW(U1), ROW(U2)] });
  const out = await readAssessmentsFor(db, ["r1", U2, "r-missing"]);
  assert.deepEqual(Object.keys(out).sort(), [U2, "r1"].sort());
  assert.equal(out.r1?.horizon?.band, "NEAR");
  await assert.rejects(readAssessmentsFor(memoryDb({ intelligence_items: [{ id: U1, legacy_id: "r1" }], research_assessments_current: [] }, { failures: [{ table: "research_assessments_current", op: "select", message: "boom" }] }).db, ["r1"]), /boom/);
});

test("INV-263: the Research page reports a failed list, failed coverage and failed assessments separately; the assessments are not read when the list failed", async () => {
  const rows = [{ id: U1, legacy_id: null, title: "T", item_type: "research_finding", domain: 7, priority: "LOW", added_date: "2026-10-01", is_archived: false, effective_archived: false }];
  const rpc = (name: string) => (name === "get_research_items_public" ? { data: rows } : name === "get_surface_counts" ? { data: { total_items: 1 } } : name === "get_research_source_coverage" ? { data: [{ transport_mode: "ocean", jurisdiction_iso: "EU", source_count: 3 }, { transport_mode: 5, jurisdiction_iso: "EU", source_count: 1 }] } : undefined);
  const tables = (assessments: Row[] = [ROW(U1)]) => ({ intelligence_items: [], research_assessments_current: assessments, sources: [], source_bias_tags: [] });
  const ok = await readResearchPage(world(tables(), rpc));
  assert.deepEqual([ok.rowsFailed, ok.rows.length, ok.coverage, Object.keys(ok.assessments ?? {})], [false, 1, [{ transportMode: "ocean", jurisdictionIso: "EU", sourceCount: 3 }], [U1]]);
  const covDown = await readResearchPage(world(tables(), (n) => (n === "get_research_source_coverage" ? { data: null, error: { message: "rpc down" } } : rpc(n))));
  assert.deepEqual([covDown.coverage, covDown.rows.length], [null, 1]);
  const asDown = await readResearchPage(world(tables([]), rpc, [{ table: "research_assessments_current", op: "select", message: "boom" }]));
  assert.deepEqual([asDown.assessments, asDown.rows.length], [null, 1]);
  const listDown = await readResearchPage(world(tables([]), (n) => (n === "get_research_items_public" ? { data: null, error: { message: "rpc down" } } : rpc(n))));
  assert.deepEqual([listDown.rowsFailed, listDown.rows, listDown.assessments], [true, [], null]);
});

test("the assessment bundle: the current row, the signposts (unfired first, the watched entity named), the supersedes chain newest first; a prior the reader cannot see makes the chain INCOMPLETE and says so; a failed read is failed", async () => {
  const cur = ROW(U1, { id: "a1000000-0000-4000-8000-0000000000c2", supersedes: "a1000000-0000-4000-8000-0000000000c1" });
  const prior = ROW(U1, { id: "a1000000-0000-4000-8000-0000000000c1", is_current: false, horizon_band: "MID", computed_at: "2026-09-01T00:00:00Z" });
  const world = (assessments: Row[]) => memoryDb({
    research_assessments_current: [cur], research_assessments: assessments,
    signposts: [{ entity_id: "cl:signpost:aaaaaaaaaaaaaaaa", assessment_id: cur.id, watches: "cl:instrument:bbbbbbbbbbbbbbbb", predicate: { op: "date_passed", by: "2027-01-01", basis: "movement_by_date" }, direction: "confirms", fired_at: "2026-10-02T00:00:00Z" }, { entity_id: "cl:signpost:cccccccccccccccc", assessment_id: cur.id, watches: "cl:instrument:bbbbbbbbbbbbbbbb", predicate: { op: "threshold", metric: "m", gte: 2 }, direction: "refutes", fired_at: null }],
    entities: [{ entity_id: "cl:instrument:bbbbbbbbbbbbbbbb", kind: "instrument", canonical_name: "Regulation X", display_name: null }],
  });
  const full = await readAssessmentBundle(world([prior]).db, U1);
  assert.deepEqual([full.failed, full.historyComplete, full.history.map((h) => [h.isCurrent, h.horizonBand])], [false, true, [[true, "NEAR"], [false, "MID"]]]);
  assert.deepEqual(full.signposts.map((s) => [s.direction, s.firedAt !== null, s.watchesLabel]), [["refutes", false, "Regulation X"], ["confirms", true, "Regulation X"]]);
  const closed = await readAssessmentBundle(world([]).db, U1);
  assert.deepEqual([closed.history.length, closed.historyComplete, closed.failed], [1, false, false], "the chain points at a row the reader cannot see");
  const down = await readAssessmentBundle(memoryDb({ research_assessments_current: [cur] }, { failures: [{ table: "research_assessments_current", op: "select", message: "boom" }] }).db, U1);
  assert.deepEqual([down.failed, down.assessment], [true, null]);
  const none = await readAssessmentBundle(memoryDb({ research_assessments_current: [] }).db, U1);
  assert.deepEqual([none.failed, none.assessment, none.historyComplete], [false, null, true], "no assessment is an honest absence, not a failure");
});

test("related items: the caller's rule first, the same source second, five at most, verified and not archived; a failed read is failed, not 'nothing related'", async () => {
  const items: Row[] = Array.from({ length: 7 }, (_, i) => ({ id: `c${i}000000-0000-4000-8000-000000000001`, legacy_id: i === 0 ? "legacy-0" : null, title: `Item ${i}`, summary: null, added_date: `2026-10-0${i + 1}`, source_id: SRC, theme: i < 6 ? "fuels_saf" : "other", is_archived: i === 5, provenance_status: "verified" }));
  const { db } = memoryDb({ intelligence_items: items, sources: [sources] });
  const self = { id: "99000000-0000-4000-8000-000000000001", sourceId: SRC };
  const byTheme = await relatedItems(db, self, (q) => q.eq("theme", "fuels_saf"));
  assert.deepEqual([byTheme.reason, byTheme.items.length, byTheme.items.some((i) => i.title === "Item 5"), byTheme.items[0]?.title, byTheme.items[0]?.sourceName], ["match", 5, false, "Item 4", "Eurostat"], "newest first, the archived one absent");
  const bySource = await relatedItems(db, self, (q) => q.eq("theme", "nothing"));
  assert.deepEqual([bySource.reason, bySource.items.length], ["source", 5]);
  assert.equal(bySource.items.find((i) => i.title === "Item 0"), undefined, "the legacy id is preferred when present");
  assert.deepEqual((await relatedItems(db, { id: self.id, sourceId: null }, (q) => q.eq("theme", "nothing"))).reason, "none");
  const failed = await relatedItems(memoryDb({ intelligence_items: items }, { failures: [{ table: "intelligence_items", op: "select", message: "boom" }] }).db, self, null);
  assert.deepEqual([failed.failed, failed.items], [true, []]);
});

test("persona read: the raw assessments table is not a client read (row level security on, no policy), the current view is granted to signed-in readers only, and the public RPCs the lists use are granted to both", () => {
  const sql = readFileSync("supabase/schema.sql", "utf8");
  assert.match(sql, /ALTER TABLE public\.research_assessments ENABLE ROW LEVEL SECURITY/);
  assert.equal(/CREATE POLICY \w+ ON public\.research_assessments\b/.test(sql), false, "no policy: the raw table returns no rows to a client");
  assert.match(sql, /GRANT SELECT ON TABLE public\.research_assessments_current TO authenticated/);
  assert.equal(/GRANT [A-Z, ]+ ON TABLE public\.research_assessments_current TO anon/.test(sql), false);
  for (const fn of ["get_research_items_public", "get_operations_items_public"]) assert.match(sql, new RegExp(`GRANT ALL ON FUNCTION public\\.${fn}\\(\\) TO authenticated`));
  void readRoster;
});
