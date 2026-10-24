// Security audit 2026-10-23 rows 2.3.14 (DNS rebinding passes the SSRF guard), 2.3.15 (the browser tier has no per-hop address check), and the 2.4 fetch rows (robots body read whole, PDF extraction unbounded).
// The case list of the lane-3 SSRF probe is the fixture set: every hostile URL form it fed the guard is refused here, and the rebinding case (26) is the one that was admitted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import dns from "node:dns/promises";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Agent } from "undici";

import { extractPdfText } from "@/core/fetch/direct";
import * as browserGuard from "@/core/fetch/browser-guard";
import { closeBrowser, fetchBrowser, type BrowserDeps, type BrowserLike, type BrowserContextLike, type PageLike, type ResponseLike, type RouteLike } from "@/core/fetch/headless";
import * as honest from "@/core/fetch/honest";
import * as pin from "@/core/fetch/pin";
import { guardedFetch, makeRobotsReader, type GuardOptions } from "@/core/fetch/guard";
import { fetchDocument, readBodyCapped } from "@/core/fetch/policy";

import { memoryDb } from "../_support/memory-db.ts";
import { instant, routed } from "../_support/net.ts";

const reasonOf = (e: unknown) => (e as { fetchRefusal?: { reason: string } } | null)?.fetchRefusal?.reason;
const base = { licence: () => null, userAgent: "probe" };
const okResponse = () => new Response("ok", { status: 200, headers: { "content-type": "text/html" } });

// ---- 2.3.14 Node: connect to the vetted address ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The scripted DNS of the probe: a name whose first answer is public and whose every later answer is the metadata address. */
function rebindingDns() {
  const log = { resolves: 0 };
  const resolveHost = async (host: string): Promise<string[]> => {
    if (host !== "rebind.example") return ["93.184.216.34"];
    return log.resolves++ === 0 ? ["93.184.216.34"] : ["169.254.169.254"];
  };
  return { log, resolveHost };
}

test("2.3.14 probe case 26: the request goes to the address the guard vetted, and the name is never resolved a second time", async () => {
  const dns = rebindingDns();
  const connected: string[] = [];
  // The transport as the real stack behaves when nobody pins it: it resolves the name itself at connect.
  const unpinned = (async (url: string) => (connected.push(`resolved-again:${(await dns.resolveHost(new URL(url).hostname))[0]}`), okResponse())) as unknown as typeof fetch;
  // The transport that connects to exactly the addresses it is handed.
  const pinned = async (url: string, _init: RequestInit, addresses: readonly string[]) => (connected.push(`pinned:${addresses.join(",")}@${new URL(url).hostname}`), okResponse());
  const res = await guardedFetch("http://rebind.example/", {}, { ...base, fetchImpl: unpinned, fetchPinned: pinned, resolveHost: dns.resolveHost } as GuardOptions);
  assert.equal(res.status, 200);
  assert.deepEqual(connected, ["pinned:93.184.216.34@rebind.example"], "connected to the first, vetted answer");
  assert.equal(dns.log.resolves, 1, "the second resolution never occurs");
});
test("2.3.14: every redirect hop is vetted and pinned to its own answer", async () => {
  const seen: Array<[string, string]> = [];
  const answers: Record<string, string[]> = { "a.example": ["93.184.216.34"], "b.example": ["8.8.8.8", "2606:4700:4700::1111"] };
  const pinned = async (url: string, _init: RequestInit, addresses: readonly string[]) => {
    seen.push([new URL(url).hostname, addresses.join(",")]);
    return url.startsWith("https://a.example") ? new Response(null, { status: 302, headers: { location: "https://b.example/next" } }) : okResponse();
  };
  const g = { ...base, fetchImpl: (async () => okResponse()) as unknown as typeof fetch, fetchPinned: pinned, resolveHost: async (h: string) => answers[h] ?? [], upgradeHttp: false } as GuardOptions;
  const res = await guardedFetch("https://a.example/start", {}, g);
  assert.equal(res.url, "https://b.example/next");
  assert.deepEqual(seen, [["a.example", "93.184.216.34"], ["b.example", "8.8.8.8,2606:4700:4700::1111"]]);
  // A literal needs no pin: there is nothing to resolve.
  seen.length = 0;
  await guardedFetch("https://93.184.216.34/x", {}, g);
  assert.deepEqual(seen, []);
});
test("2.3.14: a name that fails to resolve at the check is pinned to nothing, so a later answer cannot be used (fail-then-private rebinding)", async () => {
  let calls = 0;
  const seen: string[][] = [];
  const pinned = async (_u: string, _i: RequestInit, addresses: readonly string[]) => (seen.push([...addresses]), okResponse());
  const resolveHost = async () => {
    if (calls++ === 0) throw new Error("SERVFAIL");
    return ["127.0.0.1"];
  };
  await guardedFetch("http://flaky.example/", {}, { ...base, fetchImpl: (async () => okResponse()) as unknown as typeof fetch, fetchPinned: pinned, resolveHost } as GuardOptions);
  assert.deepEqual(seen, [[]], "the connect is handed an empty list: it fails as unresolvable and never resolves on its own");
  assert.equal(calls, 1);
});

test("2.3.14 Deno: the name is resolved again immediately before the connect, and a changed answer is a private_address refusal on every hop", async () => {
  const dns = rebindingDns();
  const connected: string[] = [];
  const fetchImpl = (async (url: string) => (connected.push(url), okResponse())) as unknown as typeof fetch;
  await assert.rejects(() => guardedFetch("http://rebind.example/", {}, { ...base, fetchImpl, resolveHost: dns.resolveHost, reresolve: true } as GuardOptions), (e: unknown) => reasonOf(e) === "private_address");
  assert.deepEqual(connected, [], "the request was never made");
  assert.equal(dns.log.resolves, 2);
  // A stable answer, or a second answer that is a subset of the first, connects.
  const stable = async () => ["93.184.216.34", "8.8.8.8"];
  assert.equal((await guardedFetch("http://stable.example/", {}, { ...base, fetchImpl, resolveHost: stable, reresolve: true } as GuardOptions)).status, 200);
  let n = 0;
  const shrinking = async () => (n++ === 0 ? ["93.184.216.34", "8.8.8.8"] : ["8.8.8.8"]);
  assert.equal((await guardedFetch("http://shrink.example/", {}, { ...base, fetchImpl, resolveHost: shrinking, reresolve: true } as GuardOptions)).status, 200);
  // Per hop: the first hop is stable, the redirect target rebinds.
  const hops: Record<string, number> = {};
  const perHop = async (h: string) => (hops[h] = (hops[h] ?? 0) + 1) === 1 || h !== "evil.example" ? ["93.184.216.34"] : ["10.0.0.5"];
  const redirecting = (async (url: string) => (url.includes("good.example") ? new Response(null, { status: 302, headers: { location: "https://evil.example/" } }) : okResponse())) as unknown as typeof fetch;
  await assert.rejects(() => guardedFetch("https://good.example/", {}, { ...base, fetchImpl: redirecting, resolveHost: perHop, reresolve: true, upgradeHttp: false } as GuardOptions), (e: unknown) => reasonOf(e) === "private_address");
  // A name that did not resolve at the check and resolves later is refused too (the answer is not in the empty vetted set).
  let m = 0;
  await assert.rejects(() => guardedFetch("http://late.example/", {}, { ...base, fetchImpl, resolveHost: async () => (m++ === 0 ? [] : ["127.0.0.1"]), reresolve: true } as GuardOptions), (e: unknown) => reasonOf(e) === "private_address");
});

test("2.3.14: the process-lifetime resolution cache is gone: every lookup asks the resolver", async () => {
  let asked = 0;
  const original = dns.lookup;
  (dns as { lookup: unknown }).lookup = async () => (asked++, [{ address: "93.184.216.34", family: 4 }]);
  syncBuiltinESMExports();
  try {
    const resolve = honest.resolverFor({ resolveHost: null });
    assert.deepEqual(await resolve("same.example"), ["93.184.216.34"]);
    await resolve("same.example");
    assert.equal(asked, 2);
  } finally {
    (dns as { lookup: unknown }).lookup = original;
    syncBuiltinESMExports();
  }
});
test("2.3.14: honestFetch hands the transport an undici dispatcher pinned to the vetted answer, for a name, and none for a literal", async () => {
  const dispatchers: unknown[] = [];
  const net = routed(async () => okResponse());
  const raw = (async (u: string | URL | Request, init?: RequestInit) => {
    if (!new URL(String(u)).pathname.endsWith("/robots.txt")) dispatchers.push((init as { dispatcher?: unknown } | undefined)?.dispatcher);
    return net.fetch(u, init);
  }) as typeof fetch;
  const deps = { db: memoryDb({}).db, env: {}, fetchImpl: raw, sleep: instant, resolveHost: async () => ["93.184.216.34"] };
  await honest.honestFetch(deps, { api: true })("https://agency.gov/a");
  await honest.honestFetch(deps, { api: true })("https://93.184.216.34/a");
  assert.ok(dispatchers[0] instanceof Agent, "a name is connected through a pinned Agent");
  assert.equal(dispatchers[1], undefined, "a literal address needs no pin");
});

test("the pinned connect goes to the vetted address whatever the name resolves to, and the Host header keeps the hostname", async () => {
  const seen: string[] = [];
  const server = createHttp((req, res) => (seen.push(String(req.headers.host)), res.end("pinned")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    // rebind.invalid cannot resolve anywhere: the request succeeds only because the connect never resolves it. The list names both families; the socket layer takes the one that answers.
    const res = await pin.pinnedFetch(fetch)(`http://rebind.invalid:${port}/x`, {}, ["::1", "127.0.0.1"]);
    assert.equal(await res.text(), "pinned");
    assert.deepEqual(seen, [`rebind.invalid:${port}`]);
    await assert.rejects(() => fetch(`http://rebind.invalid:${port}/x`), "control: without the pin the name does not resolve");
  } finally {
    server.close();
  }
});
test("the pinned connect to an empty list fails as an unresolvable name and resolves nothing", async () => {
  await assert.rejects(
    () => pin.pinnedFetch(fetch)("http://nothing.invalid/", {}, []),
    (e: unknown) => /fetch failed/.test(String((e as Error).message)) && (e as { cause?: { code?: string } }).cause?.code === "ENOTFOUND",
  );
});
test("the pinned connect keeps the hostname as the TLS server name (SNI) while connecting to the vetted address", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pin-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=sni.invalid", "-addext", "subjectAltName=DNS:sni.invalid"], { stdio: "ignore" });
  const cert = readFileSync(join(dir, "c.pem"));
  const names: Array<string | undefined> = [];
  const server = createHttps({ key: readFileSync(join(dir, "k.pem")), cert, SNICallback: (name, cb) => (names.push(name), cb(null, undefined)) }, (_req, res) => res.end("tls"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const res = await pin.pinnedFetch(fetch, { ca: cert })(`https://sni.invalid:${port}/`, {}, ["127.0.0.1"]);
    assert.equal(await res.text(), "tls", "the certificate for the hostname verified, so the name was presented");
    assert.deepEqual(names, ["sni.invalid"]);
  } finally {
    server.close();
  }
});

// ---- 2.3.15 browser tier -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface Logged {
  aborted: string[];
  continued: string[];
}
function fakeRoute(url: string, log: Logged, extra: Partial<{ nav: boolean; redirected: boolean }> = {}): RouteLike {
  return {
    request: () => ({ url: () => url, isNavigationRequest: () => extra.nav ?? false, redirectedFrom: () => (extra.redirected ? ({} as never) : null) }),
    abort: async () => void log.aborted.push(url),
    continue: async () => void log.continued.push(url),
  };
}
const dnsStub = async (host: string): Promise<string[]> => (host === "public.example" ? ["93.184.216.34"] : host === "sneaky.example" ? ["10.9.8.7"] : []);

test("2.3.15: the route handler aborts metadata, localhost and file:// requests and lets a public host through", async () => {
  const guard = browserGuard.makeRouteGuard(dnsStub, () => 0);
  const log: Logged = { aborted: [], continued: [] };
  for (const u of ["http://169.254.169.254/x", "http://localhost:3000/", "file:///etc/passwd", "https://public.example/"]) await guard.handler(fakeRoute(u, log));
  assert.deepEqual(log.aborted, ["http://169.254.169.254/x", "http://localhost:3000/", "file:///etc/passwd"]);
  assert.deepEqual(log.continued, ["https://public.example/"]);
});
test("2.3.15: the probe's hostile forms are all aborted by the route handler; a name that resolves private is aborted; a verdict is cached for 60 s per context and asked again after", async () => {
  let now = 0;
  const asked: string[] = [];
  const guard = browserGuard.makeRouteGuard(async (h) => (asked.push(h), dnsStub(h)), () => now);
  const log: Logged = { aborted: [], continued: [] };
  const hostile = ["http://[::1]/", "http://10.0.0.1/", "http://172.31.255.254/", "http://192.168.1.1/", "http://127.0.0.2/", "http://0.0.0.0/", "http://[::ffff:127.0.0.1]/", "http://2130706433/", "http://0177.0.0.1/", "http://0x7f000001/", "http://127.1/", "http://metadata.google.internal/computeMetadata/v1/", "http://sneaky.example/", "http://localhost./", "ftp://public.example/x", "data:text/html,hi", "http://[fe80::1]/", "http://[fd00::1]/", "http://[64:ff9b::7f00:1]/", "http://0.1.2.3/"];
  for (const u of hostile) await guard.handler(fakeRoute(u, log));
  assert.deepEqual(log.aborted, hostile);
  assert.deepEqual(log.continued, []);
  for (const u of ["https://public.example/a", "https://public.example/b"]) await guard.handler(fakeRoute(u, log));
  assert.equal(asked.filter((h) => h === "public.example").length, 1, "one resolution inside the TTL");
  now = 60_001;
  await guard.handler(fakeRoute("https://public.example/c", log));
  assert.equal(asked.filter((h) => h === "public.example").length, 2, "asked again once the verdict is older than 60 s");
});
test("2.3.15: Chromium is launched with host-resolver rules that map the local and metadata names to NOTFOUND, beside the existing launch options", () => {
  const windowed = browserGuard.browserLaunchOptions(true);
  const windowless = browserGuard.browserLaunchOptions(false);
  const rules = windowed.args[0]?.replace("--host-resolver-rules=", "") ?? "";
  for (const name of ["localhost", "*.localhost", "*.internal", "metadata.google.internal", "169.254.169.254"]) assert.match(rules, new RegExp(`MAP ${name.replace(/[.*]/g, "\\$&")} ~NOTFOUND`), name);
  assert.equal(windowed.headless, false);
  assert.equal(windowless.headless, true);
  assert.deepEqual(windowless.args, windowed.args);
});

interface Hop {
  url: string;
  status?: number;
  ip?: string;
}
/** A browser whose navigation walks a scripted redirect chain. `honourRoute` false models an interception that was missed: the chain is only visible to the response listener. */
function chainBrowser(chain: Hop[], honourRoute = true) {
  const log: Logged & { gotos: string[] } = { aborted: [], continued: [], gotos: [] };
  let handler: ((r: RouteLike) => Promise<void>) | null = null;
  const browser: BrowserLike = {
    newContext: async (): Promise<BrowserContextLike> => ({
      route: async (_p: string, h: (r: RouteLike) => Promise<void>) => void (handler = h),
      newPage: async (): Promise<PageLike> => {
        const listeners: Array<(r: ResponseLike) => void> = [];
        let cur = "";
        return {
          on: (_e: "response", l: (r: ResponseLike) => void) => void listeners.push(l),
          goto: async (u: string) => {
            log.gotos.push(u);
            const hops = u.endsWith("/robots.txt") ? [{ url: u }] : chain;
            for (const [i, hop] of hops.entries()) {
              if (honourRoute && handler) {
                const before = log.aborted.length;
                await handler(fakeRoute(hop.url, log, { nav: i === 0, redirected: i > 0 }));
                if (log.aborted.length > before) throw new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT");
              }
              cur = hop.url;
              for (const l of listeners) l({ url: () => hop.url, status: () => hop.status ?? 200, serverAddr: async () => (hop.ip ? { ipAddress: hop.ip, port: 443 } : null) });
              await new Promise((r) => setImmediate(r));
            }
            return { status: () => 200 };
          },
          content: async () => `<html><body><p>${"The regulation requires operators to report greenhouse gas emissions under the scheme each year. ".repeat(20)}</p></body></html>`,
          url: () => cur,
          waitForTimeout: async () => undefined,
          close: async () => undefined,
        };
      },
      close: async () => undefined,
    }),
    close: async () => undefined,
  };
  return { log, launch: async () => browser };
}
function browserDeps(launchBrowser: () => Promise<BrowserLike>): BrowserDeps {
  const { db } = memoryDb({ system_state: [{ id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false }] });
  let clock = 1_000_000;
  const net = routed(async () => okResponse());
  return { db, env: {}, fetchImpl: net.fetch, resolveHost: dnsStub, now: () => new Date(clock), sleep: async (ms: number) => void (clock += ms), launchBrowser };
}
const readBy = async (chain: Hop[], honourRoute = true) => {
  const fb = chainBrowser(chain, honourRoute);
  const deps = browserDeps(fb.launch);
  try {
    return { ...fb, out: await fetchBrowser("https://public.example/start", deps, { max: 1_000_000 }) };
  } finally {
    await closeBrowser(deps);
  }
};

test("2.3.15: a page that redirects the browser to the metadata address is refused as private_address, and the redirect target was blocked at the route", async () => {
  const r = await readBy([{ url: "https://public.example/start", status: 302 }, { url: "http://169.254.169.254/latest/meta-data/" }]);
  assert.equal(r.out.refusal?.reason, "private_address");
  assert.equal(r.out.text, "", "nothing from the target was stored");
  assert.deepEqual(r.log.aborted, ["http://169.254.169.254/latest/meta-data/"]);
});
test("2.3.15: a missed interception is caught by the response record: a hop that left the vetted set refuses the capture", async () => {
  const r = await readBy([{ url: "https://public.example/start", status: 302 }, { url: "http://localhost:8080/admin" }], false);
  assert.equal(r.out.refusal?.reason, "private_address");
  assert.match(r.out.refusal?.detail ?? "", /localhost/);
});
test("2.3.15: a response served from a non-public address is refused even when its host name looked public", async () => {
  const r = await readBy([{ url: "https://public.example/start", ip: "10.0.0.5" }], false);
  assert.equal(r.out.refusal?.reason, "private_address");
  assert.match(r.out.refusal?.detail ?? "", /10\.0\.0\.5/);
});
test("2.3.15: an ordinary public page, even through a public redirect, is captured by the browser tier", async () => {
  const r = await readBy([{ url: "https://public.example/start", status: 301, ip: "93.184.216.34" }, { url: "https://public.example/final", ip: "93.184.216.34" }]);
  assert.equal(r.out.refusal ?? null, null);
  assert.equal(r.out.channel, "browser");
  assert.equal(r.out.finalUrl, "https://public.example/final");
});

// ---- 2.4 robots body ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** A body of `total` bytes in 64 KiB chunks that counts what the reader actually pulled and whether it was cancelled. */
function countingBody(total: number, withLength: boolean) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new Uint8Array(64 * 1024).fill(0x23);
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= total) return controller.close();
        state.pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const headers: Record<string, string> = { "content-type": "text/plain", ...(withLength ? { "content-length": String(total) } : {}) };
  return { state, response: () => new Response(stream, { status: 200, headers }) };
}
test("2.4 robots: a robots.txt larger than 512 KiB is truncated at 512 KiB without buffering the rest", async () => {
  for (const withLength of [false, true]) {
    const body = countingBody(8 * 1024 * 1024, withLength);
    const read = makeRobotsReader({ ...base, fetchImpl: (async () => body.response()) as unknown as typeof fetch, resolveHost: async () => ["93.184.216.34"] }, readBodyCapped);
    const out = await read("https://agency.gov/robots.txt");
    assert.equal(out.status, 200);
    assert.equal(out.text.length, 512 * 1024, `kept exactly the first 512 KiB (content-length ${withLength})`);
    assert.ok(body.state.pulled <= 512 * 1024 + 64 * 1024, `pulled ${body.state.pulled} bytes of 8 MiB`);
    assert.ok(body.state.cancelled, "the rest of the stream was cancelled");
  }
});
test("2.4 robots: a small robots.txt is read whole", async () => {
  const read = makeRobotsReader({ ...base, fetchImpl: (async () => new Response("User-agent: *\nDisallow: /x\n", { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch, resolveHost: async () => ["93.184.216.34"] }, readBodyCapped);
  assert.equal((await read("https://agency.gov/robots.txt")).text, "User-agent: *\nDisallow: /x\n");
});
test("readBodyCapped still refuses a body over the cap when asked to refuse, and truncates only when asked to", async () => {
  const refuse = countingBody(2 * 1024 * 1024, false);
  await assert.rejects(() => readBodyCapped(refuse.response(), 256 * 1024), /exceeded/);
  const keep = countingBody(2 * 1024 * 1024, true);
  assert.equal((await readBodyCapped(keep.response(), 100_000, true)).byteLength, 100_000);
});

// ---- 2.4 PDF budget ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const pdfBytes = new TextEncoder().encode("%PDF-1.7\n".padEnd(2000, " "));
function stubLib(pages: number, extract: () => Promise<{ totalPages: number; text: string }>) {
  const log = { extracted: 0, destroyed: 0 };
  return {
    log,
    lib: {
      getDocumentProxy: async () => ({ numPages: pages, destroy: async () => void log.destroyed++ }),
      extractText: async () => (log.extracted++, extract()),
      getMeta: async () => ({ info: { Title: "T" } }),
    },
  };
}
test("2.4 PDF: a document of 401 pages is refused before any text is extracted", async () => {
  const s = stubLib(401, async () => ({ totalPages: 401, text: "x" }));
  await assert.rejects(() => extractPdfText(pdfBytes, s.lib), (e: unknown) => (e as { reason?: string }).reason === "pdf_too_large");
  assert.equal(s.log.extracted, 0);
  assert.equal(s.log.destroyed, 1, "the proxy was released");
  const ok = stubLib(400, async () => ({ totalPages: 400, text: "word ".repeat(500) }));
  assert.equal((await extractPdfText(pdfBytes, ok.lib)).pages, 400);
});
test("2.4 PDF: an extraction that outlasts its budget is abandoned with a stated timeout", async () => {
  const s = stubLib(5, () => new Promise(() => undefined));
  await assert.rejects(() => extractPdfText(pdfBytes, s.lib, { timeoutMs: 50 }), (e: unknown) => (e as { reason?: string }).reason === "pdf_timeout");
  assert.equal(s.log.destroyed, 1, "the proxy was destroyed so the work stops");
});
test("2.4 PDF: the policy maps an over-budget PDF to a stated outcome, never a generic failure", async () => {
  const pdfResponse = () => new Response(pdfBytes, { status: 200, headers: { "content-type": "application/pdf" } });
  const tooBig = stubLib(401, async () => ({ totalPages: 401, text: "x" }));
  const out = await fetchDocument("https://agency.gov/big.pdf", { fetchImpl: (async () => pdfResponse()) as unknown as typeof fetch, extractPdf: (b) => extractPdfText(b, tooBig.lib) });
  assert.deepEqual([out.ok, out.ok === false && out.reason, out.ok === false && out.transient], [false, "pdf_too_large", false]);
  const slow = stubLib(5, () => new Promise(() => undefined));
  const timed = await fetchDocument("https://agency.gov/slow.pdf", { fetchImpl: (async () => pdfResponse()) as unknown as typeof fetch, extractPdf: (b) => extractPdfText(b, slow.lib, { timeoutMs: 30 }) });
  assert.deepEqual([timed.ok, timed.ok === false && timed.reason], [false, "pdf_timeout"]);
});
test("2.4 PDF: the real reader (unpdf) still extracts an ordinary one-page document under the budget", async () => {
  const text = "Operators must report emissions each year";
  const stream = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let doc = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, o] of objs.entries()) {
    offsets.push(doc.length);
    doc += `${i + 1} 0 obj\n${o}\nendobj\n`;
  }
  doc += `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${doc.length}\n%%EOF\n`;
  const out = await extractPdfText(new TextEncoder().encode(doc));
  assert.deepEqual([out.text, out.pages], [text, 1]);
});
