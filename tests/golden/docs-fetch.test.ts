import assert from "node:assert/strict";
import { test } from "node:test";

import { getDoc, routeGoldenFetchThrough } from "./_docs.ts";

// Main-run failure of ci-windows (PARITY-4): a golden document fetch died with `SocketError: other side closed` while the body was read, and the test threw. A transient reset is absorbed by the
// producers' one fetch policy (5, 15, 45 seconds); a 4xx is an answer and is not retried.
// The on-disk cache of _docs.ts is keyed by URL (6 hours): a fresh path per run keeps a second local run from being answered from it.
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const url = (name: string) => `https://golden.example.test/${RUN}/${name}`;
const html = (text: string) => new Response(`<p>${text}</p>`, { status: 200 });
const planted = (answers: Array<() => Response | Promise<Response>>) => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  routeGoldenFetchThrough(((url: string) => {
    calls.push(url);
    const next = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return Promise.resolve().then(next);
  }) as never, async (ms) => void sleeps.push(ms));
  return { calls, sleeps };
};
const reset = () => Promise.reject(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
const resetInBody = () => ({ ok: true, status: 200, headers: new Headers(), arrayBuffer: () => reset() }) as unknown as Response;

test("a socket reset on the first attempt recovers on the second, after the first backoff", async () => {
  const p = planted([reset, () => html("alpha token")]);
  const doc = await getDoc(url("reset-first"), "html");
  assert.equal(doc.ok, true, JSON.stringify(doc));
  assert.equal(p.calls.length, 2);
  assert.deepEqual(p.sleeps, [5000]);
});

test("a reset while the body is read is retried like a reset on connect", async () => {
  const p = planted([resetInBody, () => html("beta token")]);
  const doc = await getDoc(url("reset-in-body"), "html");
  assert.equal(doc.ok && doc.pages[0]!.includes("beta token"), true, JSON.stringify(doc));
  assert.deepEqual(p.sleeps, [5000]);
});

test("a 5xx is retried and a 404 is not", async () => {
  const five = planted([() => new Response("down", { status: 503 }), () => html("gamma token")]);
  assert.equal((await getDoc(url("five"), "html")).ok, true);
  assert.deepEqual(five.sleeps, [5000]);
  const four = planted([() => new Response("gone", { status: 404 })]);
  const doc = await getDoc(url("four"), "html");
  assert.equal(doc.ok, false);
  assert.match(doc.ok ? "" : doc.reason, /404/);
  assert.equal(four.calls.length, 1, "a 4xx is asked once");
  assert.deepEqual(four.sleeps, []);
});

test("a host that keeps resetting is a stated failure after the three backoffs, never a thrown error", async () => {
  const p = planted([reset]);
  const doc = await getDoc(url("always-reset"), "html");
  assert.equal(doc.ok, false);
  assert.deepEqual(p.sleeps, [5000, 15000, 45000]);
  assert.equal(p.calls.length, 4);
});
