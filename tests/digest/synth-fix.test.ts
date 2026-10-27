// SYNTH-FIX-1: the bundle drops (B1), the evidence-containment pre-check (B2), the gap contradiction (B3), every failing rule listed (B4). Red first: each assertion names the measured fault of SYNTH-1 and DRAIN-2.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ontologyOf, type Relation } from "@/core/coupling";
import { groundingReasons } from "@/core/digest/containment";
import { assembleClusters, isYearOnlyTarget } from "@/core/flywheel/clusters";
import type { Fact, PatternInput } from "@/core/flywheel/patterns";
import { applyBatch } from "@/features/batches";
import { claimsOfRows } from "@/features/batches/kinds/admin-opportunity-findings/export";
import { themeBriefsExporter } from "@/features/batches/kinds/theme-briefs/apply";

import { MemDb } from "../_support/memdb.ts";
import { E as OE, FIXTURE_RELATIONS, fixtureRows } from "../_support/ontology.ts";
import { batchFile } from "../batches/world.ts";
import { themeWorld } from "../batches/worlds.ts";

import { adminEntry, adminWorld, ref, ROWS } from "./admin-world.ts";

const apply = (w: ReturnType<typeof adminWorld>, entries: unknown[]) => applyBatch("admin-opportunity-findings", w.deps, { content: JSON.stringify(batchFile("admin-opportunity-findings", entries)), dry: true, runId: "a1" });
const ten = Array.from({ length: 10 }, (_, i) => `substation ${i + 1}: feeder`).join("\n");

test("B2: a count word the evidence does not hold fails (eleven against a cluster of ten rows); the same word as the cluster's own count passes", () => {
  assert.match(groundingReasons({ texts: { finding: "The cluster names eleven substations in the zone." }, evidence: [ten], counts: [10] }).join(), /count "eleven"/);
  assert.deepEqual(groundingReasons({ texts: { finding: "The cluster names ten substations in the zone." }, evidence: [ten], counts: [10] }), []);
});

test("B2: an acronym or term absent from every cited capture fails, naming it; present, it passes; numbers match as the same normalised number and a percent keeps its sign", () => {
  const cap = "Ports on the core network (TEN-T) must offer shore power; the 1,000 kW limit applies to 45 % of calls.";
  assert.match(groundingReasons({ texts: { signpost: "Watch TEN-T core and comprehensive ports" }, evidence: ["Shore power is required at ports."] }).join(), /term "TEN-T"/);
  assert.deepEqual(groundingReasons({ texts: { signpost: "Watch TEN-T core ports; limit 1000 kW for 45% of calls" }, evidence: [cap] }), []);
  assert.match(groundingReasons({ texts: { f: "a 45% share" }, evidence: ["a 45 kW limit"] }).join(), /percent "45%"/);
  assert.deepEqual(groundingReasons({ texts: { f: "## 1. What It Is\n\nThe Emissions Trading System applies." }, evidence: ["The Emissions Trading System applies."], ignore: ["## 1. What It Is"] }), [], "a heading passed as ignore is not read, and a sentence-initial word is not part of a term");
});

test("B3: a coverage gap whose every figure and term a cited capture already holds is a contradiction; a gap naming what no capture holds passes", () => {
  const evidence = ["The median grid connection queue is 31 months in the transmission zone."];
  assert.match(groundingReasons({ texts: {}, gaps: ["the 31 months queue length"], evidence }).join(), /gap contradiction: coverage_gaps\[0\]/);
  assert.deepEqual(groundingReasons({ texts: {}, gaps: ["no HVO price series for the zone"], evidence }), [], "a gap naming an absent series passes");
  const imo = ["The IMO adopted its 2030 strategy; the grid connection queue is 31 months."];
  assert.deepEqual(groundingReasons({ texts: {}, gaps: ["no IMO 2030 fuel-intensity figure"], evidence: imo }), [], "context tokens (an acronym, a year) held by a capture are no contradiction");
  assert.match(groundingReasons({ texts: {}, gaps: ["the grid queue figure"], evidence: ["The grid queue figure is published yearly."] }).join(), /whole phrase/, "the whole missing_input phrase verbatim in a capture");
  assert.deepEqual(groundingReasons({ texts: {}, gaps: ["the installed charging capacity at the mandate date"], evidence }), []);
});

test("B2/B3 and B4 in the admin kind: an invented count, an invented term and a contradicted gap are all residue, and the dry apply lists EVERY failing rule of the entry in one note", async () => {
  const w = adminWorld();
  const base = adminEntry();
  const findings = [{ ...(base.findings as Record<string, unknown>[])[0], sourced_finding_md: `The mandate requires 50 MW [${ref(ROWS.item)}] and eleven substations [${ref(ROWS.grid)}], also [${ref(ROWS.oem)}].` }];
  const signposts = [{ ...(base.signposts as Record<string, unknown>[])[0], observable: "TEN-T core ports reporting" }];
  const r = await apply(w, [adminEntry({ findings, signposts, coverage_gaps: [{ missing_input: "the queue of 31 months", source_class: "govIntergov" }] })]);
  assert.equal(r.counts.residue, 1);
  const note = r.notes[0] ?? "";
  assert.doesNotMatch(note, /coverage_gaps\[0\] states/);
  assert.match(note, /3 failing rule\(s\)/);
  for (const part of [/count "eleven"/, /term "TEN-T"/, /gap contradiction/]) assert.match(note, part);
  assert.equal(r.counts.valid, 0);
  assert.equal((await apply(w, [adminEntry()])).counts.valid, 1, "the grounded entry is unaffected");
});

test("B1: a year-only target is no event, a research assessment stays only through an entity another row of the cluster shares, and each drop is counted on the cluster", async () => {
  const rows = fixtureRows();
  const onto = ontologyOf({ entities: rows.entities as never, refs: rows.refs as never, relations: rows.relations as never });
  const related = (e: string) => FIXTURE_RELATIONS.flatMap((r) => { const [p, c] = [OE(r.parent), OE(r.child)]; return p === e ? [{ entity: c, relation: r.relation as Relation }] : c === e ? [{ entity: p, relation: r.relation as Relation }] : []; });
  const fact = (o: Partial<Fact>): Fact => ({ table: "t", pk: "p", role: "claim", entities: ["e1"], modes: [], surface: "regulations", at: null, due: null, source: null, tier: null, qty: null, unit: null, trl: null, kind: "FACT", group: null, ...o });
  const [saf, bunkers] = [OE("carrier:hefa_saf"), OE("carrier:bio_bunkers")];
  const facts = [
    fact({ table: "obligation_objects", pk: "o1", role: "ratchet", entities: [saf], due: "2027-06-01", item: "i1" }),
    fact({ table: "item_forward_events", pk: "year", role: "trigger", entities: [saf], due: "2030-01-01", kind: "target", surface: "regulations" }),
    fact({ table: "item_forward_events", pk: "day", role: "trigger", entities: [saf], due: "2028-03-01", kind: "compliance_deadline", surface: "regulations" }),
    fact({ table: "market_series", pk: "m1", role: "series", entities: [saf], at: "2026-09-01", qty: 2, unit: "ratio", surface: "market" }),
    fact({ table: "research_assessments", pk: "near", role: "tech", entities: [saf], trl: 7, surface: "research" }),
    fact({ table: "research_assessments", pk: "far", role: "tech", entities: [bunkers], trl: 5, surface: "research" }),
  ];
  const db = new MemDb();
  db.seed("item_forward_events", [{ id: "year", date_precision: "year" }, { id: "day", date_precision: "day" }]);
  const input: PatternInput = { now: new Date("2026-10-15T12:00:00Z"), facts, related, flow: null, classOf: onto.classOf, modesOf: onto.modesOf };
  const { clusters } = await assembleClusters(db.client, { limit: 20, input });
  const c = clusters.find((x) => x.hops === 1 && x.anchor_entity_ids.includes(saf) && x.anchor_entity_ids.includes(bunkers));
  const keys = c?.rows.map((r) => `${r.table}:${r.pk}`) ?? [];
  assert.ok(!keys.includes("item_forward_events:year") && keys.includes("item_forward_events:day"), "the year-only target is out, the dated deadline stays");
  assert.ok(keys.includes("research_assessments:near") && !keys.includes("research_assessments:far"), "the assessment reached through the other entity is out, the 0-hop one stays");
  assert.deepEqual(c?.dropped, { year_only_events: 1, generic_assessments: 1 });
  assert.equal(isYearOnlyTarget({ date_precision: "year", event_kind: "compliance_deadline" }), false, "a year-precision deadline is still an event");
});

test("B1: a claim row with no capture carries its claim text and kind into the bundle; the theme bundle states the year-only events it dropped", async () => {
  const w = themeWorld();
  const row = { table: "section_claim_provenance", pk: "c1000000-0000-4000-8000-000000000002", surface: "regulations" as const, entity_ids: [], date: null, figure: null, quote_capture_id: null };
  const claims = await claimsOfRows(w.db.client, [{ id: "c", anchor_entity_ids: [], surfaces: [], angles: [], hops: 0, axes: [], dropped: { year_only_events: 0, generic_assessments: 0 }, rows: [row] }]);
  assert.deepEqual(claims.get(`${row.table}:${row.pk}`), { claim_text: "Carriers pass the cost on.", claim_kind: "FACT" });
  w.db.seed("item_forward_events", [{ id: "e1000000-0000-4000-8000-000000000009", intelligence_item_id: "a0000000-0000-4000-8000-000000000002", event_date: "2030-01-01", date_precision: "year", event_kind: "target", obligation_text: "recital", source_kind: "claim", source_claim_id: row.pk, source_span: "x", confidence: "low", extractor_version: "t" }]);
  const out = await themeBriefsExporter(w.db.client)({ limit: 5 });
  const t = out.items[0] as unknown as { truncation: Record<string, number>; members: { forward_events: unknown[] }[] };
  assert.equal(t.truncation.forward_events_dropped_year_only_target, 1);
  assert.equal(t.members.flatMap((m) => m.forward_events).length, 1, "only the dated event is listed");
});
