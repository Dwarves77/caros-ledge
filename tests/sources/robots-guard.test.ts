// R2c C2 and C9: robots.txt (RFC 9309) and the guard of the one fetch primitive. INV-R2c-1 (one declared identity at runtime), INV-R2c-2 (a Disallow stops the GET and records the rule), INV-R2c-3 (a 403 is never retried as another
// identity), INV-R2c-10 (a redirect to a metadata address is refused).
import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchDirect } from "@/core/fetch/direct";
import { honestFetch, robotsGateFor } from "@/core/fetch/honest";
import { guardedFetch, makeHostGate, makeRobotsReader } from "@/core/fetch/guard";
import { fetchDocument, BOT_USER_AGENT } from "@/core/fetch/policy";
import { interpretRobotsAnswer, makeRobotsGate, verdictFor } from "@/core/fetch/robots";

import { memoryDb } from "../_support/memory-db.ts";
import { instant, routed } from "../_support/net.ts";

const verdict = (body: string, path: string) => makeRobotsGate(async () => ({ status: 200, text: body }))(`https://agency.gov${path}`);
const allowed = async (body: string, path: string) => {
  const v = await verdict(body, path);
  return { allowed: v.status !== "disallowed", rule: v.rule };
};
const reasonOf = (e: unknown) => (e as { fetchRefusal?: { reason: string } } | null)?.fetchRefusal?.reason;
const page = `<html><head><title>Doc</title></head><body><p>${"The regulation requires operators to report emissions each year. ".repeat(40)}</p></body></html>`;
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });
const publicHost = async () => ["93.184.216.34"];

test("RFC 9309: the longest matching rule wins and Allow wins a tie", async () => {
  const body = "User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /tie\nAllow: /tie\n";
  assert.equal((await allowed(body, "/private/file")).allowed, false);
  assert.equal((await allowed(body, "/private/open/x")).allowed, true, "the longer Allow beats the shorter Disallow");
  assert.equal((await allowed(body, "/tie")).allowed, true, "equal length: Allow wins");
  assert.equal((await allowed(body, "/elsewhere")).allowed, true);
  assert.equal((await allowed(body, "/private/file")).rule, "Disallow: /private");
});
test("RFC 9309: the CarosLedge group is used over the * group; several groups for one agent are one", async () => {
  const body = "User-agent: *\nDisallow: /\n\nUser-agent: carosledge\nDisallow: /a\n\nUser-agent: CarosLedge\nDisallow: /b\n";
  assert.equal((await allowed(body, "/c")).allowed, true, "our group does not disallow /c, the * group is not consulted");
  assert.equal((await allowed(body, "/a/x")).allowed, false);
  assert.equal((await allowed(body, "/b")).allowed, false, "the second group of the same agent counts too");
  assert.equal((await allowed("User-agent: *\nDisallow: /", "/x")).allowed, false, "no group of ours: the * group applies");
});
test("RFC 9309: wildcards, end anchors, empty Disallow, comments, a BOM and CRLF", async () => {
  const pdf = "User-agent: *\nDisallow: /*.pdf$\n";
  assert.equal((await allowed(pdf, "/a/b.pdf")).allowed, false);
  assert.equal((await allowed(pdf, "/a/b.pdf?x=1")).allowed, true, "the end anchor excludes a query");
  assert.equal((await allowed("User-agent: *\nDisallow: /a*/c\n", "/abc/c")).allowed, false);
  const body = "﻿User-agent: * # everyone\r\nDisallow:\r\nDisallow: /x # a comment\r\n";
  assert.equal((await allowed(body, "/y")).allowed, true);
  assert.equal((await allowed(body, "/x")).allowed, false);
});
test("RFC 9309 section 2.3.1: missing or 4xx means no rules; 401, 403, 429, 5xx and a network error mean unknown, which defers and never allows or denies", () => {
  for (const status of [404, 410, 400]) assert.equal(interpretRobotsAnswer({ status, text: "" }).verdict?.status, "no_robots", String(status));
  for (const status of [401, 403, 429]) {
    const v = interpretRobotsAnswer({ status, text: "" }).verdict;
    assert.deepEqual([v?.status, v?.identityRefused], ["unknown", true], String(status));
  }
  for (const status of [500, 503]) assert.equal(interpretRobotsAnswer({ status, text: "" }).verdict?.status, "unknown");
  assert.equal(interpretRobotsAnswer({ status: null, text: "", error: "timeout" }).verdict?.status, "unknown");
  assert.equal(interpretRobotsAnswer({ status: 200, text: "<!doctype html><html></html>", contentType: "text/html" }).verdict?.status, "no_robots", "a 200 HTML soft 404 is no file");
});
test("Crawl-delay for our group raises the per-host gap above one second, never below", async () => {
  const v = await verdict("User-agent: CarosLedge\nCrawl-delay: 5\nUser-agent: *\nCrawl-delay: 1", "/x");
  assert.equal(v.crawlDelaySec, 5, "our group, not the * group");
  const wait = async (delaySec: number | null) => {
    let clock = 0;
    const sleeps: number[] = [];
    const gate = makeHostGate({ now: () => clock, sleep: async (ms) => void (sleeps.push(ms), (clock += ms)) });
    await gate("agency.gov", delaySec);
    await gate("agency.gov", delaySec);
    return sleeps;
  };
  assert.deepEqual(await wait(5), [5000]);
  assert.deepEqual(await wait(0.2), [1000], "a short Crawl-delay never lowers our floor");
  assert.deepEqual(await wait(null), [1000]);
});
test("a robots.txt contact is read from a Contact line or a comment, never from a reserved example domain", async () => {
  assert.equal((await verdict("# questions: webmaster@agency.gov\nUser-agent: *", "/x")).contact, "webmaster@agency.gov");
  assert.equal((await verdict("Contact: https://agency.gov/contact", "/x")).contact, "https://agency.gov/contact");
  assert.equal((await verdict("# mail me@example.com", "/x")).contact, null);
});
test("the robots gate reads robots.txt once per origin per run", async () => {
  let reads = 0;
  const gate = makeRobotsGate(async () => (reads++, { status: 200, text: "User-agent: *\nDisallow: /no" }));
  assert.equal((await gate("https://a.gov/no/x")).status, "disallowed");
  assert.equal((await gate("https://a.gov/yes")).status, "allowed");
  assert.equal((await gate("https://a.gov/robots.txt")).status, "no_robots", "robots.txt never disallows itself");
  assert.equal(reads, 1);
});

test("INV-R2c-2: a planted Disallow for a fixture path stops the GET and records the rule", async () => {
  const { db } = memoryDb({ system_state: [{ id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false }] });
  const net = routed(async () => html(page), { "agency.gov": { status: 200, body: "User-agent: *\nDisallow: /fixture\n" } });
  const res = await fetchDirect("https://agency.gov/fixture/rule", { db, env: {}, fetchImpl: net.fetch, sleep: instant, resolveHost: publicHost }, { max: 100_000 });
  assert.equal(res.refusal?.reason, "robots_disallowed");
  assert.equal(res.refusal?.rule, "Disallow: /fixture");
  assert.equal(net.calls.length, 0, "the page was never requested");
  const ok = await fetchDirect("https://agency.gov/open/rule", { db, env: {}, fetchImpl: net.fetch, sleep: instant, resolveHost: publicHost }, { max: 100_000 });
  assert.equal(ok.status, 200);
});
test("INV-R2c-1: every request, robots.txt included, carries the one declared user agent; the SEC string replaces it only for sec.gov", async () => {
  const { db } = memoryDb({ system_state: [{ id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false }] });
  const net = routed(async () => html(page));
  await fetchDirect("https://agency.gov/a", { db, env: {}, fetchImpl: net.fetch, sleep: instant, resolveHost: publicHost }, { max: 100_000 });
  assert.deepEqual([...new Set(net.agents)], [BOT_USER_AGENT]);
  const sec = routed(async () => html(page));
  await fetchDirect("https://www.sec.gov/a", { db, env: { SEC_FAIR_ACCESS_UA: "Example Co admin@example.test" }, fetchImpl: sec.fetch, sleep: instant, resolveHost: publicHost }, { max: 100_000 });
  assert.ok(sec.agents.includes("Example Co admin@example.test"));
  // A caller that passes its own User-Agent is overridden by the guard.
  const forged = routed(async () => html(page));
  await guardedFetch("https://agency.gov/x", { headers: { "User-Agent": "Mozilla/5.0 forged" } }, { userAgent: BOT_USER_AGENT, fetchImpl: forged.fetch, resolveHost: publicHost });
  assert.deepEqual(forged.agents, [BOT_USER_AGENT]);
});
test("INV-R2c-3: a 403 on the declared identity is final: one request, no retry with other headers", async () => {
  const seen: Array<string | null> = [];
  const impl = (async (_u: string, init: RequestInit) => (seen.push(new Headers(init.headers).get("user-agent")), html("denied", 403))) as unknown as typeof fetch;
  const guarded = (u: string, init: RequestInit) => guardedFetch(u, init, { userAgent: BOT_USER_AGENT, fetchImpl: impl, resolveHost: publicHost });
  const out = await fetchDocument("https://agency.gov/a", { fetchImpl: guarded as typeof fetch });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.status, 403);
  assert.deepEqual(seen, [BOT_USER_AGENT], "exactly one request, under the declared identity");
});

test("INV-R2c-10: a redirect to the metadata address is refused, before any request to it", async () => {
  const seen: string[] = [];
  const impl = (async (u: string) => {
    seen.push(u);
    return u.startsWith("https://agency.gov") ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }) : html("secrets");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => guardedFetch("https://agency.gov/a", {}, { userAgent: BOT_USER_AGENT, fetchImpl: impl, resolveHost: publicHost, upgradeHttp: false }),
    (e: unknown) => reasonOf(e) === "private_address",
  );
  assert.deepEqual(seen, ["https://agency.gov/a"], "the metadata address was never requested");
});
test("the guard refuses private, loopback, link-local and mapped addresses, reserved names, other schemes, and a host that resolves to one", async () => {
  const g = { userAgent: BOT_USER_AGENT, fetchImpl: (async () => html("x")) as unknown as typeof fetch };
  const host = (a: string) => (a.includes(":") ? `[${a}]` : a);
  for (const a of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.5", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2001:db8::1", "::", "224.0.0.1"]) await assert.rejects(() => guardedFetch(`http://${host(a)}/a`, {}, g), (e: unknown) => reasonOf(e) === "private_address", a);
  for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "172.32.0.1"]) assert.equal((await guardedFetch(`http://${host(a)}/a`, {}, g)).status, 200, a);
  for (const u of ["http://localhost/a", "http://127.0.0.1/a", "http://[::1]/a", "http://2130706433/a", "http://metadata.google.internal/a", "http://printer.local/a", "file:///etc/passwd"]) await assert.rejects(() => guardedFetch(u, {}, { ...g, resolveHost: publicHost }), (e: unknown) => ["private_address", "bad_scheme"].includes(reasonOf(e) ?? ""), u);
  await assert.rejects(() => guardedFetch("https://rebind.example/a", {}, { ...g, resolveHost: async () => ["93.184.216.34", "10.1.2.3"] }), (e: unknown) => reasonOf(e) === "private_address");
  const res = await guardedFetch("https://down.example/a", {}, { ...g, resolveHost: async () => { throw new Error("ENOTFOUND"); } });
  assert.equal(res.status, 200, "an unresolvable name is not a refusal: the network reports it");
});
test("redirects are followed by hand with each hop checked, and a loop ends", async () => {
  let n = 0;
  const loop = (async () => (n++, new Response(null, { status: 302, headers: { location: "https://agency.gov/again" } }))) as unknown as typeof fetch;
  await assert.rejects(() => guardedFetch("https://agency.gov/a", {}, { userAgent: BOT_USER_AGENT, fetchImpl: loop, resolveHost: publicHost, maxRedirects: 3 }), (e: unknown) => reasonOf(e) === "too_many_redirects");
  assert.equal(n, 4);
  const hop = (async (u: string) => (u.endsWith("/a") ? new Response(null, { status: 301, headers: { location: "/b" } }) : html("final"))) as unknown as typeof fetch;
  const res = await guardedFetch("https://agency.gov/a", {}, { userAgent: BOT_USER_AGENT, fetchImpl: hop, resolveHost: publicHost });
  assert.equal(res.url, "https://agency.gov/b");
  assert.equal(await res.text(), "final");
});
test("the robots reader asks robots.txt under the same guard and the host gate keeps the gap, deferring a wait too long to sleep", async () => {
  const net = routed(async () => html("x"), { "agency.gov": { status: 200, body: "User-agent: *\nCrawl-delay: 120" } });
  let clock = 0;
  const sleeps: number[] = [];
  const gate = makeHostGate({ now: () => clock, sleep: async (ms) => void (sleeps.push(ms), (clock += ms)) });
  const read = makeRobotsReader({ userAgent: BOT_USER_AGENT, fetchImpl: net.fetch, resolveHost: publicHost, gate });
  const robots = makeRobotsGate(read);
  const g = { userAgent: BOT_USER_AGENT, fetchImpl: net.fetch, resolveHost: publicHost, gate, robots };
  await guardedFetch("https://agency.gov/one", {}, g);
  assert.ok(sleeps.length >= 1 && sleeps.every((s) => s <= 1000), `the robots read and the page keep the one-second gap (slept ${sleeps})`);
  await assert.rejects(() => guardedFetch("https://agency.gov/two", {}, g), (e: unknown) => reasonOf(e) === "host_busy", "a 120 s Crawl-delay is deferred, never slept");
});

test("honestFetch is the one primitive: it carries the declared identity, refuses a disallowed page and a private address, and a documented API skips only the robots check", async () => {
  const net = routed(async () => html(page), { "agency.gov": { status: 200, body: "User-agent: *\nDisallow: /no\n" } });
  const deps = { db: memoryDb({}).db, env: {}, fetchImpl: net.fetch, sleep: instant, resolveHost: publicHost };
  await assert.rejects(() => honestFetch(deps)("https://agency.gov/no/x"), (e: unknown) => reasonOf(e) === "robots_disallowed");
  assert.equal((await honestFetch(deps, { api: true })("https://agency.gov/no/x")).status, 200);
  assert.deepEqual([...new Set(net.agents)], [BOT_USER_AGENT]);
  assert.equal((await robotsGateFor(deps)("https://agency.gov/no/x")).status, "disallowed", "the same cached verdict");
  await assert.rejects(() => honestFetch(deps, { api: true })("http://169.254.169.254/latest"), (e: unknown) => reasonOf(e) === "private_address");
});
test("verdictFor: the rule that matched is recorded, and no file means no rules", () => {
  const file = interpretRobotsAnswer({ status: 200, text: "User-agent: *\nDisallow: /x\n" }).file;
  const v = verdictFor(file, "/x/y");
  assert.deepEqual([v.status, v.rule], ["disallowed", "Disallow: /x"]);
  assert.equal(verdictFor(file, "/z").status, "allowed");
  assert.equal(verdictFor(null, "/x").status, "no_robots");
});
