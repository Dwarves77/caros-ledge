// Source growth (INV-176 on every registration path, INV-179 on every edge) and candidate verification (a non-answer is never a rejection).
import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregateTier, verifyCandidate } from "@/features/sources/verify-candidate";
import { growSources, parseNewSourcesFromBrief, partitionCitedByHost, recordTierOpinion, registerCitedSources } from "@/features/sources/growth";

import { memoryDb } from "../_support/memory-db.ts";

const NOW = () => new Date("2026-10-12T10:00:00Z");
const system = { id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false };
const prose = (n: number) => "The regulation requires operators to report greenhouse gas emissions under the scheme each year. ".repeat(n);
const page = (b: string) => new Response(`<html><body>${b}</body></html>`, { headers: { "content-type": "text/html" } });

test("registerCitedSources: an existing host resolves, a classifiable one registers at the CLASS tier, an unclassifiable one is worklisted with no tier, a blocked one is a candidate", async () => {
  const w = memoryDb({ sources: [{ id: "known", url: "https://www.epa.gov/", base_tier: 2, tier_override: null, status: "active" }], provisional_sources: [] }, { unique: { provisional_sources: ["url"] } });
  const out = await registerCitedSources(w.db, [
    { name: "EPA", url: "https://www.epa.gov/rules" },
    { name: "EUR-Lex", url: "https://eur-lex.europa.eu/x" },
    { name: "", url: "https://some-unknown-site.example/post" },
    { name: "Acme Logistics", url: "https://acme-co.example/post" },
    { name: "Walled", url: "https://walled.example/x", rejection_reason: "cloudflare_block" },
  ]);
  assert.deepEqual(out.map((o) => o.registered), ["existing", "new_source", "candidate", "new_source", "candidate"]);
  const inserted = w.tables.sources?.find((s) => String(s.url).includes("eur-lex"));
  assert.equal(inserted?.base_tier, 1);
  assert.equal(inserted?.status, "provisional");
  assert.equal(inserted?.auto_run_enabled, false);
  assert.equal(w.tables.sources?.some((s) => String(s.url).includes("some-unknown-site")), false, "no source is created at a guessed tier");
  assert.equal(w.tables.sources?.find((x) => String(x.url).includes("acme-co"))?.base_tier, 7, "a named company host takes the residue rule company tier");
  assert.equal(w.tables.provisional_sources?.length, 2);
});
test("registerCitedSources: a failed duplicate lookup registers nothing; an opinion is recorded only from an explicit estimate or the class table", async () => {
  const bad = memoryDb({}, { failures: [{ table: "sources", op: "select", message: "down" }] });
  const out = await registerCitedSources(bad.db, [{ name: "EPA", url: "https://www.epa.gov/rules" }]);
  assert.equal(out[0]?.registered, "lookup_failed");
  assert.equal(bad.wrote("sources", "insert").length, 0);
  const w = memoryDb({ sources: [{ id: "known", url: "https://www.epa.gov/", base_tier: 5, tier_override: null, status: "active" }, { id: "pinned", url: "https://www.sec.gov/", base_tier: 5, tier_override: 1, status: "active" }] });
  await registerCitedSources(w.db, [{ name: "EPA", url: "https://www.epa.gov/a", tier_estimate: 3 }, { name: "EPA", url: "https://www.epa.gov/b" }], { });
  assert.equal(w.tables.source_tier_opinions?.length, 1, "no estimate and no class option: no opinion");
  assert.equal(w.tables.source_tier_opinions?.[0]?.opined_tier, 3);
  const table = await registerCitedSources(w.db, [{ name: "EPA", url: "https://www.epa.gov/c" }, { name: "SEC", url: "https://www.sec.gov/c" }], { classTableOpinions: true });
  assert.equal(table[0]?.opinion_tier, 2, "the class table disagrees with base_tier 5");
  assert.equal(table[1]?.opinion_tier, null, "an overridden source takes no opinion");
  assert.equal(w.tables.source_tier_opinions?.[1]?.opinion_source, "host_class_table");
  const dry = memoryDb({ sources: [] });
  await registerCitedSources(dry.db, [{ name: "EUR-Lex", url: "https://eur-lex.europa.eu/x" }], { dry: true });
  assert.equal(dry.writes.filter((x) => x.op !== "select").length, 0);
  assert.equal((await recordTierOpinion(memoryDb({}, { failures: [{ table: "source_tier_opinions", op: "insert", message: "rls", code: "42501" }] }).db, { targetSourceId: "a", opinedTier: 3 })).ok, false);
});
test("the brief table: an explicit tier cell is the estimate, a missing one stays absent, a blocked row becomes a candidate", () => {
  const brief = ["## New Sources Identified", "| Source | URL | Tier |", "|---|---|---|", "| **EPA** | https://www.epa.gov/x | 2 |", "| Blog | https://blog.example/p | - |", "| Walled | https://walled.example/p blocked 403 | - |"].join("\n");
  const rows = parseNewSourcesFromBrief(brief);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.tier_estimate, 2);
  assert.equal("tier_estimate" in (rows[1] ?? {}), false);
  assert.equal(rows[2]?.rejection_reason, "cloudflare_block");
  assert.deepEqual(parseNewSourcesFromBrief("no table"), []);
});
test("the cited-host gate: only a host or institution the system already knows is allowed, so a run cannot license itself", () => {
  const { allowed, novel } = partitionCitedByHost([{ host: "a.gov", institution: "a.gov" }, { host: "b.a.gov", institution: "a.gov" }, { host: "new.example", institution: "new.example" }], new Set(["a.gov"]), new Set(["a.gov"]));
  assert.equal(allowed.length, 2);
  assert.equal(novel.length, 1);
});
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

test("verification: the conservative aggregate, any L trigger wins, a missing verdict or a non-English page is M, H needs both scores and a class host", () => {
  const base = { duplicate: false, duplicateLookupFailed: false, domain: "high" as const, language: "en", verdict: { relevance: 90, freight: 80, rationale: "x" }, offVertical: false };
  assert.equal(aggregateTier(base).tier, "H");
  assert.equal(aggregateTier({ ...base, duplicate: true }).tier, "L");
  assert.equal(aggregateTier({ ...base, offVertical: true }).tier, "L");
  assert.equal(aggregateTier({ ...base, verdict: { relevance: 30, freight: 90, rationale: "" } }).tier, "L");
  assert.equal(aggregateTier({ ...base, verdict: null }).tier, "M");
  assert.equal(aggregateTier({ ...base, language: "fr" }).tier, "M");
  assert.equal(aggregateTier({ ...base, domain: "low" }).tier, "M");
  assert.equal(aggregateTier({ ...base, domain: "medium" }).tier, "M");
  assert.equal(aggregateTier({ ...base, duplicateLookupFailed: true }).rejection_reason, "duplicate_lookup_failed");
});
test("verification: an H candidate becomes a source at its CLASS tier, never a guessed one", async () => {
  const w = memoryDb({ system_state: [system], sources: [], provisional_sources: [], source_verifications: [] });
  const out = await verifyCandidate({ db: w.db, now: NOW, env: {}, fetchImpl: (async () => page(prose(60))) as typeof fetch }, { url: "https://www.epa.gov/clean-air", name: "EPA Clean Air", verdict: { relevance: 90, freight: 80, rationale: "freight emissions rules" } });
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
    return verifyCandidate({ db: w.db, now: NOW, env: {}, fetchImpl }, { url, name: "EPA" }).then((r) => ({ r, w }));
  };
  const dead = await run(404);
  assert.equal(dead.r.data?.action, "rejected");
  const walled = await run(403);
  assert.equal(walled.r.data?.action, "queued-provisional");
  assert.equal(walled.w.tables.provisional_sources?.length, 1);
  assert.equal(walled.w.tables.provisional_sources?.[0]?.provisional_tier, 7);
  assert.equal((await run("throw")).r.data?.action, "queued-provisional");
  const unplaced = memoryDb({ system_state: [system], sources: [], provisional_sources: [], source_verifications: [] });
  const out = await verifyCandidate({ db: unplaced.db, now: NOW, env: {}, fetchImpl: (async () => page(prose(60))) as typeof fetch }, { url: "https://some-unknown-site.example/p", name: "", verdict: { relevance: 95, freight: 95, rationale: "x" } });
  assert.notEqual(out.data?.action, "auto-approved");
  assert.equal(unplaced.tables.sources?.length ?? 0, 0);
});
test("verification: the cadence-off hold refuses the probe, and a dry run writes nothing", async () => {
  const off = memoryDb({ system_state: [{ ...system, scrape_cadence: "off" }] });
  await assert.rejects(() => verifyCandidate({ db: off.db, now: NOW, env: {}, fetchImpl: (async () => page("x")) as typeof fetch }, { url: "https://www.epa.gov/p", name: "EPA" }), /FETCH_HOLD_ENGAGED/);
  const dry = memoryDb({ system_state: [system], sources: [] });
  const out = await verifyCandidate({ db: dry.db, now: NOW, env: {}, fetchImpl: (async () => page(prose(60))) as typeof fetch }, { url: "https://www.epa.gov/p", name: "EPA", dry: true, verdict: { relevance: 90, freight: 80, rationale: "x" } });
  assert.equal(out.data?.action, "auto-approved");
  assert.equal(dry.writes.filter((x) => x.op !== "select").length, 0);
});
