// INV-R2a-3: every identifier pair of register row I3 resolves to DISTINCT keys; equality on the normalised identifier decides every edge, a host is matched
// by registrable domain, a URL keeps its path case, a title is sliced on the original string. Substring matches go to a surface flag, never to an edge.
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyBucket, detectMentions, matchExistingSubject, planLinkWrites, planLinks, resolveMention, canonicalSubjectUrl } from "@/core/entities/mentions";
import { canonicalizeUrl, findIdentifiers, findYearRanges, hostMatches, indexOfInsensitive, mentionsIdentifier, ownIdentifiers, registrableDomain, sameIdentifier } from "@/core/parse";
import { detectConflate, extractIdentifiers } from "@/core/grounding/gates";

const keys = (t: string) => findIdentifiers(t).map((f) => f.key);

test("I3: identifiers that share digits resolve to distinct keys", () => {
  assert.notDeepEqual(keys("2019/88"), keys("2019/883"));
  assert.notDeepEqual(keys("SB-261"), keys("SB-2610"));
  assert.deepEqual(keys("see SB-2610 and SB 261"), ["bill:SB-2610", "bill:SB-261"]);
  assert.notEqual(keys("ISO 14083")[0], keys("ISO 140830")[0]);
  assert.equal(mentionsIdentifier("The bill SB-2610 passed", { key: "bill:SB-261", type: null }), false, "SB-261 is not inside SB-2610");
  assert.equal(mentionsIdentifier("Directive (EU) 2019/883 applies", { key: "instrument:2019/88", type: null }), false, "2019/88 is not inside 2019/883");
  assert.equal(mentionsIdentifier("Directive (EU) 2019/883 applies", { key: "instrument:2019/883", type: "L" }), true);
  assert.equal(sameIdentifier({ key: "instrument:2019/883", type: "L" }, { key: "instrument:2019/883", type: "R" }), false, "a directive and a regulation can share year and number");
});

test("I3: a mention 2019/88 never resolves to the item 2019/883 and is never wired as an edge", () => {
  const corpus = [{ id: "a", title: "Directive (EU) 2019/883 on port reception facilities", instrument_identifier: "2019/883" }];
  const r = resolveMention({ kind: "identifier", value: "2019/88", canonical: "2019/88" }, corpus);
  assert.deepEqual([r.count, r.ids, r.near], [0, [], ["a"]], "no equality match; the containing item is a near miss for the surface flag");
  assert.equal(classifyBucket({ kind: "identifier" }, r.count), "surface");
  const writes = planLinkWrites("This act refers to 2019/88 in recital 4.", corpus, "self");
  assert.equal(writes.filter((w) => w.table === "item_cross_references").length, 0, "no lineage edge is written");
  const flag = writes.find((w) => w.table === "integrity_flags");
  assert.match(String(flag?.row.description), /2019\/88\(0, 1 near\)/);
  const exact = planLinks("This act, amending Directive (EU) 2019/883, enters into force.", corpus, "self");
  assert.deepEqual(exact.edges.map((e) => [e.target_item_id, e.relationship]), [["a", "amends"]], "the equal identifier is wired, typed from the sentence");
});

test("I3: an item is named by its own identifier, else the one its title opens with; a title that merely cites another act is not that act", () => {
  const corpus = [
    { id: "own", title: "Regulation (EU) 2023/1805 on renewable fuels", instrument_identifier: null },
    { id: "citing", title: "Guidance on Regulation (EU) 2023/1805 and Directive 2009/16/EC", instrument_identifier: "2024/77" },
  ];
  assert.deepEqual(resolveMention({ kind: "identifier", value: "2023/1805", canonical: "2023/1805" }, corpus).ids, ["own"]);
  assert.deepEqual(resolveMention({ kind: "identifier", value: "2023/1805", canonical: "2023/1805" }, corpus).near, ["citing"]);
  assert.deepEqual(ownIdentifiers(corpus[1] as never).map((i) => i.key), ["instrument:2024/77"]);
  assert.deepEqual(resolveMention({ kind: "identifier", value: "Regulation (EU) 2023/1805", canonical: "x" }, corpus).ids, ["own"], "a hand-built mention carries only its text");
});

test("I3: fiscal years are typed date ranges, never regulation tokens", () => {
  assert.deepEqual(keys("Spring Budget 2023/24 and Annual Report 2024/25"), []);
  assert.deepEqual(findYearRanges("Spring Budget 2023/24 and Annual Report 2024/25").map((r) => [r.from, r.to]), [[2023, 2024], [2024, 2025]]);
  assert.deepEqual(findYearRanges("FY 2023-24 and 1999/00").map((r) => [r.from, r.to]), [[2023, 2024], [1999, 2000]]);
  assert.deepEqual(keys("Regulation (EU) 2023/24 sets"), ["instrument:2023/24"], "with the instrument context beside it, it is a regulation number");
  assert.deepEqual(keys("2019/88"), ["instrument:2019/88"], "2019/88 is no fiscal range (88 is not 2020)");
  assert.deepEqual(detectMentions("Budget 2023/24 cites Regulation (EU) 2019/883.").map((m) => m.canonical), ["2019/883"]);
  assert.deepEqual(findIdentifiers("see 2023/1805", { contextOnly: true }), [], "a bare token has no instrument context");
  assert.deepEqual(keys("Regulation (EC) No 1907/2006 and (EU) No 1257/2013"), ["instrument:2006/1907", "instrument:2013/1257"]);
});

test("I3: mentions dedupe by instrument and prefer the typed spelling", () => {
  const ms = detectMentions("Directive (EU) 2019/883 (also written 2019/883 and CELEX 32019L0883).");
  assert.equal(ms.length, 1);
  assert.equal(ms[0]?.type, "L");
});

test("I3: S-CONFLATE compares identifiers by equality: a span that says 2019/883 does not carry 2019/88", () => {
  assert.deepEqual([...extractIdentifiers("Directive (EU) 2019/88 and ISO 14083")].sort(), ["instrument:2019/88", "iso:14083"]);
  const span = "Directive (EU) 2019/883 sets port reception duties for 2019/883 wastes and ISO 14083 reporting.";
  const facts = ["Directive 2019/88 applies", "Regulation 2019/883 applies", "Regulation (EU) 2023/1805 applies"].map((claim_text, i) => ({ idx: i, id: `f${i}`, claim_text, source_span: span }));
  const hits = detectConflate(facts);
  assert.ok(hits.length === 3 && /absent from span: \{[^}]*instrument:2019\/88[,}]/.test(hits[0]?.rationale ?? ""), `2019/88 and 2023/1805 are absent from the span: ${hits[0]?.rationale}`);
});

test("I3: a host is its domain or a subdomain of it, matched by registrable domain, never by suffix text or substring", () => {
  assert.equal(hostMatches("fakefederalregister.gov", "federalregister.gov"), false);
  assert.equal(hostMatches("www.federalregister.gov", "federalregister.gov"), true);
  assert.equal(hostMatches("FederalRegister.gov.", "federalregister.gov"), true);
  assert.equal(hostMatches("federalregister.gov.evil.com", "federalregister.gov"), false);
  assert.equal(hostMatches("example.com", "example.co"), false);
  assert.equal(hostMatches("", "x.com"), false);
  assert.equal(registrableDomain("www.data.gov.uk"), "data.gov.uk");
  assert.equal(registrableDomain("a.b.federalregister.gov"), "federalregister.gov");
  assert.equal(registrableDomain("fakefederalregister.gov"), "fakefederalregister.gov");
});

test("I3: canonicalUrl keeps the path and query case, sorts the query, drops the fragment, tracking and scheme difference", () => {
  const a = canonicalizeUrl("https://WWW.Example.com/Doc/ABC?b=1&a=2#frag");
  assert.equal(a, "https://example.com/Doc/ABC?a=2&b=1");
  assert.notEqual(canonicalizeUrl("https://example.com/Doc/ABC"), canonicalizeUrl("https://example.com/doc/abc"), "distinct documents stay distinct");
  assert.notEqual(canonicalizeUrl("https://example.com/p?Q=AbC"), canonicalizeUrl("https://example.com/p?q=abc"));
  assert.equal(canonicalizeUrl("http://example.com/x/?utm_source=a&id=7"), canonicalizeUrl("https://example.com/x?id=7"));
  assert.equal(canonicalizeUrl("https://example.com:443/x/"), "https://example.com/x");
  assert.equal(canonicalizeUrl("https://example.com:8443/x"), "https://example.com:8443/x");
  assert.equal(canonicalizeUrl("https://example.com/"), "https://example.com");
  assert.equal(canonicalizeUrl(null), null);
  assert.equal(canonicalizeUrl("not a url"), "not a url");
  assert.equal(canonicalSubjectUrl("https://example.com/Doc/ABC?b=1&a=2"), "https://example.com/Doc/ABC?a=2&b=1", "the mention module's subject URL is the same function");
});

test("I3: matchExistingSubject compares own registration numbers by equality and keeps URL path case", () => {
  const corpus = [{ id: "x", title: "Directive (EU) 2019/883", instrument_identifier: "2019/883", source_url: "https://eur-lex.europa.eu/Doc/A" }];
  assert.deepEqual(matchExistingSubject({ id: "", title: "Notice 2019/88", instrument_identifier: "2019/88" }, corpus), []);
  assert.deepEqual(matchExistingSubject({ id: "", title: "t", instrument_identifier: "Directive (EU) 2019/883" }, corpus).map((m) => m.how), ["reg_number"]);
  assert.deepEqual(matchExistingSubject({ id: "", title: "t", source_url: "https://eur-lex.europa.eu/doc/a" }, corpus), [], "a different path case is a different document");
  assert.deepEqual(matchExistingSubject({ id: "", title: "t", source_url: "https://eur-lex.europa.eu/Doc/A/" }, corpus).map((m) => m.how), ["source_url"]);
});

test("I3: a title is sliced on the original string, not on a lower-cased copy whose length can differ", () => {
  const title = "İSTANBUL Port Reception Regulation";
  assert.notEqual(title.toLowerCase().indexOf("port"), title.indexOf("Port"), "the lower-cased copy is misaligned (U+0130 lower-cases to two code units)");
  const at = indexOfInsensitive(title, "port reception");
  assert.ok(at);
  assert.equal(title.slice(at.index, at.index + at.length), "Port Reception");
  assert.equal(indexOfInsensitive(title, "missing"), null);
  assert.equal(indexOfInsensitive(title, ""), null);
});
