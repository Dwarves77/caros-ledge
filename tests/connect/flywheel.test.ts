// Discovery, intersections, clustering and theme lineage: the pure parts of the flywheel, pinned to the weights and rules in the data files.
import assert from "node:assert/strict";
import { test } from "node:test";

import { clusterThemes } from "@/core/flywheel/cluster";
import { computeTagFrequencies, discoverConnections, type TagFrequencies } from "@/core/flywheel/discover";
import { detectIntersections } from "@/core/flywheel/intersections";
import type { Signature } from "@/core/flywheel/signature";
import { computeMemberHash, convergenceBand, diffThemes, isBriefStale, lineageFromThemeDelta, resolveBriefForTheme } from "@/core/flywheel/themes";

const sig = (id: string, over: Partial<Signature> = {}): Signature => ({ id, item_type: "regulation", domain: 1, ...over });
/** One pair scored: a threshold of zero keeps the pairs that score nothing, so a self-pair or an unrelated pair reads as a zero score. */
const scoreConnection = (a: Signature, b: Signature, freqMap?: TagFrequencies) => discoverConnections(a, [b], { threshold: 0, ...(freqMap ? { freqMap } : {}) })[0] as NonNullable<ReturnType<typeof discoverConnections>[number]>;

test("scoreConnection: each basis carries its configured weight, the score caps at 1, a self-pair scores nothing", () => {
  const a = sig("a", { source_id: "s1", compliance_object_tags: ["battery"], entity_ids: ["reg:2023/1805"], obligation_keys: ["o1"] });
  const b = sig("b", { source_id: "s1", compliance_object_tags: ["battery"], entity_ids: ["reg:2023/1805"], obligation_keys: ["o1"] });
  const r = scoreConnection(a, b);
  const w = (s: string) => r.basis.find((x) => x.signal === s)?.weight;
  assert.equal(w("shared_source"), 0.4);
  assert.equal(w("shared_compliance_object"), 0.18);
  assert.equal(w("shared_entity"), 0.85);
  assert.equal(w("shared_obligation"), 0.35);
  assert.equal(r.score, 1);
  assert.equal(r.relationship, "shared_entity");
  assert.equal(scoreConnection(a, a).score, 0);
  assert.equal(scoreConnection(a, sig("c")).score, 0);
});

test("scoreConnection: role tags never count as a shared compliance object; per-tag cap is 3; jurisdiction needs a topic too", () => {
  assert.equal(scoreConnection(sig("a", { compliance_object_tags: ["shipper"] }), sig("b", { compliance_object_tags: ["shipper"] })).score, 0);
  const many = ["t1", "t2", "t3", "t4", "t5"];
  assert.equal(scoreConnection(sig("a", { operational_scenario_tags: many }), sig("b", { operational_scenario_tags: many })).basis.length, 3);
  assert.equal(scoreConnection(sig("a", { jurisdiction_iso: ["DE"] }), sig("b", { jurisdiction_iso: ["DE"] })).score, 0);
  assert.equal(scoreConnection(sig("a", { jurisdiction_iso: ["DE"], topic_tags: ["x"] }), sig("b", { jurisdiction_iso: ["DE"], topic_tags: ["x"] })).score, 0.2);
});

test("scenario weight falls with tag frequency (idf), floor 0.25 of the weight", () => {
  const common = Array.from({ length: 40 }, (_, i) => sig(`c${i}`, { operational_scenario_tags: ["common"] }));
  const rare = [sig("r1", { operational_scenario_tags: ["rare"] }), sig("r2", { operational_scenario_tags: ["rare"] }), sig("r3", { operational_scenario_tags: ["rare"] })];
  const f = computeTagFrequencies([...common, ...rare]);
  const a = scoreConnection(sig("x", { operational_scenario_tags: ["common"] }), sig("y", { operational_scenario_tags: ["common"] }), f).basis[0]?.weight ?? 0;
  const b = scoreConnection(sig("x", { operational_scenario_tags: ["rare"] }), sig("y", { operational_scenario_tags: ["rare"] }), f).basis[0]?.weight ?? 0;
  assert.ok(a < b);
  assert.ok(a >= 0.3 * 0.25 - 1e-9);
});

test("discoverConnections: threshold 0.3, limit 12, cross-surface first", () => {
  const item = sig("a", { source_id: "s" });
  const same = sig("same", { source_id: "s" });
  const cross = sig("cross", { source_id: "s", item_type: "market_signal", domain: 2 });
  const weak = sig("weak", { jurisdiction_iso: ["DE"], topic_tags: ["x"] });
  const out = discoverConnections(item, [same, cross, weak]);
  assert.deepEqual(out.map((c) => c.target), ["cross", "same"]);
  assert.equal(out[0]?.crossSurface, true);
  const lots = Array.from({ length: 30 }, (_, i) => sig(`k${String(i).padStart(2, "0")}`, { source_id: "s" }));
  assert.equal(discoverConnections(item, lots).length, 12);
});

test("intersections: the AND rule (a shared scenario without a shared object is no pair) and the points 3/2/5/2", () => {
  const items = [
    { id: "a", operational_scenario_tags: ["s1", "s2"], compliance_object_tags: ["o1"], priority: "HIGH", related_items: ["b"] },
    { id: "b", operational_scenario_tags: ["s1", "s2"], compliance_object_tags: ["o1", "o2"], priority: "CRITICAL" },
    { id: "c", operational_scenario_tags: ["s1"], compliance_object_tags: ["o9"] },
    { id: "d", operational_scenario_tags: ["s1"], compliance_object_tags: ["shipper"] },
  ];
  const pairs = detectIntersections(items);
  assert.equal(pairs.length, 1, "c shares a scenario but no object; d shares only a role tag");
  assert.equal(pairs[0]?.strength, 3 * 2 + 2 + 5 + 2);
  assert.equal(pairs[0]?.tier, "strong");
});

test("intersections skip archived and unverified items", () => {
  const base = { operational_scenario_tags: ["s"], compliance_object_tags: ["o"] };
  assert.equal(detectIntersections([{ id: "a", ...base }, { id: "b", ...base, is_archived: true }, { id: "c", ...base, provenance_status: "draft" }]).length, 0);
});

test("clusterThemes: label propagation finds two components and is deterministic", () => {
  const nodes = ["a", "b", "c", "x", "y"].map((id) => ({ id, item_type: "regulation", domain: 1 }));
  const edges = [
    { source: "a", target: "b", score: 0.9 }, { source: "b", target: "c", score: 0.9 }, { source: "a", target: "c", score: 0.9 },
    { source: "x", target: "y", score: 0.8 },
  ];
  const r1 = clusterThemes(nodes, edges);
  const r2 = clusterThemes([...nodes].reverse(), [...edges].reverse());
  assert.deepEqual(r1.themes.map((t) => t.members).sort(), [["a", "b", "c"], ["x", "y"]]);
  assert.deepEqual(r1.themes.map((t) => [t.id, t.members]), r2.themes.map((t) => [t.id, t.members]));
});

test("diffThemes: persisted, split, merged, dissolved, appeared at the 0.5 overlap; lineage is derived from the delta", () => {
  const prior = [{ id: "P1", members: ["a", "b", "c", "d"] }, { id: "P2", members: ["x", "y"] }, { id: "P3", members: ["q"] }];
  const next = [{ id: "N1", members: ["a", "b", "c", "d", "e"] }, { id: "N2", members: ["x"] }, { id: "N3", members: ["z"] }];
  const d = diffThemes(prior, next);
  assert.equal(d.persisted.length + d.renamed.length >= 1, true);
  assert.deepEqual(d.dissolved, ["P3"]);
  assert.deepEqual(d.appeared, ["N3"]);
  assert.ok(lineageFromThemeDelta(d).some((l) => l.prior_id === "P1" && l.new_id === "N1"));
  const half = diffThemes([{ id: "H1", members: ["a", "b"] }], [{ id: "H2", members: ["a", "c"] }]);
  assert.equal(half.dissolved.length + half.appeared.length, 0, "a 0.5 overlap is the same theme");
  const same = diffThemes(next, next);
  assert.equal(same.dissolved.length + same.appeared.length + same.split.length + same.merged.length, 0, "an unchanged set has an empty delta");
});

test("member hash is order-independent; a brief is stale when the members move; convergence bands at 0.5 and 1.5", () => {
  assert.equal(computeMemberHash(["b", "a"]), computeMemberHash(["a", "b"]));
  assert.notEqual(computeMemberHash(["a"]), computeMemberHash(["a", "b"]));
  assert.equal(isBriefStale(computeMemberHash(["a", "b"]), ["b", "a"]), false);
  assert.equal(isBriefStale(computeMemberHash(["a"]), ["a", "b"]), true);
  assert.deepEqual([convergenceBand(0.4), convergenceBand(0.5), convergenceBand(1.5)], ["low", "medium", "high"]);
  const r = resolveBriefForTheme({ id: "T", member_ids: ["a", "b"] }, [{ theme_id: "T", member_hash: computeMemberHash(["a"]) } as never]);
  assert.equal(r.match, "exact");
  assert.equal(r.stale, true);
});
