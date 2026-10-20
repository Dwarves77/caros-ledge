// INV-175 (grounding tier is base_tier only), INV-176 (deterministic class table, no default), INV-179 (citation edges), INV-073 (the override attack).
import assert from "node:assert/strict";
import { test } from "node:test";

import { classTierForHost, permanentlyUnregisteredClass } from "@/core/sources/host-class";
import { buildResolver } from "@/core/sources/institution";
import { HOST_CLASS_TIER } from "@/core/sources/tier-contract";
import { writeEffectiveTierUnlessOverridden } from "@/core/sources/tier-writers";

import { memoryDb } from "../_support/memory-db.ts";

const NOW = new Date("2026-10-15T00:00:00Z");

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

// INV-073: the override attack. Every automatic tier writer leaves tier_override alone.
const sourceRow = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, url: `https://${id}.example/`, base_tier: 4, effective_tier: 4, tier_override: null, status: "active", processing_paused: false, created_at: "2025-01-01T00:00:00Z", last_substantive_change: NOW.toISOString(), update_frequency: "daily", ...over });

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

