import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import { dbError, HttpError, ok, route, statusForDb } from "@/core/http/errors";
import { checkRateLimit, clientKey, MAX_REQUESTS, rateLimitHeaders, WINDOW_MS, WORKER_FLUSH_BUDGET } from "@/core/http/rate-limit";
import { email, isUuid, parseJson, uuid } from "@/core/http/parse";
import { authedFetch, authHeaders } from "@/core/http/authed-fetch";

import { fakeDb } from "../_support/fake-db.ts";

test("rate limit (per-instance fallback): a fixed window of 60 per key, 429 with Retry-After on the 61st, a new window resets", async () => {
  const t0 = 1_000_000;
  for (let i = 0; i < MAX_REQUESTS; i += 1) assert.equal(await checkRateLimit("user-a", t0 + i, null), null);
  const limited = await checkRateLimit("user-a", t0 + 100, null);
  assert.equal(limited?.status, 429);
  assert.equal(limited?.headers.get("X-RateLimit-Remaining"), "0");
  assert.equal(Number(limited?.headers.get("Retry-After")), Math.ceil((WINDOW_MS - 100) / 1000));
  assert.equal(await checkRateLimit("user-b", t0 + 100, null), null, "keys are independent");
  assert.equal(await checkRateLimit("user-a", t0 + WINDOW_MS, null), null, "the window boundary resets the count");
  assert.equal(rateLimitHeaders("user-a")["X-RateLimit-Remaining"], String(MAX_REQUESTS - 1));
  assert.deepEqual(rateLimitHeaders("never-seen"), {});
});

test("IMP-011 rate limit (shared counter): the rpc decides, its remaining and reset feed the 429 and the headers, and a database that cannot answer falls back to the per-instance window", async () => {
  const t0 = 5_000_000;
  const reset = new Date(t0 + 30_000).toISOString();
  const answering = (reply: (n: number) => { allowed: boolean; remaining: number; reset_at: string } | null) => {
    let n = 0;
    return fakeDb(undefined, { rpc: () => ({ data: reply((n += 1)) ? [reply(n)] : [] }) });
  };
  const open = answering(() => ({ allowed: true, remaining: 41, reset_at: reset }));
  assert.equal(await checkRateLimit("shared-a", t0, open.db), null);
  assert.deepEqual(open.rpcs, [{ name: "rate_limit_hit", args: { p_key: "shared-a", p_limit: MAX_REQUESTS, p_window_seconds: 60 } }]);
  assert.equal(rateLimitHeaders("shared-a")["X-RateLimit-Remaining"], "41");
  assert.equal(rateLimitHeaders("shared-a")["X-RateLimit-Reset"], String(Math.ceil((t0 + 30_000) / 1000)));
  const full = answering(() => ({ allowed: false, remaining: 0, reset_at: reset }));
  const limited = await checkRateLimit("shared-b", t0, full.db);
  assert.equal(limited?.status, 429);
  assert.equal(limited?.headers.get("Retry-After"), "30", "Retry-After comes from the shared window's reset, not a local one");
  // The counter is shared: 100 local calls never limit a key the database says is open (no per-instance count is kept on this path).
  for (let i = 0; i < MAX_REQUESTS + 40; i += 1) assert.equal(await checkRateLimit("shared-c", t0 + i, open.db), null);
  // A failed, empty or malformed answer falls back to the in-memory window, which still limits.
  const broken = [fakeDb(undefined, { rpc: () => ({ error: { message: "down", code: "XX000" } }) }), answering(() => null), fakeDb(undefined, { rpc: () => ({ data: [{ allowed: "yes" }] }) })];
  for (const [i, down] of broken.entries()) {
    const key = `fallback-${i}`;
    for (let j = 0; j < MAX_REQUESTS; j += 1) assert.equal(await checkRateLimit(key, t0 + j, down.db), null, `fallback ${i} allows ${j}`);
    assert.equal((await checkRateLimit(key, t0 + MAX_REQUESTS, down.db))?.status, 429, `fallback ${i} still limits`);
  }
  const throwing = { rpc: async () => { throw new Error("socket"); } } as never;
  for (let j = 0; j < MAX_REQUESTS; j += 1) await checkRateLimit("fallback-throw", t0 + j, throwing);
  assert.equal((await checkRateLimit("fallback-throw", t0 + MAX_REQUESTS, throwing))?.status, 429, "a thrown rpc is handled the same way");
  // No service key configured: the default is the in-memory window and no rpc is attempted.
  assert.equal(await checkRateLimit("default-local", t0), null);
});

test("clientKey: first forwarded address, else one shared bucket (fail closed)", () => {
  assert.equal(clientKey({ headers: new Headers({ "x-forwarded-for": " 1.2.3.4 , 5.6.7.8" }) }), "ip:1.2.3.4");
  assert.equal(clientKey({ headers: new Headers() }), "anon:unknown");
});

test("parse: one UUID shape, one email validator, a malformed body is a 400", async () => {
  assert.ok(isUuid("11111111-1111-4111-8111-111111111111"));
  assert.ok(isUuid("00000000-0000-0000-0000-000000000000"));
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(email.parse("  Ada@Example.TEST "), "ada@example.test");
  assert.throws(() => email.parse("nope"));
  assert.equal(uuid.safeParse(5).success, false);
  const schema = z.object({ name: z.string() });
  assert.deepEqual(await parseJson(new Request("https://x.test", { method: "POST", body: '{"name":"x","extra":1}' }), schema), { name: "x" });
  await assert.rejects(parseJson(new Request("https://x.test", { method: "POST", body: "{" }), schema), (e: unknown) => e instanceof HttpError && e.status === 400 && /Invalid JSON/.test(e.message));
  await assert.rejects(parseJson(new Request("https://x.test", { method: "POST", body: "{}" }), schema), (e: unknown) => e instanceof HttpError && e.status === 400);
});

test("errors: one status map for database codes, one shape for refusals", async () => {
  assert.deepEqual([statusForDb("42501"), statusForDb("PGRST301"), statusForDb("P0002"), statusForDb("22023"), statusForDb("23505"), statusForDb("XX"), statusForDb(null)], [403, 403, 404, 409, 409, 500, 500]);
  assert.equal(dbError({ message: "raw", code: "42501" }, { forbidden: "no" }).message, "no");
  assert.equal(dbError({ message: "raw", code: "22023" }, { forbidden: "no" }).message, "raw");
  const handler = route("/t", async () => {
    throw new HttpError(418, "teapot");
  });
  const res = await handler(new Request("https://x.test"), undefined);
  assert.equal(res.status, 418);
  assert.deepEqual(await res.json(), { error: "teapot" });
  assert.equal((await ok({ "X-A": "1" }, { a: 1 }, 201)).headers.get("X-A"), "1");
});

test("PROP-028/127: the bearer is attached by one module and a missing session never reaches the network", async () => {
  let fetched = 0;
  const fetchImpl = (async (_input: string, init?: RequestInit) => ((fetched += 1), new Response(new Headers(init?.headers).get("authorization")))) as typeof fetch;
  const session = (token: string | null) => ({ auth: { getSession: async () => ({ data: { session: token ? { access_token: token } : null } }) } });
  const none = await authedFetch("/api/x", undefined, { client: session(null), fetchImpl });
  assert.equal(none.status, 401);
  assert.equal(fetched, 0);
  const sent = await authedFetch("/api/x", { headers: { "x-a": "1" } }, { client: session("tok"), fetchImpl });
  assert.equal(await sent.text(), "Bearer tok");
  assert.deepEqual(await authHeaders({ a: "b" }, { client: session("tok") }), { a: "b", Authorization: "Bearer tok" });
  assert.equal(await authHeaders({}, { client: session("") }), null);
});

test("IMP-057: a route's own budget goes through rate_limit_hit as p_limit, and the worker flush route has a larger one than the default", async () => {
  const t0 = Date.now();
  const open = fakeDb(undefined, { rpc: () => ({ data: [{ allowed: true, remaining: 599, reset_at: new Date(t0 + 30_000).toISOString() }] }) });
  assert.equal(await checkRateLimit("worker:/api/revalidate-test", t0, open.db, WORKER_FLUSH_BUDGET), null);
  assert.deepEqual(open.rpcs, [{ name: "rate_limit_hit", args: { p_key: "worker:/api/revalidate-test", p_limit: 600, p_window_seconds: 60 } }]);
  assert.ok(WORKER_FLUSH_BUDGET.limit! > MAX_REQUESTS);
});
