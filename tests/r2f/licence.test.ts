// R2f F8, F9, F10, F11: the licence register drives collection, the entry schema carries the quoted sentence and the day it was read, a quotation from a source whose terms are unknown or prohibited is capped, and a request body has a cap.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { z } from "zod";

import { renderLicenceHostsModule, SOURCE_KEYS, SOURCE_LICENCES } from "@/core/contracts";
import { fetchAllowed } from "@/core/fetch/hold";
import { guardedFetch } from "@/core/fetch/guard";
import { escalateFetch } from "@/core/fetch/ladder";
import { licenceForbidsHost } from "@/core/fetch/licence-hosts";
import { parseJson } from "@/core/http/parse";
import { acceptQuote, acceptStoredQuote } from "@/core/producers/quote";

import { processRow, type WorkerDeps } from "../../supabase/functions/capture-worker/process.ts";
import { installLedgerRpcs } from "../_support/ledger-rpcs.ts";
import { MemDb } from "../_support/memdb.ts";
import { memoryDb } from "../_support/memory-db.ts";
import { instant, routed } from "../_support/net.ts";
import { rungs } from "../_support/ladder.ts";

const BARRED = [["ghgprotocol_org", "ghgprotocol.org"], ["ecotransit_org", "ecotransit.org"], ["icao_int", "icao.int"], ["mardep_gov_hk", "mardep.gov.hk"]] as const;

test("F8: the four publishers whose terms bar automated access are the hosts the guard refuses, and the guard's module is exactly what the register renders", () => {
  for (const [key, host] of BARRED) {
    assert.equal(SOURCE_LICENCES[key]?.redistribution, "prohibited", key);
    assert.deepEqual(SOURCE_LICENCES[key]?.hosts, [host]);
    assert.equal(licenceForbidsHost(host), key);
    assert.equal(licenceForbidsHost(`www.${host}`), key, "a subdomain is the same publisher");
    assert.equal(licenceForbidsHost(`${host.toUpperCase()}.`), key, "case and a trailing dot do not matter");
    assert.equal(licenceForbidsHost(`not${host}`), null, "a host that merely ends with the same letters is another host");
    assert.equal(licenceForbidsHost(`${host}.example.com`), null);
  }
  assert.equal(licenceForbidsHost("eur-lex.europa.eu"), null);
  assert.equal(licenceForbidsHost("www.iea.org"), null, "a partly prohibited publisher with no listed host is not barred wholesale");
  assert.equal(readFileSync("src/core/fetch/licence-hosts.ts", "utf8").replace(/\r\n/g, "\n"), renderLicenceHostsModule());
  const listed = SOURCE_KEYS.filter((k) => SOURCE_LICENCES[k]?.hosts);
  assert.deepEqual(listed.sort(), BARRED.map(([k]) => k).sort());
});

test("F9: an entry's quote is the sentence of the publisher's terms, with the day it was read; the quote left the note", () => {
  const quoted = SOURCE_KEYS.filter((k) => SOURCE_LICENCES[k]?.quote);
  assert.ok(quoted.length >= 8, `${quoted.length} entries carry a quote`);
  for (const k of quoted) {
    const e = SOURCE_LICENCES[k]!;
    assert.match(e.termsReadOn ?? "", /^\d{4}-\d{2}-\d{2}$/, k);
    assert.ok(!/\[\/?quote\]/.test(e.note ?? ""), `${k}: the quote left the note`);
    assert.ok((e.quote ?? "").length >= 20, k);
  }
  assert.ok(!SOURCE_KEYS.some((k) => /\[quote\]/.test(SOURCE_LICENCES[k]?.note ?? "")));
});

test("F8: guardedFetch refuses a barred host as licence_forbids before robots.txt is asked, before a name is resolved and before any request; a redirect onto one is refused at that hop", async () => {
  const seen: string[] = [];
  const impl = (async (u: string | URL | Request) => {
    seen.push(String(u));
    return String(u).includes("start.example") ? new Response(null, { status: 302, headers: { location: "https://www.icao.int/page" } }) : new Response("ok", { status: 200 });
  }) as typeof fetch;
  let robotsAsked = 0;
  let resolved = 0;
  const g = { licence: licenceForbidsHost, userAgent: "CarosLedge/1.0", fetchImpl: impl, resolveHost: async () => (resolved++, ["93.184.216.34"]), robots: async () => (robotsAsked++, { status: "allowed" as const, rule: null, reason: null, crawlDelaySec: null }) };
  const refusal = (e: unknown) => (e as { fetchRefusal?: { reason: string; registerKey?: string; transient: boolean } }).fetchRefusal;
  await assert.rejects(() => guardedFetch("https://ghgprotocol.org/terms-use", {}, g), (e) => refusal(e)?.reason === "licence_forbids" && refusal(e)?.registerKey === "ghgprotocol_org" && refusal(e)?.transient === false);
  assert.deepEqual([seen.length, robotsAsked, resolved], [0, 0, 0], "no request, no robots.txt, no name resolution");
  await assert.rejects(() => guardedFetch("https://start.example/go", {}, g), (e) => refusal(e)?.reason === "licence_forbids" && refusal(e)?.registerKey === "icao_int");
  assert.deepEqual(seen, ["https://start.example/go"], "the redirect target was never requested");
  assert.equal((await guardedFetch("https://other.example/x", {}, g)).status, 200);
});

test("F8: the hold gate refuses a barred host to every caller, the signed ones included, and names the register key", async () => {
  const hold = { db: memoryDb({ system_state: [{ id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false }] }).db as never, env: { SCRAPE_HOLD: "off" } };
  const barred = await fetchAllowed("https://www.ecotransit.org/en/", "manual-intake-run", hold);
  assert.deepEqual([barred.allowed, barred.reason, barred.registerKey], [false, "licence_forbids", "ecotransit_org"]);
  assert.equal((await fetchAllowed("https://example.org/", null, hold)).allowed, true);
});

test("F8: the ladder records a barred candidate as a refused attempt with the register key, tries no channel on it, and still serves the next candidate", async () => {
  const calls: string[] = [];
  const result = (text: string) => ({ status: 200, text, truncated: false, fullLength: text.length, cap: 1000 });
  const deps = rungs({ licence: licenceForbidsHost, directFetch: (u) => (calls.push(u), result("The regulation requires operators to report greenhouse gas emissions each year under the scheme. ".repeat(6))), browserFetch: (u) => (calls.push(`browser ${u}`), null), substituteFetch: async (u) => (calls.push(`substitute ${u}`), []) });
  const none = await escalateFetch("https://www.icao.int/corsia", deps);
  assert.deepEqual([none.outcome, none.holdReason], ["no_reachable_source", "LICENCE_FORBIDS"]);
  assert.deepEqual(none.attempts.map((a) => [a.class, a.verdict, a.reason]), [["licence_forbids", "refused", "licence_forbids"]]);
  assert.match(none.attempts[0]?.detail ?? "", /icao_int/);
  assert.deepEqual(calls, [], "no channel ran: not the direct GET, not the browser, not a substitute");
  const next = await escalateFetch(["https://ghgprotocol.org/x", "https://agency.gov/rule"], deps);
  assert.equal(next.outcome, "content");
  assert.equal(next.url, "https://agency.gov/rule");
  assert.deepEqual(next.attempts.map((a) => a.class).slice(0, 2), ["licence_forbids", next.attempts[1]?.class]);
  assert.deepEqual(calls, ["https://agency.gov/rule"]);
});

test("F8: the capture worker refuses a source on a barred host before any request, records the register key on the queue row, and stores nothing", async () => {
  const w = memoryDb({ sources: [{ id: "src-1", url: "https://www.ghgprotocol.org/standards", name: "GHG Protocol" }], intelligence_items: [], pending_first_fetch: [{ id: "q-1", source_id: "src-1", status: "queued", attempt_count: 0 }] });
  let requests = 0;
  const net = routed(async () => (requests++, new Response("x")));
  const d = { db: w.db, env: {}, now: () => Date.parse("2026-10-15T10:00:00Z"), sleep: instant, fetchImpl: net.fetch } as unknown as WorkerDeps;
  const rep = await processRow(d, { id: "q-1", source_id: "src-1", status: "queued", attempt_count: 0 });
  assert.equal(rep.outcome, "failed");
  assert.equal(requests, 0, "no request, robots.txt included");
  assert.deepEqual(rep.attempts.map((a) => [a.channel, a.reason]), [["direct", "licence_forbids"]]);
  assert.match(rep.attempts[0]?.detail ?? "", /ghgprotocol_org/);
  assert.match(String(w.tables.pending_first_fetch?.[0]?.last_error_text), /licence_forbids \[ghgprotocol_org\]/);
  assert.equal((w.tables.agent_run_searches ?? []).length, 0);
});

test("F8: every file that reaches the network consults the register itself or passes the hold gate; the entry points consult it where the data says", () => {
  const data = JSON.parse(readFileSync("tests/r2f/data/fetch-entry-points.json", "utf8")) as { primitives: { label: string; pattern: string }[]; consults: string[]; roots: string[]; exempt: Record<string, string>; entryPoints: { file: string; token: string }[] };
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(ts|tsx|mjs)$/.test(e.name) ? [`${dir}/${e.name}`] : []));
  const reaching = data.roots.flatMap(walk).filter((f) => data.primitives.some((p) => new RegExp(p.pattern).test(readFileSync(f, "utf8"))));
  assert.ok(reaching.length >= 10, reaching.join(", "));
  const silent = reaching.filter((f) => !(f in data.exempt) && !data.consults.some((c) => readFileSync(f, "utf8").includes(c)));
  assert.deepEqual(silent, [], "these reach the network without asking the licence register or the hold gate");
  for (const f of Object.keys(data.exempt)) assert.ok(reaching.includes(f), `${f} no longer reaches the network: delete its exemption`);
  for (const e of data.entryPoints) assert.ok(readFileSync(e.file, "utf8").includes(e.token), `${e.file} does not contain ${e.token}`);
  const planted = "export async function leak(u: string) { return guardedFetch(u, {}, g); }";
  assert.ok(data.primitives.some((p) => new RegExp(p.pattern).test(planted)) && !data.consults.some((c) => planted.includes(c)), "a file that fetches and never asks is caught by the same two tests");
});

// ---- F10: the quotation cap -----------------------------------------------------------------------------------------------------------------------------
const CAPTURE = `${"The operator shall report each year. ".repeat(20)}`;
const base = { verifiedAt: "2026-10-01", captureId: "cap-1", captureText: CAPTURE, now: new Date("2026-10-20T00:00:00Z") };
test("F10: a quote from a source whose reuse terms are unknown or prohibited is refused over the cap, accepted at it; every other verdict quotes without one", () => {
  const long = CAPTURE.slice(0, 301);
  const short = CAPTURE.slice(0, 300);
  for (const reuseTerms of ["unknown", "prohibited"] as const) {
    const over = acceptQuote({ ...base, quote: long, reuseTerms });
    assert.deepEqual([over.ok, over.ok ? null : over.reason], [false, "quote_over_cap"], reuseTerms);
    assert.match(over.ok ? "" : over.detail, /301 characters.*up to 300/);
    assert.equal(acceptQuote({ ...base, quote: short, reuseTerms }).ok, true, `${reuseTerms}: 300 characters is within the cap`);
  }
  for (const reuseTerms of ["open_government", "eu_reuse", "public_domain", "licensed"] as const) assert.equal(acceptQuote({ ...base, quote: long, reuseTerms }).ok, true, reuseTerms);
  assert.equal(acceptQuote({ ...base, quote: CAPTURE.slice(0, 301).replace(/o/g, "0"), reuseTerms: "unknown" }).ok === false, true, "a quote the capture does not hold is still refused first");
});

test("F10 stored: acceptStoredQuote reads sources.reuse_terms of the quoted page's registry row, and the class table's verdict for a host with no row", async () => {
  const text = `${"The operator shall report each year. ".repeat(20)}`;
  const quote = text.slice(0, 301);
  const run = async (sources: Record<string, unknown>[], url: string) => {
    const db = new MemDb();
    installLedgerRpcs(db);
    db.seed("intelligence_items", [{ id: "i1" }]);
    db.seed("agent_run_searches", [{ id: "cap-1", intelligence_item_id: "i1", result_url: url, result_content: text, result_index: 0 }]);
    db.seed("sources", sources);
    return acceptStoredQuote(db.client, { url, quote, verifiedAt: "2026-10-01", now: new Date("2026-10-20T00:00:00Z") });
  };
  const url = "https://agency.example/rule";
  const unknown = await run([{ id: "s1", url, base_tier: 3, status: "active", reuse_terms: "unknown" }], url);
  assert.deepEqual([unknown.ok, unknown.ok ? null : unknown.reason], [false, "quote_over_cap"]);
  assert.equal((await run([{ id: "s1", url, base_tier: 3, status: "active", reuse_terms: "licensed" }], url)).ok, true, "a licensed source quotes at length");
  assert.equal((await run([], url)).ok === false, true, "no registry row and no class verdict: unknown, capped");
  const eu = "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1805";
  assert.equal((await run([], eu)).ok, true, "no row, but the class table fixes europa.eu as reusable");
});

// ---- F11: the request body cap --------------------------------------------------------------------------------------------------------------------------
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024; // the cap in src/core/http/parse.ts
const schema = z.object({ data: z.string() });
const post = (body: BodyInit, headers: Record<string, string> = {}) => new Request("https://app.test/api/x", { method: "POST", headers, body, duplex: "half" } as RequestInit);
test("F11: parseJson reads a body up to MAX_REQUEST_BODY_BYTES and refuses one over it with 413, by its declared length and by what actually streams", async () => {
  assert.deepEqual(await parseJson(post(JSON.stringify({ data: "x".repeat(1_000_000) })), schema), { data: "x".repeat(1_000_000) }, "the biggest legitimate body (a 1,000,000-character import) passes");
  const statusOf = async (r: Request) => ((await parseJson(r, schema).then(() => null, (e: unknown) => e)) as { status?: number } | null)?.status ?? null;
  const huge = JSON.stringify({ data: "x".repeat(MAX_REQUEST_BODY_BYTES) });
  assert.equal(await statusOf(post(huge)), 413, "a body over the cap");
  assert.equal(await statusOf(post(huge, { "content-length": "10" })), 413, "a body that lies about its length is stopped as it streams");
  assert.equal(await statusOf(post("{}", { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) })), 413, "a declared length over the cap is refused before a byte is read");
  assert.equal(await statusOf(post("not json")), 400);
  assert.equal(await statusOf(post("")), 400);
  assert.equal(await statusOf(post(JSON.stringify({ data: 5 }))), 400);
});
