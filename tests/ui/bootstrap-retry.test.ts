import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRetryAfter, RETRY_AFTER_CAP_MS, retryDelayMs } from "@/core/http/backoff";
import { loadBootstrap, resetBootstrap, useBootstrapStore } from "@/ui/shell/use-bootstrap";

const headers = async () => ({ Authorization: "Bearer x" });
const BUNDLE = { personalState: [], members: [], adminAttention: null, overrides: [], navCounts: null, assistantEnabled: false, degraded: [] };
/** A fetch that answers from a script and counts its calls; sleeps are recorded, never waited. */
const harness = (...answers: (Response | Error)[]) => {
  const waits: number[] = [];
  let calls = 0;
  const fetchImpl = (async () => {
    const a = answers[Math.min(calls, answers.length - 1)]!;
    calls += 1;
    if (a instanceof Error) throw a;
    return a.clone();
  }) as unknown as typeof fetch;
  return { fetchImpl, waits, calls: () => calls, sleep: async (ms: number) => void waits.push(ms) };
};
const run = async (h: ReturnType<typeof harness>) => {
  resetBootstrap("u1");
  await loadBootstrap("u1", h.fetchImpl, headers, h.sleep);
  return useBootstrapStore.getState();
};

test("the backoff rule: three retries from one second, doubling; Retry-After wins when longer; a wait past the cap is refused", () => {
  assert.deepEqual([1, 2, 3, 4].map((n) => retryDelayMs(n)), [1000, 2000, 4000, null]);
  assert.equal(retryDelayMs(1, 7000), 7000);
  assert.equal(retryDelayMs(3, 1000), 4000);
  assert.equal(retryDelayMs(1, RETRY_AFTER_CAP_MS + 1), null);
  assert.deepEqual([parseRetryAfter("5"), parseRetryAfter(""), parseRetryAfter("soon"), parseRetryAfter(null)], [5000, null, null, null]);
  assert.equal(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", Date.parse("2026-01-01T00:00:00Z")), 10_000);
});

test("a 5xx is retried exactly three times, backing off 1 s, 2 s, 4 s, then the bundle ends in the failed state (4 requests, no more)", async () => {
  const h = harness(new Response("x", { status: 500 }));
  const state = await run(h);
  assert.deepEqual([h.calls(), h.waits, state.status, state.error], [4, [1000, 2000, 4000], "failed", "HTTP 500"]);
});

test("a 429 waits its Retry-After and the next answer settles the bundle", async () => {
  const h = harness(new Response("slow down", { status: 429, headers: { "Retry-After": "9" } }), Response.json(BUNDLE));
  const state = await run(h);
  assert.deepEqual([h.calls(), h.waits, state.status], [2, [9000], "ready"]);
});

test("a network error retries within the bound; a 401 is final at once; a Retry-After past the cap fails without waiting", async () => {
  const net = harness(new Error("offline"));
  assert.deepEqual([(await run(net)).status, net.calls()], ["failed", 4]);
  const denied = harness(new Response("no", { status: 401 }));
  assert.deepEqual([(await run(denied)).status, denied.calls(), denied.waits], ["failed", 1, []]);
  const long = harness(new Response("later", { status: 429, headers: { "Retry-After": "3600" } }));
  assert.deepEqual([(await run(long)).status, long.calls(), long.waits], ["failed", 1, []]);
});

test("the Retry control starts a fresh bounded round after a failed one", async () => {
  const h = harness(new Response("x", { status: 503 }));
  assert.equal((await run(h)).status, "failed");
  const again = harness(Response.json(BUNDLE));
  await loadBootstrap("u1", again.fetchImpl, headers, again.sleep);
  assert.deepEqual([useBootstrapStore.getState().status, again.calls()], ["ready", 1]);
});
