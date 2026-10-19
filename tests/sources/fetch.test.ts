// INV-177 (the fetch hold), INV-178 (one body classifier), INV-007 (static primaries through the free ladder), PROP-065/103 (error bodies, charset, ceiling), the ladder's exhaustion record.
import assert from "node:assert/strict";
import { test } from "node:test";

import { BODY_CLASS, classifyBody, isStorableClass } from "@/core/fetch/classify-body";
import { fetchDirect } from "@/core/fetch/direct";
import { assertFetchAllowed, FetchHoldError, fetchAllowed, scrapeWindowOpen } from "@/core/fetch/hold";
import { escalateFetch } from "@/core/fetch/ladder";
import { decodeBody, fetchDocument } from "@/core/fetch/policy";
import { checkReachability, classifyReachability, REACH } from "@/core/fetch/reachability";

import { memoryDb } from "../_support/memory-db.ts";
import { rungs } from "../_support/ladder.ts";
import { instant, routed } from "../_support/net.ts";

const state = (over: Record<string, unknown> = {}) => memoryDb({ system_state: [{ id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false, ...over }] });
const prose = (n: number) => "The regulation requires operators to report greenhouse gas emissions under the scheme each year. ".repeat(n);
const html = (body: string, charset = "utf-8") => `<html><head><meta charset="${charset}"><title>Doc</title></head><body><p>${body}</p></body></html>`;
const respond = (body: string | Uint8Array, init: { status?: number; type?: string } = {}) => new Response(body as BodyInit, { status: init.status ?? 200, headers: { "content-type": init.type ?? "text/html; charset=utf-8" } });

test("INV-177: a fetch while the cadence is off is refused, and nothing reaches the network", async () => {
  const { db } = state({ scrape_cadence: "off" });
  let calls = 0;
  const fetchImpl = (async () => (calls++, respond(html(prose(30))))) as typeof fetch;
  await assert.rejects(() => fetchDirect("https://agency.gov/a", { db, env: {}, fetchImpl }, { max: 100_000 }), FetchHoldError);
  assert.equal(calls, 0);
});
test("INV-177: a fetch while the env hold is engaged is refused, whatever the cadence", async () => {
  const { db } = state();
  let calls = 0;
  const fetchImpl = (async () => (calls++, respond(html(prose(30))))) as typeof fetch;
  await assert.rejects(() => fetchDirect("https://agency.gov/a", { db, env: { SCRAPE_HOLD: "1" }, fetchImpl }, { max: 100_000 }), (e: unknown) => e instanceof FetchHoldError && e.reason === "hold_engaged");
  assert.equal(calls, 0);
});

test("INV-177: exactly two signed callers pass an engaged hold or a cadence of off; a third name does not", async () => {
  const { db } = state({ scrape_cadence: "off" });
  const env = { SCRAPE_HOLD: "1" };
  for (const caller of ["unit3-remediation", "manual-intake-run"]) assert.deepEqual(await fetchAllowed("https://x.test", caller, { db, env }), { allowed: true, reason: "signed_caller" });
  for (const caller of ["capture-worker", "Unit3-Remediation", "", null, undefined]) assert.equal((await fetchAllowed("https://x.test", caller, { db, env })).allowed, false, String(caller));
  const net = routed(async () => respond(html(prose(30))));
  const res = await fetchDirect("https://agency.gov/a", { db, env, fetchImpl: net.fetch, sleep: instant, caller: "manual-intake-run" }, { max: 100_000 });
  assert.equal(res.status, 200);
  assert.equal(net.calls.length, 1);
});
test("INV-177: the emergency stop refuses even a signed caller", async () => {
  const { db } = state({ global_processing_paused: true });
  const d = await fetchAllowed("https://x.test", "unit3-remediation", { db, env: {} });
  assert.deepEqual(d, { allowed: false, reason: "emergency_stop" });
});
test("INV-177: an unreadable system_state fails closed (cadence off)", async () => {
  const { db } = memoryDb({ system_state: [{ id: true, scrape_cadence: "weekly" }] }, { failures: [{ table: "system_state", op: "select", message: "down" }] });
  const d = await fetchAllowed("https://x.test", null, { db, env: {} });
  assert.deepEqual(d, { allowed: false, reason: "cadence_off" });
  await assert.rejects(() => assertFetchAllowed("https://x.test", null, { db, env: {} }), FetchHoldError);
});
test("INV-177: an open cadence with a lifted hold lets an unsigned caller through; the reachability probe is gated the same way", async () => {
  const open = state();
  assert.deepEqual(await fetchAllowed("https://x.test", null, { db: open.db, env: {} }), { allowed: true, reason: "lifted" });
  const off = state({ scrape_cadence: "off" });
  await assert.rejects(() => checkReachability("https://x.test", { db: off.db, env: {}, fetchImpl: (async () => respond("x")) as typeof fetch }), FetchHoldError);
});
test("scrape window: weekly lands on the anchor weekday, monthly clamps a short month, off and unanchored never run", () => {
  assert.equal(scrapeWindowOpen({ cadence: "weekly", startDate: "2026-01-05" }, new Date("2026-10-12T10:00:00Z")), true);
  assert.equal(scrapeWindowOpen({ cadence: "weekly", startDate: "2026-01-05" }, new Date("2026-10-13T10:00:00Z")), false);
  assert.equal(scrapeWindowOpen({ cadence: "monthly", startDate: "2026-01-31" }, new Date("2026-02-28T10:00:00Z")), true);
  assert.equal(scrapeWindowOpen({ cadence: "off", startDate: "2026-01-05" }, new Date("2026-01-05T10:00:00Z")), false);
  assert.equal(scrapeWindowOpen({ cadence: "weekly", startDate: null }, new Date("2026-01-05T10:00:00Z")), false);
});

test("INV-178: one classifier names each failure class", () => {
  assert.equal(classifyBody(prose(20)).class, BODY_CLASS.OK);
  assert.equal(classifyBody("", { status: 200 }).class, BODY_CLASS.EMPTY);
  assert.equal(classifyBody(prose(5), { status: 404 }).class, BODY_CLASS.NOT_FOUND);
  assert.equal(classifyBody(prose(5), { status: 403 }).class, BODY_CLASS.HTTP_403);
  assert.equal(classifyBody(prose(5), { status: 503 }).class, BODY_CLASS.HTTP_5XX);
  assert.equal(classifyBody("", { timedOut: true }).class, BODY_CLASS.TIMEOUT);
  assert.equal(classifyBody("Just a moment... Checking your browser before accessing the site").class, BODY_CLASS.BOT_WALL);
  assert.equal(classifyBody("Please enable JavaScript to view this page. ".repeat(3)).class, BODY_CLASS.JS_SHELL);
  assert.equal(classifyBody(`Page not found. ${prose(3)}`).class, BODY_CLASS.SOFT_404);
});

test("INV-178: only real content (or a foreign-language body) is storable", () => {
  assert.equal(isStorableClass(BODY_CLASS.OK), true);
  assert.equal(isStorableClass(BODY_CLASS.WRONG_LANGUAGE), true);
  for (const c of [BODY_CLASS.ERROR_BODY, BODY_CLASS.SOFT_404, BODY_CLASS.BOT_WALL, BODY_CLASS.JS_SHELL, BODY_CLASS.EMPTY, BODY_CLASS.FURNITURE, BODY_CLASS.HTTP_403]) assert.equal(isStorableClass(c), false, c);
});

test("ladder: an error body from the first transport is never returned as content, and the exhaustion record names every attempt", async () => {
  const gone = { status: 200, text: `Page not found. The page you requested does not exist. ${prose(2)}`, truncated: false, fullLength: 0, cap: 0 };
  const wall = { status: 403, text: "", truncated: false, fullLength: 0, cap: 0 };
  const v = await escalateFetch(["https://agency.gov/a", "https://agency.gov/b"], rungs({ directFetch: async (u) => (u.endsWith("/a") ? gone : wall), browserFetch: async () => ({ status: 0, text: "", truncated: false, fullLength: 0, cap: 0, needsHeadless: true }) }));
  assert.equal(v.storeRow, false);
  assert.equal(v.text, "");
  assert.equal(v.attempts.length, 3, "a not-found is not walled, so the browser tier is asked only for the walled candidate");
  assert.deepEqual(v.attempts.map((a) => a.transport), ["direct", "direct", "browser"]);
  assert.equal(v.attempts[2]?.class, "needs_headless");
  assert.equal(v.attempts[2]?.verdict, "needs_headless");
});
test("ladder: a js shell escalates to the browser tier, whose content wins", async () => {
  const shell = { status: 200, text: "Please enable JavaScript to continue. ".repeat(4), truncated: false, fullLength: 0, cap: 0 };
  const real = { status: 200, text: prose(20), truncated: false, fullLength: 2000, cap: 9 };
  const v = await escalateFetch("https://agency.gov/a", rungs({ directFetch: async () => shell, browserFetch: async () => real }));
  assert.equal(v.outcome, "content");
  assert.equal(v.transport, "browser");
  assert.deepEqual(v.attempts.map((a) => a.verdict), ["js_shell", "content"]);
});
test("ladder: nothing reachable is a hold, with the record intact", async () => {
  const v = await escalateFetch("https://agency.gov/a", rungs({ directFetch: async () => ({ status: 503, text: "", truncated: false, fullLength: 0, cap: 0 }) }));
  assert.equal(v.outcome, "no_reachable_source");
  assert.equal(v.holdReason, "NO_REACHABLE_SOURCE");
  assert.equal(v.reason, BODY_CLASS.HTTP_5XX);
});

// INV-007: a static-text primary is captured through the free direct path, in full, never through a paid render.
test("INV-007: a static-text primary is captured in full through the free direct fetch", async () => {
  const { db } = state();
  const body = html(prose(60));
  const fetchImpl = (async () => respond(body)) as typeof fetch;
  const res = await fetchDirect("https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R0956", { db, env: {}, fetchImpl: routed(fetchImpl as never).fetch, sleep: instant }, { max: 1_000_000 });
  assert.equal(res.status, 200);
  assert.ok(res.text.length > 200);
  assert.equal(res.truncated, false);
  assert.equal(classifyBody(res.text).class, BODY_CLASS.OK);
});

// PROP-065 / PROP-103
test("PROP-065: a failed fetch's body is never returned as a document", async () => {
  for (const status of [403, 404, 500, 503]) {
    const out = await fetchDocument("https://agency.gov/a", { fetchImpl: (async () => respond(html(prose(60)), { status })) as typeof fetch });
    assert.equal(out.ok, false, String(status));
  }
  const marker = await fetchDocument("https://agency.gov/a", { fetchImpl: (async () => respond(html(`Attention Required! | Cloudflare ${prose(60)}`))) as typeof fetch });
  assert.equal(marker.ok === false && marker.reason, "error_marker");
  const thin = await fetchDocument("https://agency.gov/a", { fetchImpl: (async () => respond(html("tiny"))) as typeof fetch });
  assert.equal(thin.ok === false && thin.reason, "too_small");
});
test("PROP-065: bytes decode by the declared charset (header, then meta), not by a guess", () => {
  const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);
  assert.equal(decodeBody(latin1, "text/html; charset=iso-8859-1").text, "café");
  const withMeta = new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1252">'), 0xe9]);
  const d = decodeBody(withMeta, "text/html");
  assert.equal(d.source, "meta");
  assert.ok(d.text.endsWith("é"));
  assert.equal(decodeBody(new TextEncoder().encode("café"), "text/html").source, "default");
});
test("PROP-103: a size cap never binds silently; the ceiling bind is declared and reports the full length", async () => {
  const big = html(prose(400));
  const out = await fetchDocument("https://agency.gov/a", { fetchImpl: (async () => respond(big)) as typeof fetch, maxChars: 5000 });
  assert.ok(out.ok);
  if (out.ok) {
    assert.equal(out.text.length, 5000);
    assert.ok(out.fullLength > 5000);
    assert.deepEqual(out.ceilingBind, { collected: 5000, fullLength: out.fullLength });
    assert.ok(out.declaredTransforms.some((t) => t.declared_transform === "storage-ceiling-bind"));
  }
  const uncapped = await fetchDocument("https://agency.gov/a", { fetchImpl: (async () => respond(big)) as typeof fetch, maxChars: 10_000_000 });
  assert.ok(uncapped.ok && uncapped.ceilingBind === null && uncapped.text.length === uncapped.fullLength);
});
test("PROP-103: the direct transport reports truncation against its own cap", async () => {
  const { db } = state();
  const res = await fetchDirect("https://agency.gov/a", { db, env: {}, fetchImpl: routed(async () => respond(html(prose(400)))).fetch, sleep: instant }, { max: 1000 });
  assert.equal(res.truncated, true);
  assert.ok(res.fullLength > 1000);
  assert.equal(res.text.length, 1000);
});
test("reachability: a non-answer is inconclusive; only a 404 or 410 is dead", () => {
  assert.equal(classifyReachability({ status: null, errored: true }), REACH.INCONCLUSIVE);
  assert.equal(classifyReachability({ status: 403, errored: false }), REACH.INCONCLUSIVE);
  assert.equal(classifyReachability({ status: 500, errored: false }), REACH.INCONCLUSIVE);
  assert.equal(classifyReachability({ status: 404, errored: false }), REACH.DEAD);
  assert.equal(classifyReachability({ status: 410, errored: false }), REACH.DEAD);
  assert.equal(classifyReachability({ status: 405, errored: false }), REACH.REACHABLE);
  assert.equal(classifyReachability({ status: 200, errored: false }), REACH.REACHABLE);
});
