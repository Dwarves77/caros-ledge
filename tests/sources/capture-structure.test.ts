// CAPTURE-STRUCT-1: a capture keeps its paragraphs and table cells; one tolerant door (locateSpan) finds a NEW quote; every stored check stays exact.
// Oracle for I1: the toText that existed before structure (kept here, not in src). The real-document proof reads tests/fixtures/capture-struct (the FuelEU HTML and the 51 stored claim spans of capture 50d32e0e, read from production).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { runChangeDetection } from "@/core/capture/change-detection";
import { isVerbatim, locateSpan } from "@/core/contracts";
import { toText } from "@/core/fetch/classify-body";
import { extractPdfText } from "@/core/fetch/direct";
import { decodeEntities, stripTags } from "@/core/fetch/entities";
import { storeCapture } from "@/core/fetch/store-capture";
import { acceptQuote, acceptStoredQuote } from "@/core/producers/quote";
import { collectRefused } from "@/features/sources/collect";

import { installLedgerRpcs } from "../_support/ledger-rpcs.ts";
import { MemDb } from "../_support/memdb.ts";
import { memoryDb } from "../_support/memory-db.ts";
import { routed } from "../_support/net.ts";

const legacyToText = (html: string): string =>
  decodeEntities(stripTags(html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ""))).replace(/\u0000/g, "").replace(/\s+/g, " ").trim();
const flat = (s: string): string => s.replace(/\s+/g, " ");
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/capture-struct/${name}`, import.meta.url), "utf8");
const claims = JSON.parse(fixture("fueleu-claims.json")) as { capture_id: string; stored_capture_windows: string; spans: string[] };
const fueleuHtml = fixture("fueleu-excerpt.html");

// ---- the contract ----
test("toText keeps structure: block edges are blank lines, <br> and a row end are a line break, a cell end is a tab, other whitespace is one space", () => {
  assert.equal(toText("<p>One  two\n three</p><p>Next</p>"), "One two three\n\nNext");
  assert.equal(toText("<div>a<br>b<br/>c</div>"), "a\nb\nc");
  assert.equal(toText("<ul><li>x</li><li>y</li></ul>"), "x\n\ny");
  assert.equal(toText("<h1>T</h1><section><article>body</article></section>"), "T\n\nbody");
  assert.equal(toText("<table><tr><td>a</td><td>b</td></tr><tr><th>c</th><td>d</td></tr></table>tail"), "a\tb\nc\td\n\ntail");
  assert.equal(toText("<table><tr><td>(a)</td><td><p>containerships;</p></td></tr></table>"), "(a)\tcontainerships;", "a block inside a cell does not add a blank line: the cell end outranks the block edge");
  assert.equal(toText("<table><tr><td>1.</td><td></td><td>2.</td></tr></table>"), "1.\t\t2.", "an empty cell keeps its tab");
  assert.equal(toText("a&nbsp;&nbsp; b<p> c </p>"), "a b\n\nc");
  assert.equal(toText("<p>x</p><p></p><p></p><p>y</p>"), "x\n\ny", "no run of three line breaks");
  assert.equal(toText("  <p> a </p>  "), "a", "trimmed");
  assert.equal(toText("<p>a &amp;lt;b&amp;gt;</p>"), "a &lt;b&gt;", "entities decoded once");
  assert.equal(toText("<p>kept</p><script>var a='<p>';</script><style>p{}</style>"), "kept");
  assert.equal(toText("<td title=\"a>b\">x</td>"), "x");
  assert.ok(!/ [\n\t]|[\n\t] /.test(toText("<p>a </p> <p> b</p><table><tr><td> c </td><td> d </td></tr></table>")), "no space beside a line break or a tab");
});

test("I1: collapsing every whitespace to one space gives exactly what toText gave before it kept structure, over the fixtures and a seeded random corpus", () => {
  const tags = ["p", "div", "li", "table", "tr", "td", "th", "br", "span", "h2", "pre", "a", "script", "style", "!--", "b"];
  let seed = 20261026;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n);
  const words = ["The", "regulation", "&nbsp;", "&amp;", "(a)", "\n", "  ", "\t", "limit", "91,16", "&#xA9;", "<", ">", "&lt;p&gt;"];
  const corpus: string[] = [fueleuHtml, "", " ", "<p>", "a < b", "<br><br><br>", "<td>a</td><td></td>", "<!-- <p> -->x", "<p title=\"<p>\">y</p>"];
  for (let n = 0; n < 400; n++) {
    let s = "";
    for (let k = 0; k < 30; k++) s += rnd(3) === 0 ? `<${tags[rnd(tags.length)]}${rnd(2) ? "" : " x=\"1\""}${rnd(2) ? "/" : ""}>` : rnd(4) === 0 ? `</${tags[rnd(tags.length)]}>` : words[rnd(words.length)] + " ";
    corpus.push(s);
  }
  for (const x of corpus) assert.equal(flat(toText(x)), legacyToText(x), JSON.stringify(x.slice(0, 80)));
});

test("the storage hash is over the collapsed text: an unchanged page is `unchanged` whether stored flat or with its structure, and the content_hash of an old row stays valid", async () => {
  const html = fueleuHtml;
  const structured = toText(html);
  assert.ok(structured.includes("\n\n") && structured.includes("\t"));
  const w = memoryDb({ sources: [{ id: "s", url: "https://agency.example/r", name: "A" }] });
  const clock = () => Date.parse("2026-10-26T10:00:00Z");
  const base = { sourceId: "s", sourceUrl: "https://agency.example/r", sourceName: "A", finalUrl: "https://agency.example/r", title: "T", httpStatus: 200, channel: "direct" as const, numberLocale: null, itemId: null, itemIds: [] as string[], declaredTransforms: [], ceilingBind: null, ceiling: 10_000_000 };
  const first = await storeCapture(w.db as never, { ...base, text: legacyToText(html) }, clock, clock());
  assert.equal(first.outcome, "captured");
  assert.equal(first.contentHash, sha(legacyToText(html)), "the hash an old row carries is sha256 of its stored (flat) text");
  const again = await storeCapture(w.db as never, { ...base, text: structured }, clock, clock());
  assert.equal(again.outcome, "unchanged", "the structured text of the same page is the same key");
  assert.equal(again.contentHash, first.contentHash);
  assert.equal(w.tables.agent_run_searches?.length, 1);
  const stored = await storeCapture(w.db as never, { ...base, finalUrl: "https://agency.example/other", text: structured }, clock, clock());
  assert.equal(w.tables.agent_run_searches?.find((r) => r.id === stored.captureId)?.result_content, structured, "the capture row keeps the structure");
});

test("the change fingerprint is unchanged: a source whose stored fingerprint came from the flat text is not a change when the page is read with its structure", async () => {
  const page = `<html><body><h1>Rule</h1><p>${"The regulation requires operators to report greenhouse gas emissions under the scheme each year. ".repeat(6)}</p><table><tr><td>Limit</td><td>91,16</td></tr></table><p>Second paragraph.</p></body></html>`;
  const fingerprint = (t: string) => sha(t.replace(/\s+/g, " ").trim().toLowerCase());
  const v1 = fingerprint(legacyToText(page));
  assert.equal(fingerprint(toText(page)), v1);
  const system = { id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false };
  const w = memoryDb({ system_state: [system], sources: [{ id: "same", name: "same", url: "https://same.gov/p", base_tier: 2, status: "active", processing_paused: false, auto_run_enabled: true, last_checked: null, consecutive_accessible: 2, last_content_hash: v1 }] });
  const fetchImpl = routed(async () => new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })).fetch;
  const run = await runChangeDetection({ resolveHost: null, db: w.db, now: () => new Date("2026-10-26T10:00:00Z"), env: {}, fetchImpl, writeSnapshot: async () => undefined });
  assert.equal(run.counts.changes_detected, 0);
});

// ---- the tolerant door ----
test("locateSpan: the quote's words joined by any whitespace, case-insensitive, the capture's own slice back", () => {
  const cap = "Paragraphs 1, 2 and 3 shall apply to:\n\n(a)\tcontainerships;\n\n(b)\tpassenger ships.";
  assert.equal(locateSpan(cap, "apply to: (a) containerships; (b) passenger ships."), "apply to:\n\n(a)\tcontainerships;\n\n(b)\tpassenger ships.");
  assert.equal(locateSpan(cap, "PASSENGER   Ships."), "passenger ships.");
  assert.equal(locateSpan(cap, "  (a)\tcontainerships;  "), "(a)\tcontainerships;");
  assert.equal(locateSpan("a.b (x) [y] $5 a+b", "(x) [y] $5 a+b"), "(x) [y] $5 a+b", "regex characters are literal");
  assert.equal(locateSpan("a.b", "a-b"), null);
});
test("locateSpan attacks: one altered word, a blank quote and the right words in the wrong order or from another paragraph are refused", () => {
  const cap = "Article 4 sets the limit.\n\nArticle 5 sets the penalty.\n\n(a)\tcontainerships;";
  assert.equal(locateSpan(cap, "Article 4 sets the penalty."), null, "words of two paragraphs joined by a quote that no paragraph holds");
  assert.equal(locateSpan(cap, "Article 4 sets the limits."), null, "one word altered");
  assert.equal(locateSpan(cap, "limit the sets 4 Article"), null, "wrong order");
  assert.equal(locateSpan(cap, "   \n\t "), null, "blank after normalisation");
  assert.equal(locateSpan(cap, ""), null);
  assert.equal(locateSpan(null, "Article"), null);
  assert.equal(locateSpan("", "Article"), null);
  assert.equal(locateSpan(cap, "Article 4 sets the limit. Article 5"), "Article 4 sets the limit.\n\nArticle 5", "adjacent paragraphs read in order are a real span");
});
test("acceptQuote stores the slice and runs the unchanged exact rule on it; a whitespace-only quote and a paraphrase are refused", () => {
  const captureText = "Annex IV\n\n5.\t41 000\t6.\tIs 1 metric ton of VLSFO";
  const base = { verifiedAt: "2026-10-01", captureId: "cap-1", captureText, reuseTerms: "eu_reuse" as const, now: new Date("2026-10-26T00:00:00Z") };
  const v = acceptQuote({ ...base, quote: "5. 41 000 6. Is 1 metric ton" });
  assert.deepEqual(v.ok && [v.captureId, v.quote], ["cap-1", "5.\t41 000\t6.\tIs 1 metric ton"]);
  assert.ok(v.ok && isVerbatim(captureText, v.quote), "the stored slice is exactly verbatim");
  assert.equal(acceptQuote({ ...base, quote: "   \n " }).ok, false);
  const bad = acceptQuote({ ...base, quote: "5. 41 000 6. Is 2 metric ton" });
  assert.deepEqual([bad.ok, !bad.ok && bad.reason], [false, "quote_not_in_capture"]);
});
test("acceptStoredQuote finds a structured capture the exact database test cannot, keeps an old capture for a quote it still holds exactly, and refuses what neither holds", async () => {
  const URL_A = "https://agency.example/rule";
  const old = "Paragraphs 1, 2 and 3 shall apply to: (a) containerships; (b) passenger ships. Other text follows.";
  const fresh = "Paragraphs 1, 2 and 3 shall apply to:\n\n(a)\tcontainerships;\n\n(b)\tpassenger ships.\n\nOther text follows.";
  const db = new MemDb();
  installLedgerRpcs(db);
  db.seed("intelligence_items", [{ id: "i1" }]);
  db.seed("agent_run_searches", [
    { id: "cap-old", intelligence_item_id: "i1", result_url: URL_A, result_content: old, result_index: 0 },
    { id: "cap-new", intelligence_item_id: "i1", result_url: URL_A, result_content: fresh, result_index: 1 },
  ]);
  db.seed("sources", [{ id: "s1", url: URL_A, base_tier: 3, status: "active", reuse_terms: "licensed" }]);
  const ask = (quote: string) => acceptStoredQuote(db.client as never, { url: URL_A, quote, verifiedAt: "2026-10-01", now: new Date("2026-10-26T00:00:00Z") });
  const exactOld = await ask("(a) containerships; (b) passenger ships.");
  assert.deepEqual(exactOld.ok && [exactOld.captureId, exactOld.quote], ["cap-old", "(a) containerships; (b) passenger ships."], "a quote the old capture holds exactly stays on the old capture; the newer render is not asked");
  assert.equal(isVerbatim(fresh, "(a) containerships; (b) passenger ships."), false, "exact stays exact: the newer capture does not hold the old span");
  assert.equal(isVerbatim(old, "(a) containerships; (b) passenger ships."), true, "an old span is checked against its own capture only");
  db.seed("agent_run_searches", [{ id: "cap-new2", intelligence_item_id: "i1", result_url: "https://agency.example/rule2", result_content: "Section 9\n\n(c)\trailways;\n\n(d)\tairships.", result_index: 2 }]);
  const tolerant = await acceptStoredQuote(db.client as never, { url: "https://agency.example/rule2", quote: "(c) railways; (d) airships.", verifiedAt: "2026-10-01", now: new Date("2026-10-26T00:00:00Z") });
  assert.deepEqual(tolerant.ok && [tolerant.captureId, tolerant.quote], ["cap-new2", "(c)\trailways;\n\n(d)\tairships."]);
  const altered = await acceptStoredQuote(db.client as never, { url: "https://agency.example/rule2", quote: "(c) railways; (d) aircraft.", verifiedAt: "2026-10-01", now: new Date("2026-10-26T00:00:00Z") });
  assert.deepEqual([altered.ok, !altered.ok && altered.reason], [false, "quote_not_in_capture"]);
});

// ---- the capture paths ----
test("PDF: the reader's line ends are kept (unpdf marks them), spaces collapse, and a quote across a wrapped line is found", async () => {
  const stream = "BT /F1 12 Tf 10 180 Td (Article 1 first line of text) Tj 0 -14 Td (second line continues here.) Tj 0 -40 Td (Article 2 new paragraph starts.) Tj ET";
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let doc = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, o] of objs.entries()) {
    offsets.push(doc.length);
    doc += `${i + 1} 0 obj\n${o}\nendobj\n`;
  }
  doc += `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${doc.length}\n%%EOF\n`;
  const out = await extractPdfText(new TextEncoder().encode(doc));
  assert.equal(out.text, "Article 1 first line of text\nsecond line continues here.\nArticle 2 new paragraph starts.");
  assert.equal(flat(out.text), "Article 1 first line of text second line continues here. Article 2 new paragraph starts.");
  assert.equal(locateSpan(out.text, "first line of text second line continues"), "first line of text\nsecond line continues");
});

test("collect.ts stores the toText output of a substitute or browser capture, never its markup", async () => {
  const prose = (n: number) => "The regulation requires operators to report greenhouse gas emissions under the scheme each year. ".repeat(n);
  const xhtml = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>R</title></head><body><p>Article 1 Subject matter. ${prose(30)}</p><p>Second paragraph.</p></body></html>`;
  const m = memoryDb({
    system_state: [{ id: true, scrape_cadence: "weekly", scrape_start_date: "2026-01-05", global_processing_paused: false }],
    sources: [{ id: "src-1", url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1115", name: "EUR-Lex", base_tier: 1, tier_override: null, status: "active", paywalled: false, access_method: "scrape", institution_key: null }],
    intelligence_items: [{ id: "item-1", source_id: "src-1", is_archived: false, instrument_identifier: null }],
    pending_first_fetch: [{ id: "q-1", source_id: "src-1", status: "refused", attempt_count: 1, queued_at: "2026-10-18T00:00:00Z" }],
  });
  const net = routed((u) => (u.startsWith("https://publications.europa.eu/resource/celex/") ? new Response(xhtml, { headers: { "content-type": "application/xhtml+xml" } }) : new Response("denied", { status: 403 })), {});
  // The browser tier is a stub that is walled (403), so the ladder reaches the substitute publisher and no real browser is ever launched.
  const page = { on: () => undefined, goto: async () => ({ status: () => 403 }), content: async () => "<html><body>Access Denied. Reference #18.1234</body></html>", url: () => "", waitForTimeout: async () => undefined, close: async () => undefined, click: async () => undefined };
  const browser = { newContext: async () => ({ route: async () => undefined, newPage: async () => page, close: async () => undefined }), close: async () => undefined };
  const deps = { db: m.db, now: () => new Date("2026-10-19T12:00:00Z"), env: { GITHUB_ACTIONS: "true" } as Record<string, string | undefined>, fetchImpl: net.fetch, resolveHost: async () => ["93.184.216.34"], sleep: async () => undefined, random: () => 0, launchBrowser: async () => browser };
  const r = await collectRefused(deps as never, { limit: 1 });
  assert.equal(r.counts.substituted, 1, r.notes.join("; "));
  const cap = m.tables.agent_run_searches?.[0];
  assert.equal(cap?.capture_channel, "substitute");
  assert.equal(cap?.result_content, toText(xhtml));
  assert.ok(!/<[a-z/]/i.test(String(cap?.result_content)), "no markup is stored");
  assert.match(String(cap?.result_content), /\n\nSecond paragraph\.$/, "the paragraphs are");
});

// ---- the real-document proof: FuelEU Regulation (EU) 2023/1805 and the 51 claim spans stored against capture 50d32e0e ----
test("real FuelEU HTML: the 51 stored spans pass the exact rule on their own capture; each is found in the structured render with the capture's own slice; the attacks fail", () => {
  const stored = claims.stored_capture_windows;
  const structured = toText(fueleuHtml);
  assert.equal(claims.spans.length, 51);
  assert.ok(structured.includes("\n\n") && structured.includes("\t") && /\n\([a-z]\)\t/.test(structured), "the render has paragraphs, list markers and table cells");
  assert.ok(structured.includes("5.\t41 000\t6.\tIs 1 metric ton of VLSFO"), "Annex IV Part B reads as rows of cells");
  const stillExact = claims.spans.filter((s) => isVerbatim(structured, s)).length;
  assert.ok(stillExact < 51, `the structured render breaks exact matching for some stored spans (${stillExact}/51 still exact): the old check must stay bound to its own capture`);
  for (const span of claims.spans) {
    assert.equal(isVerbatim(stored, span), true, `(a) own capture: ${span.slice(0, 60)}`);
    const slice = locateSpan(structured, span);
    assert.notEqual(slice, null, `(b) located: ${span.slice(0, 60)}`);
    assert.equal(flat(slice as string).toLowerCase(), flat(span).trim().toLowerCase(), "the slice is the span, re-spaced");
    assert.equal(isVerbatim(structured, slice), true, "the slice passes the unchanged exact rule");
  }
  const crossing = claims.spans.find((s) => !isVerbatim(structured, s));
  assert.ok(crossing);
  const words = (crossing as string).trim().split(/\s+/);
  assert.equal(locateSpan(structured, [...words.slice(0, -1), "xyzzy"].join(" ")), null, "(c) one altered word");
  assert.equal(locateSpan(structured, words.slice().reverse().join(" ")), null, "(c) the right words in the wrong order");
  assert.equal(locateSpan(structured, "   \n\t  "), null, "(c) whitespace only");
  assert.equal(locateSpan(structured, "Paragraphs 1, 2 and 3 shall apply to: passenger ships."), null, "(c) words of one paragraph joined to words of another");
  assert.equal(flat(structured), legacyToText(fueleuHtml), "(d) I1 on the real document");
});
