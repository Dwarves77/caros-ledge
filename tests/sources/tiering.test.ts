// INV-175 (grounding tier is base_tier only), INV-176 (deterministic class table, no default), INV-179 (citation edges), INV-073 (the override attack).
import assert from "node:assert/strict";
import { test } from "node:test";

import { classTierForHost, decidePoolHostRegistration, permanentlyUnregisteredClass } from "@/core/sources/host-class";
import { buildResolver, tierOfSource } from "@/core/sources/institution";
import { HOST_CLASS_TIER, TIER_WEIGHTS } from "@/core/sources/tier-contract";
import { decideEffectiveTier, planTierMovements, scoreCitationEdges, type TierMovementReaders } from "@/core/sources/tier-movement";
import { applyTierMovements, tierMovementWriters, writeEffectiveTierUnlessOverridden } from "@/core/sources/tier-writers";
import { aggregateConvergence, applyReputationRecompute, recordCitations } from "@/features/sources/growth";

import { memoryDb } from "../_support/memory-db.ts";

const NOW = new Date("2026-10-15T00:00:00Z");

test("INV-175: the grounding tier is base_tier, never effective_tier", () => {
  assert.equal(tierOfSource({ id: "a", url: "https://x.test", base_tier: 5, effective_tier: 1 }), 5);
  const r = buildResolver([{ id: "a", url: "https://www.agency.gov/p", base_tier: 5, effective_tier: 1 }]);
  assert.deepEqual(r.resolveSpan("https://www.agency.gov/other"), { tier: 5, sourceId: "a" });
});
test("INV-175: a suspended source is never selected", () => {
  const r = buildResolver([{ id: "a", url: "https://agency.gov/", base_tier: 2, status: "suspended" }]);
  assert.deepEqual(r.resolveSpan("https://agency.gov/x"), { tier: null, sourceId: null });
});
test("INV-175: an institution's subdomains share its tier; a super-domain subdomain is its own institution", () => {
  const r = buildResolver([
    { id: "a", url: "https://agency.gov/", base_tier: 2 },
    { id: "b", url: "https://www.environment.gov.uk/", base_tier: 2 },
    { id: "c", url: "https://www.treasury.gov.uk/", base_tier: 1 },
  ]);
  assert.equal(r.resolveSpan("https://sub.agency.gov/p").tier, 2);
  assert.equal(r.resolveSpan("https://environment.gov.uk/p").tier, 2);
  assert.equal(r.resolveSpan("https://treasury.gov.uk/p").tier, 1);
});
test("INV-175: an exact-host tier_override wins; rows of one institution that disagree are reported, not settled by order", () => {
  const rows = [
    { id: "a", url: "https://agency.gov/", base_tier: 2 },
    { id: "b", url: "https://data.agency.gov/", base_tier: 4, tier_override: 3 },
  ];
  const r = buildResolver(rows);
  assert.equal(r.resolveSpan("https://data.agency.gov/x").tier, 3);
  assert.equal(r.resolveSpan("https://agency.gov/x").tier, 2);
  assert.equal(r.disagreements.length, 1);
  assert.deepEqual(r.disagreements[0]?.tiers, [2, 4]);
  assert.deepEqual(buildResolver([...rows].reverse()).disagreements[0]?.tiers, [2, 4], "reported the same in either order");
});

test("INV-176: the class table names legal, government and intergovernmental hosts; an unknown host is null, never a default", () => {
  assert.equal(classTierForHost("eur-lex.europa.eu"), HOST_CLASS_TIER.legal);
  assert.equal(classTierForHost("www.epa.gov"), HOST_CLASS_TIER.gov);
  assert.equal(classTierForHost("www.oecd.org"), HOST_CLASS_TIER.intergov_analysis);
  assert.equal(classTierForHost("some-unknown-site.example"), null);
  assert.equal(classTierForHost(""), null);
  assert.equal(classTierForHost(null), null);
});
test("INV-176: an aggregator or hosting platform is never registered at any tier, whatever its name says", () => {
  for (const h of ["law.justia.com", "www.mondaq.com", "x.citizenspace.com"]) {
    assert.notEqual(permanentlyUnregisteredClass(h), null, h);
    assert.equal(classTierForHost(h, "A Legal Publisher"), null, h);
  }
});
test("INV-176: pool hosts inherit, register at the class tier, or go to the worklist with a null tier", () => {
  assert.deepEqual(decidePoolHostRegistration("anything.example", 3), { action: "inherit", tier: 3 });
  assert.deepEqual(decidePoolHostRegistration("eur-lex.europa.eu", null), { action: "register", tier: HOST_CLASS_TIER.legal });
  assert.deepEqual(decidePoolHostRegistration("some-unknown-site.example", null), { action: "worklist", tier: null });
  assert.deepEqual(decidePoolHostRegistration("law.justia.com", null), { action: "worklist", tier: null });
});

test("INV-179: a syndication group counts once, at its best tier", () => {
  const m = aggregateConvergence([
    { citer_source_id: "a", citer_tier: 5, syndication_group: "wire" },
    { citer_source_id: "b", citer_tier: 3, syndication_group: "wire" },
    { citer_source_id: "c", citer_tier: 4 },
  ]);
  assert.equal(m.independent_citers, 2);
  assert.equal(m.highest_citing_tier, 3);
  assert.equal(m.total_citations, 3);
});
test("INV-179: a T7 citer weighs zero", () => {
  assert.equal(TIER_WEIGHTS[7], 0);
  const edges = Array.from({ length: 12 }, (_, i) => ({ citing_source_id: `c${i}`, cited_source_id: "t", detected_at: NOW.toISOString() }));
  const sevens = scoreCitationEdges(edges, new Map(edges.map((e) => [e.citing_source_id, 7])), NOW.getTime());
  assert.equal(sevens.weighted_sum, 0);
  assert.equal(sevens.should_promote, false);
  const ones = scoreCitationEdges(edges, new Map(edges.map((e) => [e.citing_source_id, 1])), NOW.getTime());
  assert.ok(ones.weighted_sum > 0);
});
test("INV-179: an edge is unique per pair and never a self-citation", async () => {
  const { db, tables } = memoryDb({}, { unique: { source_citations: ["citing_source_id", "cited_source_id"] } });
  const r = await recordCitations(db, [
    { citing_source_id: "a", cited_source_id: "b" },
    { citing_source_id: "a", cited_source_id: "b" },
    { citing_source_id: "a", cited_source_id: "a" },
    { citing_source_id: "c", cited_source_id: "b", syndication_group: "wire" },
  ]);
  assert.equal(r.recorded, 2);
  assert.deepEqual(r.errors, []);
  assert.equal(tables.source_citations?.length, 2);
  assert.equal(tables.source_citations?.some((e) => e.citing_source_id === e.cited_source_id), false);
});

// INV-073: the override attack. Every automatic tier writer leaves tier_override alone.
const sourceRow = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, url: `https://${id}.example/`, base_tier: 4, effective_tier: 4, tier_override: null, status: "active", processing_paused: false, created_at: "2025-01-01T00:00:00Z", last_substantive_change: NOW.toISOString(), update_frequency: "daily", ...over });
const CITERS = ["x1", "x2", "x3", "x4", "x5", "x6"];

test("INV-073: the guarded write matches nothing on an overridden row and changes nothing", async () => {
  const { db, tables } = memoryDb({ sources: [sourceRow("ctl"), sourceRow("ovr", { tier_override: 2, effective_tier: 2 })] });
  assert.deepEqual(await writeEffectiveTierUnlessOverridden(db, "ovr", 6), { written: false, error: null });
  assert.equal(tables.sources?.find((r) => r.id === "ovr")?.effective_tier, 2);
  assert.deepEqual(await writeEffectiveTierUnlessOverridden(db, "ctl", 3), { written: true, error: null });
  assert.equal(tables.sources?.find((r) => r.id === "ctl")?.effective_tier, 3);
});
test("INV-073: a database error on the write is an error, never read as not written", async () => {
  const { db } = memoryDb({ sources: [sourceRow("ctl")] }, { failures: [{ table: "sources", op: "update", message: "boom" }] });
  const r = await writeEffectiveTierUnlessOverridden(db, "ctl", 3);
  assert.equal(r.written, false);
  assert.equal(r.error?.message, "boom");
});
test("INV-073: the decision holds the override and reports no change", () => {
  const d = decideEffectiveTier({ base_tier: 4, effective_tier: 2, tier_override: 2, evidence: { citation_promote: true, citation_reasoning: "x", promotion: null, demotion: null, opinion: { delta: -1, counted: 3, distinct_opiners: 3, median: 3, reason: "r" } as never } });
  assert.equal(d.after_tier, 2);
  assert.equal(d.changed, false);
  assert.equal(d.override_held, true);
});
test("INV-073: the plan-and-apply run moves the control source and leaves the overridden one, even against a forged movement", async () => {
  const cites = (cited: string) => CITERS.map((c) => ({ citing_source_id: c, cited_source_id: cited, detected_at: NOW.toISOString() }));
  const sources = [sourceRow("ctl"), sourceRow("ovr", { tier_override: 6, effective_tier: 6 }), ...CITERS.map((c) => sourceRow(c, { base_tier: 1, effective_tier: 1 }))];
  const { db, tables, wrote } = memoryDb({ sources });
  const readers: TierMovementReaders = { readSources: async () => sources as never, readOpinions: async () => [], readCitations: async () => [...cites("ctl"), ...cites("ovr")] };
  const plan = await planTierMovements(readers, { now: NOW, scrapeCadence: "off" });
  assert.ok(plan.movements.some((m) => m.source_id === "ctl"), "control source moves");
  assert.equal(plan.movements.some((m) => m.source_id === "ovr"), false, "overridden source is not planned");
  const first = plan.movements[0] as NonNullable<(typeof plan.movements)[number]>;
  const forged = [...plan.movements, { source_id: "ovr", name: "ovr", decision: { ...first.decision, before_tier: 6, after_tier: 3 } }];
  const res = await applyTierMovements(forged as never, tierMovementWriters(db));
  assert.equal(res.override_skipped, 1);
  assert.equal(tables.sources?.find((r) => r.id === "ovr")?.effective_tier, 6);
  assert.notEqual(tables.sources?.find((r) => r.id === "ctl")?.effective_tier, 4);
  assert.equal(wrote("source_trust_events", "insert").length, res.applied, "no audit event for a refused write");
});
test("INV-073: the reputation recompute leaves an overridden source alone", async () => {
  const citers = CITERS.map((c) => sourceRow(c, { base_tier: 1, effective_tier: 1 }));
  const edges = citers.map((c) => ({ id: c.id, citing_source_id: c.id, cited_source_id: "ovr", detected_at: NOW.toISOString(), context: "brief-citation" }));
  const { db, tables, wrote } = memoryDb({ sources: [sourceRow("ovr", { tier_override: 6, effective_tier: 6 }), ...citers], source_citations: edges });
  const r = await applyReputationRecompute(db, "ovr", NOW);
  assert.equal(r.error, null);
  assert.equal(r.changed, false);
  assert.equal(tables.sources?.find((s) => s.id === "ovr")?.effective_tier, 6);
  assert.equal(wrote("sources", "update").length, 0);
});
