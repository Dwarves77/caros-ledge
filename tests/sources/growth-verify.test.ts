// Source growth (INV-176 on every registration path, INV-179 on every edge) and candidate verification (a non-answer is never a rejection).
import assert from "node:assert/strict";
import { test } from "node:test";

import { verifyCandidate } from "@/features/sources/verify-candidate";
import { growSources } from "@/features/sources/growth";

import { memoryDb } from "../_support/memory-db.ts";

const NOW = () => new Date("2026-10-12T10:00:00Z");
const system = { id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false };
const prose = (n: number) => "The regulation requires operators to report greenhouse gas emissions under the scheme each year. ".repeat(n);
const page = (b: string) => new Response(`<html><body>${b}</body></html>`, { headers: { "content-type": "text/html" } });

test("growSources: connection, edges and credibility in one call; a dry run writes nothing", async () => {
  const brief = ["## New Sources Identified", "| EUR-Lex | https://eur-lex.europa.eu/x | 1 |"].join("\n");
  const seed = () => memoryDb({ sources: [{ id: "subject", url: "https://subject.example/", base_tier: 4, effective_tier: 4, tier_override: null, status: "active" }], source_citations: [] }, { unique: { source_citations: ["citing_source_id", "cited_source_id"] } });
  const w = seed();
  const out = await growSources({ db: w.db, now: NOW }, { citedSourceId: "subject", brief });
  assert.equal(out.counts.registered, 1);
  assert.equal(out.counts.citations_recorded, 1);
  assert.equal(w.tables.source_citations?.[0]?.cited_source_id, "subject");
  assert.equal(w.tables.sources?.find((s) => s.id === "subject")?.independent_citers, 1);
  const dry = seed();
  const dried = await growSources({ db: dry.db, now: NOW }, { citedSourceId: "subject", brief, dry: true });
  assert.equal(dried.counts.citations_recorded, 0);
  assert.equal(dry.writes.filter((x) => x.op !== "select").length, 0);
});

test("verification: an H candidate becomes a source at its CLASS tier, never a guessed one", async () => {
  const w = memoryDb({ system_state: [system], sources: [], provisional_sources: [], source_verifications: [] });
  const out = await verifyCandidate({ resolveHost: null, db: w.db, now: NOW, env: {}, sleep: async () => undefined, fetchImpl: (async () => page(prose(60))) as typeof fetch }, { url: "https://www.epa.gov/clean-air", name: "EPA Clean Air", verdict: { relevance: 90, freight: 80, rationale: "freight emissions rules" } });
  assert.equal(out.data?.tier, "H");
  assert.equal(out.data?.action, "auto-approved");
  assert.equal(w.tables.sources?.[0]?.base_tier, 2);
  assert.equal(w.tables.source_verifications?.length, 1);
});
test("verification: a non-answer is queued, only a 404 is rejected; a host the class table cannot place is never auto-approved", async () => {
  const run = (status: number | "throw", url = "https://www.epa.gov/p") => {
    const w = memoryDb({ system_state: [system], sources: [], provisional_sources: [], source_verifications: [] });
    const fetchImpl = (async () => {
      if (status === "throw") throw new Error("ECONNRESET");
      return new Response("x", { status });
    }) as typeof fetch;
    return verifyCandidate({ resolveHost: null, db: w.db, now: NOW, env: {}, sleep: async () => undefined, fetchImpl }, { url, name: "EPA" }).then((r) => ({ r, w }));
  };
  const dead = await run(404);
  assert.equal(dead.r.data?.action, "rejected");
  const walled = await run(403);
  assert.equal(walled.r.data?.action, "queued-provisional");
  assert.equal(walled.w.tables.provisional_sources?.length, 1);
  assert.equal(walled.w.tables.provisional_sources?.[0]?.provisional_tier, 7);
  assert.equal((await run("throw")).r.data?.action, "queued-provisional");
  const unplaced = memoryDb({ system_state: [system], sources: [], provisional_sources: [], source_verifications: [] });
  const out = await verifyCandidate({ resolveHost: null, db: unplaced.db, now: NOW, env: {}, sleep: async () => undefined, fetchImpl: (async () => page(prose(60))) as typeof fetch }, { url: "https://some-unknown-site.example/p", name: "", verdict: { relevance: 95, freight: 95, rationale: "x" } });
  assert.notEqual(out.data?.action, "auto-approved");
  assert.equal(unplaced.tables.sources?.length ?? 0, 0);
});
test("verification: the cadence-off hold refuses the probe, and a dry run writes nothing", async () => {
  const off = memoryDb({ system_state: [{ ...system, scrape_cadence: "off" }] });
  await assert.rejects(() => verifyCandidate({ resolveHost: null, db: off.db, now: NOW, env: {}, sleep: async () => undefined, fetchImpl: (async () => page("x")) as typeof fetch }, { url: "https://www.epa.gov/p", name: "EPA" }), /FETCH_HOLD_ENGAGED/);
  const dry = memoryDb({ system_state: [system], sources: [] });
  const out = await verifyCandidate({ resolveHost: null, db: dry.db, now: NOW, env: {}, sleep: async () => undefined, fetchImpl: (async () => page(prose(60))) as typeof fetch }, { url: "https://www.epa.gov/p", name: "EPA", dry: true, verdict: { relevance: 90, freight: 80, rationale: "x" } });
  assert.equal(out.data?.action, "auto-approved");
  assert.equal(dry.writes.filter((x) => x.op !== "select").length, 0);
});
