// The wiring: every provider the turn builds satisfies the interface its consumer declared (the parallel-build bet: `npm run typecheck` proves the shapes, since buildDeps assigns each provider to its consumer's type), the
// startup check names an unwired required member (IMP-026) and the owed ones, and each adapter does what its interface says.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDeps, enforceWired, MANIFEST, SERVICE_MEMBER, startupCheck, wireAll, workspaceWiring } from "@/core/turn/wiring";
import { deriveKey } from "@/core/intake/canonical-key";

import { DOC_URL, fixture, NOW } from "../integration/world.ts";
import { MemDb } from "../_support/memdb.ts";

test("every wired member is present on the built deps, and the owed members are exactly the ones whose slices are not merged", () => {
  const f = fixture();
  const report = startupCheck(f.d);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.owed.map((o) => o.member).sort(), ["producers.verdicts (host verdicts as a table, IMP-054)", "propagation EdgeAuthors (authorCarbonIntensityEdges)", "workspace.portfolio"].sort());
  assert.ok(MANIFEST.filter((e) => e.status === "wired").length >= 30, "the manifest covers every provider-to-consumer member");
});

test("an unwired required member is named, and production refuses to serve with it (IMP-026)", () => {
  const f = fixture();
  (f.d.intake as unknown as { mint: unknown }).mint = {};
  (f.d.workspace as { itemHref?: unknown }).itemHref = undefined;
  const report = startupCheck(f.d);
  assert.deepEqual(report.missing.sort(), ["intake.mint.mintItem", "workspace.itemHref"]);
  assert.throws(() => enforceWired(report, { VERCEL: "1" }), /startup refused: required dependencies are not wired: intake\.mint\.mintItem, workspace.itemHref/);
  assert.doesNotThrow(() => enforceWired(report, { NODE_ENV: "production" }));
  assert.doesNotThrow(() => enforceWired({ missing: [] }, { VERCEL: "1" }));
});

test("the intake adapters: the canonical key from an identifier or a URL, institution equality that is never true for an empty key", () => {
  const f = fixture();
  assert.equal(f.d.identity.deriveKey("32023R9999", null), "32023R9999");
  assert.equal(f.d.identity.deriveKey(null, DOC_URL), "32023R9999");
  assert.equal(deriveKey("32019R0942(01)", null), "32019R0942(01)");
  assert.equal(deriveKey("eli/reg/2023/1805", null), "32023R1805");
  assert.equal(deriveKey(null, "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32023R9999%2801%29"), "32023R9999(01)");
  assert.equal(deriveKey("not an id", "https://example.test/x"), null);
  assert.equal(f.d.identity.sameInstitution("https://eur-lex.europa.eu/a", "https://eur-lex.europa.eu/b"), true);
  assert.equal(f.d.identity.sameInstitution("https://eur-lex.europa.eu/a", "https://example.test/b"), false);
  assert.equal(f.d.identity.sameInstitution("", ""), false);
});

test("registerAndRate through the sources dep is read-only in a dry run and reports the tier the host would get (IMP-042); in apply it registers", async () => {
  const f = fixture();
  const url = "https://www.europarl.europa.eu/doc/1";
  const before = f.db.rows("sources").length;
  f.d.context.current = null;
  const dry = await f.d.sources.registerAndRate(url);
  assert.equal(dry.sourceId, null);
  assert.equal(typeof dry.tier, "number");
  assert.equal(f.db.rows("sources").length, before);
  assert.equal(f.db.writes("sources").length, 0);
  f.d.context.current = { rootRunId: "x", upstreamRunId: null, mode: "apply", trigger: "dispatch", forcedDry: false, codeSha: null, githubRunId: null };
  const real = await f.d.sources.registerAndRate(url);
  assert.ok(real.sourceId);
  assert.equal(real.tier, dry.tier, "the dry tier is the tier the registration gave");
  assert.equal(f.db.rows("sources").length, before + 1);
  const refused = await f.d.sources.registerAndRate("https://github.com/x/y");
  assert.equal(refused.sourceId, null);
  assert.ok(refused.refused);
});

test("matchExistingSubject: the mint's seed is matched against the corpus by identifier and URL, and never against itself", () => {
  const f = fixture();
  const corpus = [{ id: "i1", title: "A", instrument_identifier: "2023/9999", source_url: "https://eur-lex.europa.eu/a" }, { id: "i2", title: "B", instrument_identifier: "2020/1", source_url: "https://eur-lex.europa.eu/b" }];
  assert.deepEqual(f.d.entities.matchExistingSubject({ title: "A", instrument_identifier: "2023/9999", source_url: "https://eur-lex.europa.eu/z" }, corpus).map((m) => m.id), ["i1"]);
  assert.deepEqual(f.d.entities.matchExistingSubject({ title: "C", source_url: "https://eur-lex.europa.eu/b" }, corpus).map((m) => m.id), ["i2"]);
  assert.deepEqual(f.d.entities.matchExistingSubject({ title: "Z" }, corpus), []);
});

test("navCounts: getNavCounts over the lists reads for the member's org and user; admin attention is the rpc's one row, and a failed read throws so the bootstrap names it degraded", async () => {
  const f = fixture();
  f.db.seed("user_watchlist", [{ user_id: "u1", item_id: "a0000000-0000-4000-8000-000000000001" }, { user_id: "u1", item_id: "a0000000-0000-4000-8000-000000000002" }, { user_id: "u2", item_id: "a0000000-0000-4000-8000-000000000001" }]);
  const wiring = workspaceWiring(f.db.client);
  const counts = (await wiring.navCounts?.({ orgId: "o1", userId: "u1" })) as { watchlist: number | null; regulations: number | null };
  assert.equal(counts.watchlist, 2, "the member's own watchlist, read for real");
  assert.equal(counts.regulations, null, "a surface count the database could not answer is null, never a zero");
  f.db.rpcs.admin_attention_counts = () => ({ data: [{ provisional_sources_pending: 3, total: 3 }] });
  assert.deepEqual(await wiring.adminAttention?.("u1"), { provisional_sources_pending: 3, total: 3 });
  f.db.rpcs.admin_attention_counts = () => ({ data: [] });
  await assert.rejects(Promise.resolve(wiring.adminAttention?.("u1")), /returned no row/);
  f.db.rpcs.admin_attention_counts = () => ({ error: { message: "denied" } });
  await assert.rejects(Promise.resolve(wiring.adminAttention?.("u1")), /admin_attention_counts failed: denied/);
});

test("the cache flush posts the tags to the app with the worker secret; unconfigured, it says so instead of reporting success", async () => {
  const calls: { url: string; secret: string | null; body: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => (calls.push({ url, secret: new Headers(init.headers).get("x-worker-secret"), body: JSON.parse(String(init.body)) }), new Response("{}", { status: 200 }))) as unknown as typeof fetch;
  const db = new MemDb().client;
  const armed = buildDeps(db, { NEXT_PUBLIC_APP_URL: "https://app.example.test", WORKER_SECRET: "s3cret" }, { now: () => NOW, fetchImpl });
  assert.deepEqual(await armed.mintRun.flushCache?.(["intel-items"]), { error: null });
  assert.deepEqual(calls, [{ url: "https://app.example.test/api/revalidate", secret: "s3cret", body: { tags: ["intel-items"] } }]);
  const bare = buildDeps(db, {}, { now: () => NOW, fetchImpl });
  assert.match(String((await bare.mintRun.flushCache?.(["x"]))?.error), /not configured/);
  const down = buildDeps(db, { NEXT_PUBLIC_APP_URL: "https://app.example.test", WORKER_SECRET: "s" }, { now: () => NOW, fetchImpl: (async () => new Response("", { status: 503 })) as unknown as typeof fetch });
  assert.match(String((await down.mintRun.flushCache?.(["x"]))?.error), /HTTP 503/);
});

test("the capture worker is the Edge Function invoked through the service client; its error is a 500 the capture stage reports", async () => {
  const db = Object.assign(Object.create(new MemDb()), { functions: { invoke: async (name: string, o: { body: unknown }) => (name === "capture-worker" ? { data: { processed: 0, results: [], echoed: o.body }, error: null } : { data: null, error: { message: "no" } }) } });
  const d = buildDeps(db, {}, { now: () => NOW });
  assert.deepEqual(await d.worker({ limit: 2 }), { status: 200, body: { processed: 0, results: [], echoed: { limit: 2 } } });
  const bad = buildDeps(Object.assign(Object.create(new MemDb()), { functions: { invoke: async () => ({ data: null, error: { message: "boom" } }) } }), {}, { now: () => NOW });
  assert.deepEqual(await bad.worker({ limit: 1 }), { status: 500, body: { error: "boom" } });
});

test("halted() is the kill switch as a dep member: true while an open fleet-budget-halt flag exists", async () => {
  const f = fixture();
  assert.equal(await f.d.halted(), false);
  f.db.seed("integrity_flags", [{ category: "budget", subject_type: "fleet", subject_ref: "fleet-budget-halt", status: "open", created_by: "operator", description: "halt" }]);
  assert.equal(await f.d.halted(), true);
});

test("wireAll builds from what the environment provides: no service key and not Vercel starts (nothing service-dependent wired); no service key on Vercel refuses and names the member", () => {
  const saved = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    assert.deepEqual(wireAll({ NODE_ENV: "production" }), { missing: [SERVICE_MEMBER], owed: [] });
    assert.throws(() => wireAll({ VERCEL: "1" }), /startup refused: required dependencies are not wired: service client \(no service key configured\)/);
  } finally {
    if (saved !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved;
  }
});

test("the production wiring carries the market slice's arithmetic by default (a Vercel start refuses an unwired producers.market)", () => {
  const d = buildDeps(new MemDb({}, {}).client, {}, { now: () => NOW });
  assert.notEqual(d.producers.market, null);
  assert.notEqual(d.marketMethods, null);
  assert.deepEqual(startupCheck(d).missing, []);
  assert.throws(() => enforceWired(startupCheck(buildDeps(new MemDb({}, {}).client, {}, { now: () => NOW, market: null })), { VERCEL: "1" }), /producers\.market/);
});
