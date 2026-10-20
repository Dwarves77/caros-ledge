import assert from "node:assert/strict";
import { test } from "node:test";

import { GET } from "@/features/search/api/search";
import { MAX_RESULTS, runSearch } from "@/features/search/run-search";

import { MemDb } from "../_support/memdb.ts";
import { scriptWithRpc } from "../_support/personas-rpc.ts";
import { installWorkspaceReadRpcs } from "../_support/workspace-reads.ts";
import { call, E, matrix } from "../workspace/_world.ts";

const SRC = "a1000000-0000-4000-8000-000000000001";
const SRC_OVERRIDE = "a1000000-0000-4000-8000-000000000002";
const row = (id: string, over: Record<string, unknown> = {}) => ({ id, legacy_id: null, title: `Emissions rule ${id}`, summary: "", item_type: "regulation", domain: 1, priority: "HIGH", provenance_status: "verified", is_archived: false, source_id: SRC, jurisdictions: ["EU"], transport_modes: ["ocean"], category: "emissions", ...over });

function world(): MemDb {
  const db = new MemDb({}, {});
  db.seed("sources", [
    { id: SRC, name: "EUR-Lex", base_tier: 2, tier_override: null, effective_tier: null },
    { id: SRC_OVERRIDE, name: "Overridden", base_tier: 5, tier_override: 1, effective_tier: 5 },
  ]);
  db.seed("intelligence_items", [row("a0000000-0000-4000-8000-000000000001"), row("a0000000-0000-4000-8000-000000000002", { source_id: SRC_OVERRIDE }), row("a0000000-0000-4000-8000-000000000003", { provenance_status: "quarantined" }), row("a0000000-0000-4000-8000-000000000004", { is_archived: true }), row("a0000000-0000-4000-8000-000000000005", { source_id: null })]);
  return installWorkspaceReadRpcs(db);
}
const ids = (r: Awaited<ReturnType<typeof runSearch>>) => (r.ok ? r.rows.map((x) => (x as { id: string }).id.slice(-1)) : r);

test("runSearch: the ranked hits, best first, only items that pass the customer read gate, each with its source's customer tier", async () => {
  const db = world();
  const r = await runSearch(db.client, "emissions");
  assert.ok(r.ok);
  assert.deepEqual(ids(r), ["1", "2", "5"], "the unverified and the archived hit are gone; rank ties keep the id order");
  assert.deepEqual(r.ok && r.rows.map((x) => x.tier), [2, 1, null], "the effective rating: base, then the override, then none for an unsourced item");
});

test("runSearch re-applies the read gate on the re-fetch: even an rpc that returns every id can never widen what is shown (INV-125)", async () => {
  const db = world();
  db.rpcs.search_intelligence_items = () => ({ data: db.rows("intelligence_items").map((i) => ({ id: i.id, rank: 1 })) });
  assert.deepEqual(ids(await runSearch(db.client, "emissions")), ["1", "2", "5"]);
});

test("runSearch keeps the rpc's rank order and bounds the rows it asks for (1 to 20)", async () => {
  const db = world();
  db.rpcs.search_intelligence_items = () => ({ data: ["5", "1", "2"].map((n) => ({ id: `a0000000-0000-4000-8000-00000000000${n}`, rank: 1 })) });
  assert.deepEqual(ids(await runSearch(db.client, "emissions")), ["5", "1", "2"], "the order is the rpc's, not the table's");
  await runSearch(db.client, "emissions", { maxRows: 99 });
  await runSearch(db.client, "emissions", { maxRows: 0 });
  assert.deepEqual(db.rpcCalls.map((c) => c.args.max_rows), [MAX_RESULTS, MAX_RESULTS, 1]);
});

test("INV-263: a failed rpc or a failed re-fetch is a stated failure, never an empty list; no hit is a real empty result", async () => {
  const bad = world();
  bad.rpcs.search_intelligence_items = () => ({ error: { message: "rpc down" } });
  assert.deepEqual(await runSearch(bad.client, "emissions"), { ok: false, reason: "unavailable" }, "the driver's message goes to the log and never into the outcome (surfaces:81)");
  const refetch = world();
  refetch.fail("intelligence_items", "select", "rows down");
  assert.deepEqual(await runSearch(refetch.client, "emissions"), { ok: false, reason: "unavailable" });
  assert.deepEqual(await runSearch(world().client, "zzzz"), { ok: true, rows: [] });
});

test("persona matrix: /api/search answers every signed-in persona on their own client; an anonymous caller is refused", async () => {
  await matrix("search GET", async (persona) => {
    scriptWithRpc(world());
    return (await call(GET, persona, "GET", "/api/search?q=emissions")).status;
  }, E(401, 200, 200, 200, 200, 200, 200));
});

test("/api/search: a query under two characters answers an empty list without a database call; a failed search is a 503 with Retry-After (the bar then says so); the body carries the rating", async () => {
  const db = scriptWithRpc(world());
  const short = await call(GET, "member", "GET", "/api/search?q=a");
  assert.deepEqual([short.status, short.body], [200, { query: "a", results: [] }]);
  assert.equal(db.rpcCalls.length, 0);
  const ok = await call(GET, "member", "GET", "/api/search?q=emissions");
  assert.equal(ok.status, 200);
  assert.deepEqual((ok.body.results as { tier: number | null }[]).map((r) => r.tier), [2, 1, null]);
  db.rpcs.search_intelligence_items = () => ({ error: { message: "x" } });
  const failed = await call(GET, "member", "GET", "/api/search?q=emissions");
  assert.deepEqual([failed.status, failed.headers.get("retry-after")], [503, "1"]);
});

test("SEC-10: the search runs on the caller's own client, never the service client", async () => {
  scriptWithRpc(world());
  const { scripted } = await import("../_support/fake-clients.ts");
  scripted.service = null;
  assert.equal((await call(GET, "member", "GET", "/api/search?q=emissions")).status, 200, "with no service client at all, the search still answers");
});
