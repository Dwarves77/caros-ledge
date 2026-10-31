// ENGINE-JOIN-1: discovery joins on the typed graph. INV-1 a shared entity filed only through entity_refs scores shared_entity; INV-2 entities that meet across one entity_relations edge score coupled_entity; INV-3 a season string ("2025/26") is no entity;
// INV-4 a pair joined only by a shared source is neither a connection nor a candidate; INV-5 a 0.22 pair is kept as a candidate naming the surface truth that would complete it, upgraded in place when a later pass reaches the threshold and deleted when it falls under the
// floor; INV-6 gap flags are born open and resolved by the pass that no longer finds them; INV-7 clustering reads neither a source-only edge nor a candidate (the 833-member theme cannot re-form); and the structured-fact join (addendum A), the forming patterns (B)
// and the missing-surface words (C).
import assert from "node:assert/strict";
import { test } from "node:test";

import { clusterThemes } from "@/core/flywheel/cluster";
import { discoverAll, evidenceOf, isCorroborationOnly } from "@/core/flywheel/discover";
import { missingFor, readEntityFacts, readFactItems } from "@/core/flywheel/facts-join";
import { createdBy, GAP_NAMESPACE, reflectFindings } from "@/core/flywheel/flags";
import { detectGaps, gapFindings } from "@/core/flywheel/gaps";
import { withEntityGraph, type Signature } from "@/core/flywheel/signature";
import { runConnectionDiscovery } from "@/features/flywheel/run-discovery";

import { connectDb } from "./world.ts";

type Row = Record<string, unknown>;
const NOW = new Date("2026-10-31T00:00:00Z");
const discoverConnections = (item: Signature, candidates: readonly Signature[], opts: Parameters<typeof discoverAll>[2] = {}) => discoverAll(item, candidates, opts).kept;
const sig = (id: string, over: Partial<Signature> = {}): Signature => ({ id, item_type: "regulation", domain: 1, ...over });
const E_FUEL = "cl:material:aaaaaaaaaaaaaaa1";
const E_ACT = "cl:instrument:aaaaaaaaaaaaaaa2";
const E_OTHER = "cl:instrument:aaaaaaaaaaaaaaa3";
const E_JUR = "cl:jurisdiction:aaaaaaaaaaaaaaa4";
const entity = (entity_id: string, canonical_name: string): Row => ({ entity_id, kind: entity_id.split(":")[1], canonical_name, status: "active" });
const ref = (ref_id: string, entity_id: string, role: string, ref_table = "intelligence_items"): Row => ({ ref_table, ref_id, entity_id, role, asserted_by: "test", method_version: "refs@3.0.0" });
const graph = () => [entity(E_FUEL, "heavy fuel oil"), entity(E_ACT, "the maritime emissions scheme"), entity(E_OTHER, "the fuel standard"), entity(E_JUR, "Germany")];

test("INV-1: two items filed under one entity only through entity_refs score shared_entity 0.85, with the entity's name as the evidence; a bare jurisdiction joins nothing", async () => {
  const m = connectDb({ entities: graph(), entity_refs: [ref("a", E_FUEL, "cites_feedstock"), ref("b", E_FUEL, "cites_feedstock"), ref("a", E_JUR, "cites_jurisdiction"), ref("b", E_JUR, "cites_jurisdiction"), ref("c", E_JUR, "cites_jurisdiction")] });
  const [a, b, c] = await withEntityGraph(m.db, [sig("a", { title: "Fuel outlook" }), sig("b", { title: "Bunker notice" }), sig("c")]);
  const hit = discoverConnections(a as Signature, [b as Signature, c as Signature]);
  assert.deepEqual(hit.map((x) => x.target), ["b"], "the jurisdiction alone connects a and c to nothing");
  const evidence = hit[0]?.basis.find((x) => x.signal === "shared_entity");
  assert.equal(evidence?.weight, 0.85);
  assert.deepEqual(evidence?.tokens?.entities, [{ id: E_FUEL, name: "heavy fuel oil" }]);
  assert.equal(evidence?.detail, "both name heavy fuel oil");
  assert.ok((hit[0]?.score ?? 0) >= 0.85);
});

test("INV-2: items whose entities meet across one entity_relations edge (either direction) score coupled_entity 0.5, naming the relation row", async () => {
  const m = connectDb({ entities: graph(), entity_refs: [ref("a", E_ACT, "cites_instrument"), ref("b", E_FUEL, "cites_feedstock")], entity_relations: [{ parent_entity_id: E_FUEL, child_entity_id: E_ACT, relation: "fuel_for_mode", asserted_by: "test" }] });
  const [a, b] = await withEntityGraph(m.db, [sig("a"), sig("b")]);
  assert.deepEqual(a?.hops?.map((h) => [h.entity_id, h.relation, h.via_is_parent]), [[E_FUEL, "fuel_for_mode", false]]);
  const forward = discoverConnections(a as Signature, [b as Signature])[0];
  const backward = discoverConnections(b as Signature, [a as Signature])[0];
  for (const c of [forward, backward]) {
    const e = c?.basis.find((x) => x.signal === "coupled_entity");
    assert.equal(e?.weight, 0.5);
    assert.deepEqual(e?.tokens?.coupled, [{ parent: { id: E_FUEL, name: "heavy fuel oil" }, relation: "fuel_for_mode", child: { id: E_ACT, name: "the maritime emissions scheme" } }]);
  }
  assert.equal(forward?.basis.some((x) => x.signal === "shared_entity"), false);
});

test("INV-3: a season string is no entity; a regulation identifier still is, and only as the fallback of an item with no refs", async () => {
  const named = await withEntityGraph(connectDb({}).db, [sig("s", { title: "Fuel outlook for the 2025/26 season" }), sig("t", { title: "Regulation (EU) 2023/1805 on fuels; Directive 2012/27/EU; Regulation (EC) No 1907/2006" })]);
  assert.deepEqual([named[0]?.entity_ids, named[1]?.entity_ids], [[], ["reg:1907/2006", "reg:2012/27", "reg:2023/1805"]]);
  const m = connectDb({ entities: graph(), entity_refs: [ref("c", E_FUEL, "cites_feedstock")] });
  const [a, b, c] = await withEntityGraph(m.db, [sig("a", { title: "Prices 2025/26" }), sig("b", { title: "Outlook 2025/26" }), sig("c", { title: "Regulation (EU) 2023/1805" })]);
  assert.deepEqual([a?.entity_ids, b?.entity_ids, c?.entity_ids], [[], [], [E_FUEL]], "the item with refs does not also take a title identifier");
  assert.equal(discoverAll(a as Signature, [b as Signature]).kept.length, 0, "2025/26 in two titles connects nothing");
  const [d, e] = await withEntityGraph(connectDb({}).db, [sig("d", { title: "Regulation (EU) 2023/1805" }), sig("e", { title: "Guidance on Regulation (EU) 2023/1805" })]);
  assert.equal(discoverConnections(d as Signature, [e as Signature])[0]?.basis[0]?.signal, "shared_entity");
});

test("INV-4: a pair joined only by a shared source corroborates and connects nothing: it is neither kept nor a candidate", () => {
  const a = sig("a", { source_id: "s" });
  const b = sig("b", { source_id: "s" });
  const r = discoverAll(a, [b], { threshold: 0 });
  assert.deepEqual([r.kept.length, r.developing.length], [0, 0]);
  const withTopic = discoverAll(sig("a", { source_id: "s", jurisdiction_iso: ["DE"], topic_tags: ["x"] }), [sig("b", { source_id: "s", jurisdiction_iso: ["DE"], topic_tags: ["x"] })]);
  assert.deepEqual([withTopic.kept.length, withTopic.developing.length], [1, 0], "a source beside another kind of evidence corroborates it: 0.2 + 0.15 reaches the threshold");
  assert.equal(isCorroborationOnly([{ signal: "shared_source" }]), true);
  assert.equal(isCorroborationOnly([]), false, "a manual link with no evidence is not corroboration-only");
});

const ITEM = (id: string, over: Row = {}): Row => ({ id, item_type: "regulation", domain: 1, title: `Item ${id}`, provenance_status: "verified", is_archived: false, replaced_by: null, jurisdiction_iso: ["DE"], topic_tags: ["fuel"], operational_scenario_tags: [], compliance_object_tags: [], created_at: "2026-10-01T00:00:00Z", ...over });
const edges = (m: ReturnType<typeof connectDb>): Row[] => m.tables.item_cross_references as Row[];

test("INV-5: a 0.22 pair is a candidate naming the missing surface truth; a later pass at 0.30 upgrades it in place; one under the floor deletes it", async () => {
  const m = connectDb({ intelligence_items: [ITEM("a"), ITEM("b", { topic_tags: ["fuel", "x"], jurisdiction_iso: ["DE"] })], workspace_settings: [{}] }, { unique: { item_cross_references: ["source_item_id", "target_item_id"] } });
  const deps = { sb: m.db };
  let r = await runConnectionDiscovery(deps, "a");
  assert.deepEqual([r.found, r.candidates], [0, 1]);
  const [cand] = edges(m);
  assert.equal(cand?.origin, "candidate");
  assert.equal(cand?.score, 0.2);
  const basis = cand?.basis as { evidence: { signal: string }[]; missing: { surface: string; truth: string; patternFamily: string } };
  assert.deepEqual(basis.evidence.map((e) => e.signal), ["shared_jurisdiction_topic"]);
  assert.deepEqual(basis.missing, { surface: "market", truth: "a Market Intel price series that ties these items together", patternFamily: "leadLag" });
  const id = cand?.id;
  // the pair gains a shared scenario: 0.2 + 0.3 reaches the threshold, the same row becomes a connection
  (m.tables.intelligence_items as Row[]).forEach((i) => (i.operational_scenario_tags = ["scn"]));
  r = await runConnectionDiscovery(deps, "a");
  assert.equal(r.write?.upgraded, 1);
  assert.equal(edges(m).length, 1);
  assert.deepEqual([edges(m)[0]?.id, edges(m)[0]?.origin, Array.isArray(edges(m)[0]?.basis)], [id, "provenance_discovery", true]);
  // a connection already established is not demoted by a weaker later pass
  (m.tables.intelligence_items as Row[]).forEach((i) => (i.operational_scenario_tags = []));
  r = await runConnectionDiscovery(deps, "a");
  assert.equal(r.write?.skippedEstablished, 1);
  assert.equal(edges(m)[0]?.origin, "provenance_discovery");
  // a candidate a later pass no longer scores is deleted
  const m2 = connectDb({ intelligence_items: [ITEM("a"), ITEM("b")], workspace_settings: [{}] }, { unique: { item_cross_references: ["source_item_id", "target_item_id"] } });
  await runConnectionDiscovery({ sb: m2.db }, "a");
  assert.equal(edges(m2).length, 1);
  (m2.tables.intelligence_items as Row[])[1]!.topic_tags = ["other"];
  const gone = await runConnectionDiscovery({ sb: m2.db }, "a");
  assert.equal(gone.write?.candidatesDeleted, 1);
  assert.equal(edges(m2).length, 0);
});

test("a candidate is invisible to the readers of connections: the pair view, the lineage upgrade and the cluster ignore it", async () => {
  const { assemblePairs } = await import("@/core/flywheel/edges");
  const row = { source_item_id: "a", target_item_id: "b", relationship: "related", origin: "candidate", score: 0.22, basis: { evidence: [{ signal: "shared_entity", weight: 0.85 }], missing: null } };
  assert.equal(assemblePairs([row], new Map([["a", {}], ["b", {}]]), { minScore: 0 }).pairs.length, 0);
  assert.deepEqual(evidenceOf(row.basis).map((b) => b.signal), ["shared_entity"], "the object form reads as its evidence");
});

test("INV-6: gap flags are born open; a pass that no longer finds one resolves it; flags the pass does not own are left alone", async () => {
  const finding = (ref: string, type: string) => ({ subjectRef: ref, row: { category: "coverage_gap", subject_type: "system", subject_ref: ref, description: "d", recommended_actions: [], created_by: createdBy(GAP_NAMESPACE, type) } });
  const m = connectDb({ integrity_flags: [{ id: "n1", subject_ref: "N", created_by: createdBy(GAP_NAMESPACE, "pattern_hop_gap"), status: "open" }] });
  const owns = (by: string) => !by.startsWith(createdBy(GAP_NAMESPACE, "pattern_"));
  const first = await reflectFindings(m.db, GAP_NAMESPACE, [finding("T1", "surface_gap"), finding("T2", "surface_gap")], "pass-1", NOW.toISOString(), { owns });
  assert.deepEqual([first.inserted, first.resolved], [2, 0]);
  const flags = () => m.tables.integrity_flags as Row[];
  assert.deepEqual(flags().filter((f) => f.subject_ref !== "N").map((f) => f.status), ["open", "open"]);
  const dry = await reflectFindings(m.db, GAP_NAMESPACE, [finding("T1", "surface_gap")], "pass-2", NOW.toISOString(), { owns, dry: true });
  assert.deepEqual([dry.inserted, dry.resolved], [0, 1]);
  assert.equal(flags().filter((f) => f.status === "open").length, 3, "a dry run writes nothing");
  const second = await reflectFindings(m.db, GAP_NAMESPACE, [finding("T1", "surface_gap")], "pass-2", NOW.toISOString(), { owns });
  assert.deepEqual([second.inserted, second.resolved, second.unchanged], [0, 1, 1]);
  const t2 = flags().find((f) => f.subject_ref === "T2");
  assert.deepEqual([t2?.status, t2?.resolved_by], ["resolved", "pass-2"]);
  assert.equal(flags().find((f) => f.subject_ref === "N")?.status, "open", "the pattern step's need is not this pass's to resolve");
  const again = await reflectFindings(m.db, GAP_NAMESPACE, [finding("T1", "surface_gap"), finding("T2", "surface_gap")], "pass-3", NOW.toISOString(), { owns });
  assert.equal(again.inserted, 1, "a gap that returns is open again");
});

test("INV-7: clustering reads neither a source-only edge nor a candidate: a corpus glued by same-source edges forms no theme, a real connection still does", () => {
  const ids = Array.from({ length: 30 }, (_, i) => `n${String(i).padStart(2, "0")}`);
  const nodes = ids.map((id) => ({ id, item_type: "regulation", domain: 1 }));
  const sourceOnly = ids.slice(1).map((id, i) => ({ source: ids[i] as string, target: id, score: 0.4, basis: [{ signal: "shared_source", detail: "grounded in the same source", weight: 0.4 }] }));
  assert.equal(clusterThemes(nodes, sourceOnly).themes.length, 0);
  const candidates = ids.slice(1).map((id, i) => ({ source: ids[i] as string, target: id, score: 0.22, origin: "candidate", basis: { evidence: [{ signal: "shared_entity", weight: 0.85 }] } }));
  assert.equal(clusterThemes(nodes, candidates).themes.length, 0);
  const real = { source: "n00", target: "n01", score: 0.5, basis: [{ signal: "shared_source", weight: 0.15 }, { signal: "shared_scenario", weight: 0.3 }] };
  const themes = clusterThemes(nodes, [...sourceOnly, ...candidates, real]).themes;
  assert.deepEqual(themes.map((t) => t.members), [["n00", "n01"]]);
  assert.equal(clusterThemes(nodes, [{ source: "n00", target: "n01", score: 1, basis: [] }]).themes.length, 1, "an explicit link with no evidence entries still connects");
});

// ── addendum A: the structured facts join the items through the graph ────────────────────────────────────────────────────────────────────────
const S1 = "50000000-0000-4000-8000-000000000001";
const S2 = "50000000-0000-4000-8000-000000000002";
const S3 = "50000000-0000-4000-8000-000000000003";
const OBL_NEXT = "obl:next";
const factsWorld = () =>
  connectDb({
    entities: graph(),
    intelligence_items: [ITEM("11111111-1111-4111-8111-111111111111", { title: "Maritime emissions scheme" }), ITEM("22222222-2222-4222-8222-222222222222", { title: "Bunker fuel market note", item_type: "market_signal", domain: 2 })],
    entity_refs: [
      ref("11111111-1111-4111-8111-111111111111", E_ACT, "cites_instrument"),
      ref("22222222-2222-4222-8222-222222222222", E_FUEL, "cites_feedstock"),
      ...[S1, S2, S3].map((id) => ref(id, E_FUEL, "cites_feedstock", "market_series")),
    ],
    entity_relations: [{ parent_entity_id: E_FUEL, child_entity_id: E_ACT, relation: "fuel_for_mode", asserted_by: "test" }],
    market_series: [
      { id: S1, series_key: "hfo", label: "HFO", value_numeric: 100, unit: "USD/t", as_at_date: "2026-10-01" },
      { id: S2, series_key: "hfo", label: "HFO", value_numeric: 120, unit: "USD/t", as_at_date: "2026-10-24" },
      { id: S3, series_key: "hfo", label: "HFO", value_numeric: 124.8, unit: "USD/t", as_at_date: "2026-10-31" },
    ],
    obligation_objects: [
      { obligation_id: "obl:past", instrument_item_id: "11111111-1111-4111-8111-111111111111", due_date: "2026-01-01" },
      { obligation_id: OBL_NEXT, instrument_item_id: "11111111-1111-4111-8111-111111111111", due_date: "2026-12-01", duty_holder_class: ["operator"] },
    ],
    statutory_computations: [{ computation_id: "60000000-0000-4000-8000-000000000001", entity_id: E_ACT, obligation_id: OBL_NEXT, scenario_key: "2026", result: 50000, result_unit: "EUR", computed_at: "2026-10-30T00:00:00Z" }],
  });

test("A: an item filed under the HFO entity resolves the HFO series with its latest value and its one-month movement; the instrument one relation away resolves it too", async () => {
  const m = factsWorld();
  const facts = await readEntityFacts(m.db, ["22222222-2222-4222-8222-222222222222", "11111111-1111-4111-8111-111111111111"]);
  const direct = facts.get("22222222-2222-4222-8222-222222222222") ?? [];
  assert.equal(direct.length, 1, "three observations of one series are one fact");
  assert.deepEqual([direct[0]?.refTable, direct[0]?.refId, direct[0]?.hop, direct[0]?.surface, direct[0]?.entity.canonicalName], ["market_series", S3, 0, "market", "heavy fuel oil"]);
  assert.deepEqual([direct[0]?.summary.value, direct[0]?.summary.unit, direct[0]?.summary.asOf], [124.8, "USD/t", "2026-10-31"]);
  assert.ok(Math.abs((direct[0]?.summary.delta?.month ?? 0) - 0.248) < 1e-9, "+24.8% over the month");
  assert.ok(Math.abs((direct[0]?.summary.delta?.week ?? 0) - 0.04) < 1e-9, "+4% over the week");
  const near = facts.get("11111111-1111-4111-8111-111111111111") ?? [];
  assert.deepEqual([near[0]?.hop, near[0]?.relation, near[0]?.refId], [1, "fuel_for_mode", S3]);
});

test("A: a series resolves the regulations filed under its entity, each with its next dated obligation and its penalty figure", async () => {
  const m = factsWorld();
  const items = (await readFactItems(m.db, "market_series", [S3], NOW)).get(S3) ?? [];
  assert.deepEqual(items.map((i) => [i.refId, i.hop, i.surface]), [["22222222-2222-4222-8222-222222222222", 0, "market"], ["11111111-1111-4111-8111-111111111111", 1, "regulations"]]);
  const reg = items[1];
  assert.deepEqual([reg?.relation, reg?.entity.canonicalName], ["fuel_for_mode", "the maritime emissions scheme"], "the entity the linked row is filed under");
  assert.deepEqual(reg?.summary, { label: "Maritime emissions scheme", date: "2026-12-01", dutyHolder: ["operator"], penalty: { value: 50000, unit: "EUR" } });
  const quiet = await readFactItems(factsWorld().db, "market_series", ["50000000-0000-4000-8000-0000000000ff"], NOW);
  assert.deepEqual([...quiet.values()], [[]], "a row filed under nothing resolves nothing");
});

// ── addendum C: what is missing is a surface and a truth, never an evidence-kind name ──────────────────────────────────────────────────────
test("C: the pattern family is read from the entity classes, the surface is the first the family needs with no member nearby, and the truth is composed in words", () => {
  const set = (...x: string[]) => new Set(x);
  assert.deepEqual(missingFor(set("feedstock"), set("instrument"), set("regulations"), "heavy fuel oil"), { surface: "market", truth: "a Market Intel price series for heavy fuel oil", patternFamily: "penaltyAbatement" });
  assert.deepEqual(missingFor(set("instrument"), set("node"), set("regulations"), "the port of Rotterdam"), { surface: "operations", truth: "an Operations capacity or queue figure for the port of Rotterdam", patternFamily: "mandateCapacity" });
  assert.equal(missingFor(set("feedstock"), set("carrier"), set("market", "operations"), null)?.patternFamily, "crossModal");
  assert.equal(missingFor(set("feedstock"), set("feedstock"), set("market"), null)?.surface, "operations", "the family's surfaces are present: the first of the four with none");
  assert.equal(missingFor(set(), set(), set("regulations", "market", "operations", "research"), null), null);
  const words = JSON.stringify(missingFor(set("instrument"), set("instrument"), set(), null));
  assert.ok(!/scenario|compliance_object|shared_/.test(words), "no evidence-kind name reaches a customer field");
});

test("INV-6b: a gap flag carries its typed payload {surface, truth, entity} beside the prose, so a surface never parses the description", () => {
  const theme = { id: "T", members: ["a", "b"], surfaces: ["regulations", "research"], pivots: [] };
  const [flag] = gapFindings(detectGaps([theme]), new Map());
  const payload = (flag?.row.recommended_actions as { action?: string; surface?: string; truth?: string; entity?: unknown }[]).find((a) => a.action === "missing");
  assert.deepEqual(payload, { action: "missing", surface: "market", truth: "a Market Intel price series that ties these items together", entity: null });
  const home = gapFindings(detectGaps([{ ...theme, surfaces: ["regulations"] }], { profile: { jurisdictions: { US: 3 } }, jurisdictionsByMember: { a: ["DE"], b: ["FR"] } }), new Map([["cl:jurisdiction:7bb4f2d2b3d6dde1", { id: "cl:jurisdiction:7bb4f2d2b3d6dde1", kind: "jurisdiction", canonicalName: "United States" }]]));
  const j = home.flatMap((f) => f.row.recommended_actions as { action?: string; surface?: string; truth?: string; entity?: string | null }[]).find((a) => a.action === "missing" && a.surface === "regulations");
  assert.equal(j?.truth?.startsWith("a Regulations dated obligation"), true);
});
