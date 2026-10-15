import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import { dbError, HttpError, ok, route, statusForDb } from "@/core/http/errors";
import { checkRateLimit, clientKey, MAX_REQUESTS, rateLimitHeaders, WINDOW_MS } from "@/core/http/rate-limit";
import { email, isUuid, parseJson, uuid } from "@/core/http/parse";
import { authedFetch, authHeaders } from "@/core/http/authed-fetch";

test("rate limit: a fixed window of 60 per key, 429 with Retry-After on the 61st, a new window resets", async () => {
  const t0 = 1_000_000;
  for (let i = 0; i < MAX_REQUESTS; i += 1) assert.equal(checkRateLimit("user-a", t0 + i), null);
  const limited = checkRateLimit("user-a", t0 + 100);
  assert.equal(limited?.status, 429);
  assert.equal(limited?.headers.get("X-RateLimit-Remaining"), "0");
  assert.equal(Number(limited?.headers.get("Retry-After")), Math.ceil((WINDOW_MS - 100) / 1000));
  assert.equal(checkRateLimit("user-b", t0 + 100), null, "keys are independent");
  assert.equal(checkRateLimit("user-a", t0 + WINDOW_MS), null, "the window boundary resets the count");
  assert.equal(rateLimitHeaders("user-a")["X-RateLimit-Remaining"], String(MAX_REQUESTS - 1));
  assert.deepEqual(rateLimitHeaders("never-seen"), {});
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
