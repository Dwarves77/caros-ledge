// R2c C6 and C8: the registry identity (INV-R2c-9: two institutions on one host are two rows with their own tiers), one birth function with named profiles, no overwriting of a stored role, duplicate detection by page equality,
// and the rights verdict with the quotation rule.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { REUSE_TERMS, reuseTermsForHost } from "@/core/sources/reuse-terms";
import { backfillInstitutionKeys, pickInstitutionRow, readSourceByUrl, registerAndRate, registerSource } from "@/core/sources/register";
import { classifySources } from "@/features/sources/classify-sources";
import { verifyCandidate } from "@/features/sources/verify-candidate";
import { classifySourceRole } from "@/core/sources/classify";

import { memoryDb } from "../_support/memory-db.ts";
import { routed } from "../_support/net.ts";

const system = { id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false };

test("INV-R2c-9: a URL of institution B on a shared portal host gets B's own row and tier, never institution A's", async () => {
  // gob.mx is a shared portal (keyDepth 1): /semarnat and /economia are two institutions. A is on record at tier 5; B has no row.
  const w = memoryDb({ sources: [{ id: "a", url: "https://www.gob.mx/semarnat/documentos/x", base_tier: 5, tier_override: null, status: "active", institution_key: "gob.mx/semarnat" }], institutions: [] });
  const b = await registerAndRate(w.db, "https://www.gob.mx/economia/documentos/y", { name: "Secretaria de Economia" });
  assert.equal(b.status, "registered", "B is not A");
  assert.ok("tier" in b && b.tier === 2, "B takes the class tier, not A's 5");
  assert.equal(w.tables.sources?.length, 2);
  assert.notEqual("source_id" in b ? b.source_id : null, "a");
  const again = await registerAndRate(w.db, "https://www.gob.mx/semarnat/otro");
  assert.deepEqual(["source_id" in again ? again.source_id : null, "tier" in again ? again.tier : null], ["a", 5], "A's own URL still resolves to A");
  const key = w.tables.sources?.find((s) => s.id !== "a")?.institution_key;
  assert.equal(key, "gob.mx/economia");
});
test("two workers registering one institution make one row: the registry is keyed by the database, not by a read-then-insert", async () => {
  const w = memoryDb({});
  const [x, y] = await Promise.all([registerSource(w.db, { url: "https://www.epa.gov/rules", base_tier: 2 }), registerSource(w.db, { url: "https://www.epa.gov/other", base_tier: 2 })]);
  assert.equal(w.tables.sources?.length, 1);
  assert.equal(x.source_id, y.source_id);
  assert.deepEqual([x.created, y.created].sort(), [false, true]);
  assert.equal(w.tables.sources?.[0]?.institution_key, "epa.gov");
  assert.equal(w.mem.rpcCalls.filter((c) => c.name === "register_source_once").length >= 1, true);
});
test("one registerSource with named profiles: class, growth, candidate and promoted differ only in their values, and every row carries the rights verdict of its host", async () => {
  const w = memoryDb({});
  const cls = await registerSource(w.db, { url: "https://www.federalregister.gov/x", base_tier: 1 });
  const growth = await registerSource(w.db, { url: "https://eur-lex.europa.eu/a?uri=CELEX:1", base_tier: 1, profile: "growth" });
  const cand = await registerSource(w.db, { url: "https://www.epa.gov/clean-air", base_tier: 2, profile: "candidate", extra: { description: "d", jurisdictions: ["US"] } });
  const row = (id: string) => w.tables.sources?.find((s) => s.id === id);
  assert.equal(row(cls.source_id)?.status, "active");
  assert.equal(row(growth.source_id)?.status, "provisional");
  assert.equal(row(growth.source_id)?.auto_run_enabled, false);
  assert.equal(row(cand.source_id)?.access_method, "scrape");
  assert.equal(row(cand.source_id)?.update_frequency, "weekly", "the column default, not a constant stamped by the candidate path");
  assert.deepEqual(row(cand.source_id)?.domains, [], "no domain is invented for an approved candidate");
  assert.deepEqual([row(cls.source_id)?.reuse_terms, row(growth.source_id)?.reuse_terms, row(cand.source_id)?.reuse_terms], ["public_domain", "eu_reuse", "unknown"]);
  // A page profile is keyed by its page: a second page of the same host is its own row; the same page is the same row.
  const second = await registerSource(w.db, { url: "https://eur-lex.europa.eu/a?uri=CELEX:2", base_tier: 1, profile: "growth" });
  const same = await registerSource(w.db, { url: "https://eur-lex.europa.eu/a?uri=CELEX:1", base_tier: 1, profile: "growth" });
  assert.notEqual(second.source_id, growth.source_id);
  assert.equal(same.source_id, growth.source_id);
  await assert.rejects(() => registerSource(w.db, { url: "https://x.gov", base_tier: 0 }), /not a tier/);
});
test("a legacy row born before the key existed is found by its url or institution, not duplicated, and a non-active row is reactivated", async () => {
  const w = memoryDb({ sources: [{ id: "old", url: "https://www.epa.gov/", base_tier: 2, status: "suspended", institution_key: null }] });
  const r = await registerSource(w.db, { url: "https://www.epa.gov/new-page", base_tier: 2 });
  assert.deepEqual([r.source_id, r.created], ["old", false]);
  assert.equal(w.tables.sources?.[0]?.status, "active");
  assert.equal(w.tables.sources?.length, 1);
});

test("keys for the registry that has none: the oldest row of an institution takes the institution key, the rest their page keys, a repeated page is a conflict left unkeyed", async () => {
  const rows = [
    { id: "3", url: "https://eur-lex.europa.eu/a?uri=CELEX:3", created_at: "2026-03-01" },
    { id: "1", url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:1", created_at: "2026-01-01" },
    { id: "2", url: "https://eur-lex.europa.eu/a?uri=CELEX:2", created_at: "2026-02-01" },
    { id: "4", url: "https://eur-lex.europa.eu/a?uri=CELEX:2", created_at: "2026-04-01" },
  ];
  const w = memoryDb({ sources: rows.map((r) => ({ ...r, base_tier: 1, institution_key: null })) });
  const out = await backfillInstitutionKeys(w.db, rows);
  assert.deepEqual([out.keyed, out.conflicts, out.errors], [3, 1, []]);
  const key = (id: string) => w.tables.sources?.find((s) => s.id === id)?.institution_key;
  assert.deepEqual(["1", "2", "3", "4"].map(key), ["eur-lex.europa.eu", "eur-lex.europa.eu/a?uri=celex:2", "eur-lex.europa.eu/a?uri=celex:3", null]);
});
test("classify-sources never overwrites a stored role; it fills a NULL once, and sets the rights verdict where the class fixes it", async () => {
  const name = "International Maritime Organization";
  assert.ok(classifySourceRole(name, "https://www.imo.org/"));
  const w = memoryDb({
    sources: [
      { id: "kept", name, url: "https://www.imo.org/", source_role: "operator_set_role", source_type: ["regulator"], jurisdiction_iso: [], scope_topics: [], scope_modes: [], scope_verticals: [], expected_output: null, created_at: "2026-01-01", institution_key: null, reuse_terms: "unknown" },
      { id: "empty", name, url: "https://www.imo.org/en", source_role: null, source_type: ["regulator"], jurisdiction_iso: [], scope_topics: [], scope_modes: [], scope_verticals: [], expected_output: null, created_at: "2026-01-02", institution_key: null, reuse_terms: "unknown" },
      { id: "eu", name: "EUR-Lex", url: "https://eur-lex.europa.eu/x", source_role: "primary_legal_authority", source_type: ["regulator"], jurisdiction_iso: [], scope_topics: [], scope_modes: [], scope_verticals: [], expected_output: null, created_at: "2026-01-03", institution_key: null, reuse_terms: "unknown" },
    ],
  });
  const r = await classifySources({ db: w.db, now: () => new Date("2026-10-19T00:00:00Z"), surfaceOf: () => "regulations" });
  assert.equal(w.tables.sources?.find((s) => s.id === "kept")?.source_role, "operator_set_role");
  assert.notEqual(w.tables.sources?.find((s) => s.id === "empty")?.source_role, null);
  assert.equal(w.tables.sources?.find((s) => s.id === "eu")?.reuse_terms, "eu_reuse");
  assert.equal(w.tables.sources?.find((s) => s.id === "kept")?.reuse_terms, "unknown", "a host the class table does not fix stays unknown");
  assert.equal(r.counts.institution_keys_set, 3, "the first imo.org row takes the institution key, the second its page key, the eur-lex row its institution key");
});

test("duplicate detection is by registrable domain and page equality: /regulation-2 is not a duplicate of /regulation, a trailing slash is", async () => {
  const run = (url: string) => {
    const w = memoryDb({ system_state: [system], sources: [{ id: "reg", url: "https://www.example-agency.gov/regulation", base_tier: 2, status: "active" }], provisional_sources: [], source_verifications: [] });
    const net = routed(async () => new Response(`<html><body>${"The regulation requires operators to report emissions each year. ".repeat(40)}</body></html>`, { headers: { "content-type": "text/html" } }));
    return verifyCandidate({ db: w.db, now: () => new Date("2026-10-12T10:00:00Z"), env: {}, fetchImpl: net.fetch, sleep: async () => undefined, resolveHost: async () => ["93.184.216.34"] }, { url, name: "Example Agency", dry: true }).then((r) => r.data);
  };
  assert.equal((await run("https://example-agency.gov/regulation-2"))?.rejection_reason === "duplicate", false);
  assert.equal((await run("https://example-agency.gov/regulation/"))?.rejection_reason, "duplicate");
  assert.equal((await run("https://www.example-agency.gov/regulation"))?.rejection_reason, "duplicate");
});

test("the rights verdict: the class fixes it only where a terms page was read, everything else is unknown", () => {
  assert.deepEqual(["https://eur-lex.europa.eu/x", "https://www.legislation.gov.uk/x", "https://www.federalregister.gov/x", "https://www.michigan.gov/x", "https://www.reuters.com/x"].map(reuseTermsForHost), ["eu_reuse", "open_government", "public_domain", "unknown", "unknown"]);
});

test("pickInstitutionRow: the row at the same page, else the row of the same institution, never the first row of the host", () => {
  const rows = [{ url: "https://www.gob.mx/semarnat/documentos/x", id: "a" }, { url: "https://www.gob.mx/economia/documentos/y", id: "b" }];
  assert.equal(pickInstitutionRow(rows, "https://www.gob.mx/economia/documentos/y")?.id, "b");
  assert.equal(pickInstitutionRow(rows, "https://www.gob.mx/economia/otro")?.id, "b", "the same institution, another page");
  assert.equal(pickInstitutionRow(rows, "https://www.gob.mx/shcp/documentos/z"), null, "a third institution on the host has no row yet");
});

test("the rights vocabulary in code is the vocabulary the database accepts, and the class table only ever names a member of it", () => {
  const sql = readFileSync("supabase/migrations/0080_collection_state.sql", "utf8");
  const list = /sources_reuse_terms_check CHECK \(reuse_terms = ANY \(ARRAY\[([^\]]*)\]/.exec(sql)?.[1]?.match(/'([a-z_]+)'/g)?.map((x) => x.slice(1, -1));
  assert.deepEqual([...REUSE_TERMS], list);
  for (const url of ["https://eur-lex.europa.eu/x", "https://www.legislation.gov.uk/x", "https://www.federalregister.gov/x", "https://unknown-publisher.example/x"]) assert.ok(REUSE_TERMS.includes(reuseTermsForHost(url)), url);
  assert.equal(reuseTermsForHost("https://unknown-publisher.example/x"), "unknown");
});

test("the read a surface makes of the registry names no column that migrations 0080 and 0081 add, so a page renders before they are applied", async () => {
  const asked: string[] = [];
  const chain = { or: () => chain, limit: async () => ({ data: [], error: null }) };
  const db = { from: () => ({ select: (cols: string) => (asked.push(cols), chain) }) };
  assert.equal(await readSourceByUrl(db as never, "https://www.epa.gov/rules"), null);
  assert.ok(asked.length > 0);
  assert.doesNotMatch(asked.join(","), /institution_key|reuse_terms|collection_state|collection_detail|access_requested_at|access_contact|publisher_locale/);
});

const ADDED_BY_0080_0081 = /\b(institution_key|reuse_terms|collection_state|collection_detail|access_requested_at|access_contact|publisher_locale|number_locale|content_hash|capture_channel)\b/;
/** The files that may name a column 0080 or 0081 adds: the writers and the runner jobs, which run after the migrations are applied. A page or an API route that reads names none of them. */
const MAY_NAME_THEM: Record<string, string> = {
  "src/core/sources/register.ts": "registerSource and the key backfill write the identity column through register_source_once",
  "src/core/sources/reuse-terms.ts": "a comment naming the column the verdict is stored in",
  "src/core/fetch/store-capture.ts": "the capture writer shared by the Edge Function and the runner job",
  "src/features/sources/classify-sources.ts": "the classify job keys rows and sets the rights verdict",
  "src/features/sources/collect.ts": "the runner job that finishes the ladder and records the state",
  "src/features/sources/snapshots.ts": "raw_fetches.content_hash, an older table",
  "src/core/capture/change-detection.ts": "a note inside a trust event, not a column",
};
const sourceFiles = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? sourceFiles(join(dir, n)) : /\.(ts|tsx)$/.test(n) ? [join(dir, n).replace(/\\/g, "/")] : []));

test("no page or API read names a column that migrations 0080 and 0081 add: only the writers and the runner jobs do", () => {
  const offenders = sourceFiles("src").filter((f) => ADDED_BY_0080_0081.test(readFileSync(f, "utf8")) && !(f in MAY_NAME_THEM));
  assert.deepEqual(offenders, []);
  for (const f of Object.keys(MAY_NAME_THEM)) assert.ok(ADDED_BY_0080_0081.test(readFileSync(f, "utf8")), `${f} no longer names one: delete its entry`);
});
