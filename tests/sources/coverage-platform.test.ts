// INV-036 (coverage gaps decided by rule), INV-134 (the pause flags have one writer: nothing in this lane writes them), gate-a, census, platform plumbing.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { fallbackGuard } from "@/core/cache";
import { isFallbackPayload } from "@/core/cache/fallback-guard";
import { INTEL_ITEMS_TAG, itemTag } from "@/core/cache/tags";
import { buildCoverageMatrix, ALL, parseCoverageQuery, surfaceDenominator, matrixToCsv, formatDenominatorLine, UNTAGGED } from "@/core/coverage/matrix";
import { recordCoverageRequest, validateCoverageRequest } from "@/core/coverage/request";
import { describeCoverageState } from "@/core/coverage/state";
import { classifyIdentifier } from "@/core/census";
import { readGateAHealth } from "@/core/health/gate-a";
import { timePhase, withServerTiming } from "@/core/perf";
import { evaluateSurface, overallOk, seedLeak } from "@/core/telemetry/surface-health";
import { loadCoverage } from "@/features/coverage/server/census";
import { makeCoverageData } from "@/features/coverage/server/matrix-data";

import { memoryDb } from "../_support/memory-db.ts";

const NOW = "2026-10-15T10:00:00.000Z";
const entry = (over: Record<string, unknown> = {}) => ({ jurisdiction: "EU", surfaces: ["regulations"], relevance: "firm", identity: "verified", modes: ["air"], checkedAt: NOW, ...over });

// INV-036
test("INV-036: the numerator is decided by rule: firm-core relevance AND a verified identity, nothing else", () => {
  const numerators = (relevance: string, identity: string) => buildCoverageMatrix([entry({ relevance, identity })], { generatedAt: NOW }).totals.numerator;
  assert.equal(numerators("firm", "verified"), 1);
  for (const [relevance, identity] of [["soft", "verified"], ["firm", "pending"], ["firm", "unresolved"], ["firm", "dead"]] as const) assert.equal(numerators(relevance, identity), 0, `${relevance}/${identity}`);
  const m = buildCoverageMatrix([entry(), entry({ identity: "pending" }), entry({ relevance: "soft" })], { generatedAt: NOW });
  assert.deepEqual(m.totals, { numerator: 1, denominator: 3 });
  const cell = m.cells.find((c) => c.key === `${ALL}|regulations|EU`);
  assert.deepEqual({ n: cell?.numerator, d: cell?.denominator }, { n: 1, d: 3 });
});
test("INV-036: an untagged mode, surface or geography is counted in its own bucket, never dropped or guessed", () => {
  const m = buildCoverageMatrix([entry({ modes: [], surfaces: [], jurisdiction: null })], { generatedAt: NOW });
  assert.equal(m.modes[0]?.code, UNTAGGED);
  assert.equal(m.dataClasses[0]?.code, UNTAGGED);
  assert.equal(m.geographies[0]?.code, "UNKNOWN");
  assert.deepEqual(m.modeTagging, { tagged: 0, total: 1 });
});
test("INV-036: the matrix is deterministic, its clock is injected, and a bad clock is refused", () => {
  const a = buildCoverageMatrix([entry(), entry({ jurisdiction: "GB" })], { generatedAt: NOW });
  const b = buildCoverageMatrix([entry({ jurisdiction: "GB" }), entry()], { generatedAt: NOW });
  assert.equal(a.version, b.version);
  assert.throws(() => buildCoverageMatrix([], { generatedAt: "not a date" }), /generatedAt/);
  assert.match(matrixToCsv(a, {}), /Regulations/);
});
test("INV-036: a pipe in a jurisdiction code cannot corrupt a cell key", () => {
  const m = buildCoverageMatrix([entry({ jurisdiction: "A|B" })], { generatedAt: NOW });
  assert.ok(m.cells.every((c) => c.key.split("|").length === 3));
});
test("coverage query params parse defensively; the denominator line states both figures", () => {
  assert.deepEqual(Object.keys(parseCoverageQuery({ data_class: ["a", "b"], mode: 5 })).sort(), Object.keys(parseCoverageQuery({})).sort());
  const d = surfaceDenominator("regulations", { total: 1200, dualVerified: 300, verifiedBriefs: 4 });
  assert.match(formatDenominatorLine(d!), /300 of 1,200/);
  assert.equal(surfaceDenominator("community", { total: 1 }), null);
  assert.equal(surfaceDenominator("regulations", null), null);
});

test("INV-036: a coverage request is validated to a site path and a label, and one open flag exists per path (INV-163)", async () => {
  assert.equal(validateCoverageRequest({ subjectRef: "/dashboard/coverage?data_class=research", label: "  Research   gaps " }).ok, true);
  for (const bad of ["//evil.test", "https://evil.test/x", "/a/../b", "dashboard", "", "/" + "a".repeat(250)]) assert.equal(validateCoverageRequest({ subjectRef: bad, label: "x" }).ok, false, bad);
  assert.equal(validateCoverageRequest({ subjectRef: "/x", label: "" }).ok, false);
  assert.equal(validateCoverageRequest({ subjectRef: "/x", label: "y".repeat(121) }).ok, false);
  const w = memoryDb();
  assert.deepEqual(await recordCoverageRequest(w.db, { subjectRef: "/x", label: "L" }), { ok: true, already: false });
  assert.deepEqual(await recordCoverageRequest(w.db, { subjectRef: "/x", label: "L" }), { ok: true, already: true });
  assert.equal(w.tables.integrity_flags?.length, 1);
  assert.equal(w.tables.integrity_flags?.[0]?.created_by, "coverage-request-route");
  assert.equal(w.tables.integrity_flags?.[0]?.status, "open");
  const down = memoryDb({}, { failures: [{ table: "integrity_flags", op: "select", message: "down" }] });
  assert.equal((await recordCoverageRequest(down.db, { subjectRef: "/x", label: "L" })).ok, false);
  const dup = memoryDb({}, { failures: [{ table: "integrity_flags", op: "insert", message: "dup", code: "23505" }] });
  assert.deepEqual(await recordCoverageRequest(dup.db, { subjectRef: "/y", label: "L" }), { ok: true, already: true });
});
test("the six states of absence each have a treatment; an unknown state has none", () => {
  for (const state of ["not_applicable", "not_covered", "no_data_yet", "suppressed", "unavailable", "stale"]) {
    const t = describeCoverageState({ state, subject: "Rate" });
    if (t) assert.ok(t.headline.length > 0, state);
  }
  assert.equal(describeCoverageState({ state: "nonsense", subject: "x" }), null);
  assert.equal(describeCoverageState(null), null);
  assert.equal(describeCoverageState({ state: "not_applicable", subject: "x" })?.suppress, true);
  assert.deepEqual(describeCoverageState({ state: "not_covered", subject: "Rate", requestRef: "/x" })?.actions.map((a) => a.kind), ["request"]);
});

const census = (id: string, over: Record<string, unknown> = {}) => ({ id, document_url: `https://x.test/${id}`, instrument_identifier: id, title: `T ${id}`, source_id: "s1", shape_class: "law", surface_tags: ["regulations"], notes: "type=regulation", identity_checked_at: NOW, identity_resolves: true, identity_scheme: "celex", identity_shape_valid: true, identity_host_registered: true, dryrun_disposition: "would_mint", sources: { jurisdiction_iso: ["eu"], transport_modes: ["air"] }, ...over });
test("census: identity is verified only with a resolve AND a registered host; pending is not dead", async () => {
  const w = memoryDb({
    census_worklist: [census("a"), census("b", { identity_host_registered: false }), census("c", { identity_resolves: false }), census("d", { identity_checked_at: null, identity_resolves: null }), census("e", { dryrun_disposition: "skip" }), census("f", { notes: "type=regulation [low-relevance]" })],
    intelligence_items: [{ id: "i1", provenance_status: "verified", full_brief: "x" }, { id: "i2", provenance_status: "verified", full_brief: null }],
  });
  const { entries, counts } = await loadCoverage(w.db);
  assert.equal(counts.total, 5, "only would_mint rows");
  assert.deepEqual({ v: counts.identityVerified, u: counts.identityUnresolved, dead: counts.identityDead, p: counts.identityPending }, { v: 2, u: 1, dead: 1, p: 1 });
  assert.equal(counts.dualVerified, 1);
  assert.equal(counts.softTail, 1);
  assert.equal(counts.verifiedBriefs, 1);
  assert.equal(entries[0]?.id, "a", "dual-verified firm-core first");
  assert.equal(entries[0]?.jurisdiction, "EU");
});
test("census: an outage is an error state with no counts, never an empty index that reads as zero coverage", async () => {
  const bad = memoryDb({}, { failures: [{ table: "census_worklist", op: "select", message: "down" }] });
  await assert.rejects(() => loadCoverage(bad.db), /down|census/i);
  const badCount = memoryDb({ census_worklist: [census("a")] }, { failures: [{ table: "intelligence_items", op: "select", message: "down" }] });
  await assert.rejects(() => loadCoverage(badCount.db), /down|intelligence_items/i, "a failed brief count must not publish 0 verified briefs");
  const data = (db: ReturnType<typeof memoryDb>["db"]) => makeCoverageData({ db: () => db, now: () => NOW, tag: "coverage" });
  const m = await data(bad.db).getCoverageMatrix();
  assert.match(m.error ?? "", /Coverage could not be read just now/);
  assert.equal(m.matrix.totals.denominator, 0);
  assert.match((await data(bad.db).getSurfaceDenominator("regulations")).error ?? "", /Coverage could not be read just now/);
  const good = memoryDb({ census_worklist: [census("a")], intelligence_items: [] });
  assert.equal((await data(good.db).getCoverageMatrix()).matrix.totals.numerator, 1);
});
test("identifier classification: known schemes are named and an unknown shape is not guessed", () => {
  assert.equal(classifyIdentifier("32023R0956").scheme, "celex");
  assert.equal(classifyIdentifier("not an identifier").shapeValid, false);
});

// Gate A
test("gate-a: an empty or stale cache is not_computed, an rpc error is unreadable, and neither is ever a bare zero", async () => {
  const now = new Date(NOW);
  const health = (r: { data?: unknown; error?: { message: string }; thrown?: string }) =>
    readGateAHealth({ rpc: async () => { if (r.thrown) throw new Error(r.thrown); return { data: r.data ?? null, error: r.error ?? null }; } } as never, now);
  assert.equal((await health({ data: { error: "gate_a_health cache empty: run refresh" } })).invariant_violations?.state, "not_computed");
  assert.equal((await health({ data: { error: "gate_a_health cache stale since 2026-10-15T08:00:00Z" } })).invariant_violations?.state, "not_computed");
  assert.equal((await health({ error: { message: "x" } })).invariant_violations?.state, "unreadable");
  assert.equal((await health({ thrown: "boom" })).invariant_violations?.state, "unreadable");
  assert.equal((await health({ data: [] })).invariant_violations?.state, "unreadable");
  const ok = await health({ data: { invariant_violations: 0, briefless_verified: 0, no_gatestate_verified: 0, verified_failing_revalidation: 0, verified_gen_ver_null_info: 3, computed_at: NOW } });
  assert.equal(ok.invariant_violations?.state, "computed");
  assert.equal((await health({ data: { invariant_violations: -1 } })).invariant_violations?.state, "unreadable");
  assert.equal((await readGateAHealth({ rpc: async () => { throw new Error("net"); } }, now)).briefless_verified?.state, "unreadable");
});
test("surface health: a must-have surface with no rows is down, a zero-legal one is not, and a probe error is never a zero", () => {
  assert.equal(evaluateSurface("dashboard", 0).ok, false);
  assert.equal(evaluateSurface("dashboard", 5).ok, true);
  assert.equal(evaluateSurface("community", 0).ok, true);
  assert.equal(evaluateSurface("dashboard", null, "rls").ok, false);
  assert.equal(overallOk({ a: { ok: true } }, { r: { ok: false } }), false);
  assert.equal(overallOk({ a: { ok: true } }, { r: { ok: true } }), true);
  assert.equal(seedLeak(0), true);
  assert.equal(seedLeak(3), false);
});

// Platform plumbing
test("cache: tags are derived, a fallback payload is never cacheable", async () => {
  assert.equal(itemTag("42"), "item:42");
  assert.equal(INTEL_ITEMS_TAG, "intel-items");
  assert.equal(isFallbackPayload({ _error: "down" }), true);
  assert.equal(isFallbackPayload({ rows: [] }), false);
  const guarded = fallbackGuard.refuse(async () => ({ _error: "down", rows: [] }));
  await assert.rejects(guarded, (e: unknown) => e instanceof Error && e.name === "FallbackNotCacheable");
  assert.deepEqual(await fallbackGuard.refuse(async () => ({ rows: [1] }))(), { rows: [1] });
  assert.deepEqual(await fallbackGuard.readThrough(async () => ({ _error: "down" })), { _error: "down" }, "a read-through returns the fallback to the caller, uncached");
});
test("perf: a timed phase returns its result and records even when it throws; the header carries the total and a cold or warm marker", async () => {
  assert.equal(await timePhase("listing_rpc", async () => "r"), "r");
  await assert.rejects(() => timePhase("a b;c", () => { throw new Error("phase failed"); }), /phase failed/);
  const h = withServerTiming(new Response("x")).headers.get("Server-Timing") ?? "";
  assert.match(h, /total;dur=\d+/);
  assert.match(h, /coldstart;desc="(cold|warm)"/);
});

// INV-134: the pause flags have exactly one writer, admin_set_pause_state(). Nothing this lane ships writes them.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
test("INV-134: no module in this lane writes system_state or the pause flags; they are read only", () => {
  const roots = ["src/core/sources", "src/core/fetch", "src/core/capture", "src/core/coverage", "src/core/health", "src/features/sources", "src/features/coverage", "src/features/health", "src/features/telemetry", "supabase/functions/capture-worker"];
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const text = readFileSync(file, "utf8");
      if (/from\(\s*["']system_state["']\s*\)\s*\.\s*(update|insert|upsert|delete)\b/.test(text)) offenders.push(`${file}: writes system_state`);
      if (/\b(scrape_cadence|global_processing_paused|scrape_start_date)\s*:\s*[^,}\n]*[,}]/.test(text.replace(/\.select\([^)]*\)/g, "")) && /\.(update|upsert)\(\s*\{[^}]*\b(scrape_cadence|global_processing_paused)\b/.test(text)) offenders.push(`${file}: updates a pause flag`);
    }
  }
  assert.deepEqual(offenders, []);
});
