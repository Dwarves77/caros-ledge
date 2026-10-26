// DOC-DATE-1 (ADR-053 section 2): the date a stored document states about itself, read from formal codes, and the velocity detector's clock. The fragments are quoted from production captures (read 2026-10-26); the negative cases are planted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { extractDocumentDate } from "@/core/fetch/document-date";
import tokens from "@/core/fetch/data/document-date.json" with { type: "json" };
import { DETECTORS, loadPatternInput, type Fact, type PatternInput } from "@/core/flywheel/patterns";
import { runProducer } from "@/core/producers";
import { datedRows } from "@/core/fetch/document-date";
import { documentDate } from "@/core/producers/document-date";
import { runTurn } from "@/core/turn";

import { fixture } from "../integration/world.ts";

import { ago, claimWithItem, connect, NOW, patternFixture, patterns, propagate } from "./_world.ts";

const ETS_2003 = '<p>\n         <em>OJ L 275, 25.10.2003, pp. 32–46\n</em> ... <p class="normal">Done at Luxembourg, 13 October 2003.</p>';
const FUELEU = "( OJ L 243, 9.7.2021, p. 1 ). ( 5 ) OJ L 282, 19.10.2016, p. 4 . ( 6 ) ... licable in all Member States. Done at Strasbourg, 13 September 2023. For the European Parliament";
const NEW_FORMAT = '<p>PE/84/2023/REV/1</p>\n      <p>\n         <em>OJ L, 2024/1157,  30.4.2024, ELI: <a class="underlineLink" href="';
const FEDERAL_REGISTER = '<meta property="article:published_time" content="2026-07-09" />\n\n    <link rel="image_src"';

test("the formal forms: each real fragment gives its date, the kind and a basis that is a substring of the text", () => {
  const cases: [string, string, string, string, string][] = [
    ["ETS directive, OJ header before the signature", ETS_2003, "https://eur-lex.europa.eu/eli/dir/2003/87/oj/eng", "2003-10-25", "oj_header"],
    ["FuelEU text: citations are not the header, the signature line is", FUELEU, "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32023R1805", "2023-09-13", "signature_line"],
    ["new-format OJ header with the act number", NEW_FORMAT, "https://eur-lex.europa.eu/eli/reg/2024/1157/oj/eng", "2024-04-30", "oj_header"],
    ["Federal Register published_time metadata", FEDERAL_REGISTER, "https://www.federalregister.gov/documents/2026/07/09/2026-13843/air-plan-approval", "2026-07-09", "eli_metadata"],
    ["a dated header line (planted)", "<dl>\n  Date: 2025-03-31\n</dl>", "https://example.invalid/x", "2025-03-31", "iso_line"],
  ];
  for (const [name, text, url, date, kind] of cases) {
    const r = extractDocumentDate(text, url);
    assert.deepEqual([r?.date, r?.kind], [date, kind], name);
    assert.ok(text.includes(r?.basis ?? "\u0000"), `${name}: the basis is verbatim`);
    assert.ok((r?.basis.length ?? 999) < 200, name);
  }
});

test("anything else is null: prose dates, a year-only ELI, an effective date, an act cited by another act, a header of another act than the URL's", () => {
  const nulls: [string, string, string][] = [
    ["dates in prose", "The rule takes effect on 5 March 2027. The Commission reported on 2025-11-02 and on 14 May 2024.", "https://example.invalid/a"],
    ["year-only ELI path and no date in the text", "Regulation text without a dated header.", "https://eur-lex.europa.eu/eli/reg/2023/1805/oj"],
    ["an effective date row is no header label", "<dt>Effective Date</dt>\n<dd>2026-07-09</dd>", "https://example.invalid/b"],
    ["the same words after a word, not at a line start", "The Date: 2026-07-09 appears inside a sentence about Effective Date: 2027-01-01.", "https://example.invalid/c"],
    ["only citations of other acts", "( OJ L 243, 9.7.2021, p. 1 ). ( 5 ) OJ L 282, 19.10.2016, p. 4 .", "https://example.invalid/d"],
    ["the OJ header of another act than the URL's", NEW_FORMAT, "https://eur-lex.europa.eu/eli/reg/2023/1805/oj/eng"],
    ["an impossible calendar day", "<em>OJ L 105, 31.2.2007, pp. 88–253", "https://example.invalid/e"],
    ["a month and year only", "Done at Brussels, September 2023.", "https://example.invalid/f"],
  ];
  for (const [name, text, url] of nulls) assert.equal(extractDocumentDate(text, url), null, name);
});

test("INV-DD-5: the accepted header tokens are date-header labels, metadata property names and the signature opener, and no others", () => {
  assert.deepEqual(tokens.metadata, ["dc:date", "eli:date_publication", "article:published_time"]);
  assert.deepEqual(tokens.labels, ["Date:", "Published:"]);
  assert.deepEqual(tokens.signatures, ["Done at"]);
  assert.deepEqual(Object.keys(tokens).sort(), ["gapChars", "labels", "metadata", "signatures", "version"]);
});

test("INV-DD-1: a date whose basis is not in its capture is refused, whichever reader produced it; a verbatim one is kept", () => {
  const caps = [{ id: "c1", result_url: "https://x.invalid/1", result_content: ETS_2003 }, { id: "c2", result_url: "https://x.invalid/2", result_content: "no formal date here" }];
  const honest = datedRows(caps, extractDocumentDate);
  assert.deepEqual([honest.rows.map((r) => r.id), honest.refused], [["c1"], []]);
  const recomposed = datedRows(caps, (t) => (t.includes("Luxembourg") ? { date: "2003-10-13", basis: "Done at Luxembourg, on 13 October 2003", kind: "signature_line" } : null));
  assert.deepEqual([recomposed.rows, recomposed.refused], [[], ["c1"]], "the planted basis is a recomposition of the text, not a substring of it");
});

const deps = (f: ReturnType<typeof fixture>, on = true) => ({ sb: f.db.client, fetch: (async () => { throw new Error("a stored-data producer fetches nothing"); }) as never, recorder: { recordRun: async () => ({ error: null }), now: () => NOW }, env: on ? { DOCUMENT_DATE_PRODUCER_ENABLED: "1" } : {} });
const cap = (n: number, url: string, content: string) => ({ id: `a0000000-0000-4000-8000-0000000d000${n}`, result_url: url, result_content: content, search_query: "fixture", result_index: 0 });

test("INV-DD-3: the producer dates the captures it can, writes the verbatim basis and method, counts what it read, and a second run writes nothing; dry writes nothing; the kill switch refuses an apply", async () => {
  const f = fixture();
  f.db.seed("agent_run_searches", [
    cap(1, "https://eur-lex.europa.eu/eli/dir/2003/87/oj/eng", ETS_2003),
    cap(2, "https://www.federalregister.gov/documents/2026/07/09/2026-13843/x", FEDERAL_REGISTER),
    cap(3, "https://example.invalid/prose", "Dates in prose such as 5 March 2027 are not a header."),
  ]);
  const rows = () => f.db.rows("agent_run_searches").filter((r) => String(r.id).includes("0d000"));
  const dry = await runProducer(deps(f), { spec: documentDate, dry: true });
  assert.deepEqual([dry.outcome, dry.counts.read, dry.counts.parsed, dry.counts.undated], ["ok", 3, 2, 1]);
  assert.ok(rows().every((r) => !r.document_date), "dry wrote nothing");
  assert.equal((await runProducer(deps(f, false), { spec: documentDate, dry: false })).outcome, "failed", "kill switch off");
  const run = await runProducer(deps(f), { spec: documentDate, dry: false });
  assert.deepEqual([run.outcome, run.counts.written, run.counts.dated_oj_header, run.counts.dated_eli_metadata], ["ok", 2, 1, 1]);
  const dated = rows().filter((r) => r.document_date);
  assert.deepEqual(dated.map((r) => [r.document_date, r.document_date_method]).sort(), [["2003-10-25", "doc-date@1.0.0"], ["2026-07-09", "doc-date@1.0.0"]]);
  assert.ok(dated.every((r) => String(r.result_content).includes(String(r.document_date_basis))), "every stored basis is verbatim in its capture");
  const again = await runProducer(deps(f), { spec: documentDate, dry: false });
  assert.deepEqual([again.counts.written ?? 0, again.counts.read, again.counts.undated], [0, 1, 1], "only the undated capture is read again; nothing is written");
});

test("the propagate stage runs it with the fetch gate closed (it reads stored data only) and the pattern loader reads what it wrote", async () => {
  const f = patternFixture();
  (f.d.producers.env as Record<string, string>).DOCUMENT_DATE_PRODUCER_ENABLED = "1";
  const mine = new Set(f.db.rows("agent_run_searches").map((c) => c.id));
  for (const c of f.db.rows("agent_run_searches")) {
    delete c.document_date;
    delete c.document_date_basis;
    delete c.document_date_method;
    c.result_content = "<p>Published: 2026-09-01</p>";
  }
  await runTurn({ stage: "propagate", mode: "dry", input: { propagate: { producers: { only: "document-date" } } } }, { d: f.d, env: {}, now: () => NOW });
  assert.ok(f.db.rows("agent_run_searches").every((c) => !c.document_date), "dry wrote no date");
  await runTurn({ stage: "propagate", mode: "apply", input: { propagate: { producers: { only: "document-date" }, cadence_exception: "ruling" } } }, { d: f.d, env: {}, now: () => NOW });
  assert.ok(f.db.rows("agent_run_searches").filter((c) => mine.has(c.id)).every((c) => c.document_date === "2026-09-01" && String(c.document_date_basis) === "Published: 2026-09-01"), "the apply turn dated every capture that states one (the seed pages it captured in the same run are read by the next run)");
  assert.ok(((await loadPatternInput(f.d.sb, NOW)).counts.captures_dated ?? 0) > 0, "the pattern loader reads them");
});

const claimFact = (over: Partial<Fact>): Fact => ({ table: "section_claim_provenance", pk: "p", role: "claim", entities: ["e1"], modes: [], surface: "regulations", at: null, due: null, source: null, tier: null, qty: null, unit: null, trl: null, kind: "FACT", group: null, ...over });
const day = (offset: number): string => new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
const input = (facts: Fact[], flow: PatternInput["flow"]): PatternInput => ({ now: NOW, facts, related: () => [], flow });

test("INV-DD-2: the velocity detector and the producer read no intake or retrieval date; a claim without a document date is in neither the numerator nor the denominator", () => {
  const src = readFileSync("src/core/flywheel/patterns/detect.ts", "utf8");
  const p1 = src.slice(src.indexOf("function velocity"), src.indexOf("function mandateCapacity"));
  assert.ok(p1.includes("docAt"));
  assert.doesNotMatch(p1, /added_date|searched_at|retrieved_at|extracted_at|\bf\.at\b|\.at as string/, "P1 reads no other clock");
  for (const f of ["src/core/producers/document-date.ts", "src/core/fetch/document-date.ts"]) assert.doesNotMatch(readFileSync(f, "utf8").replace(/^\/\/.*$/gm, ""), /added_date|searched_at|retrieved_at|extracted_at/, f);
  const dated = [...[0, 1, 2].map((n) => claimFact({ pk: `m${n}`, docAt: day(-3 - n * 4), source: `s${n}`, tier: n + 1 })), ...[100, 101, 102].map((a, n) => claimFact({ pk: `b${n}`, docAt: day(-a), source: `s${n + 9}`, tier: 1 }))];
  const flow = new Map([[day(-5), 2], [day(-3), 1], [day(-7), 1], [day(-12), 1], [day(-100), 30]]);
  const base = DETECTORS.velocity(input(dated, flow));
  assert.equal(base.length, 1);
  const undated = Array.from({ length: 40 }, (_, n) => claimFact({ pk: `u${n}`, docAt: null, at: day(-1), source: `u${n}`, tier: 1 + (n % 3) }));
  assert.deepEqual(DETECTORS.velocity(input([...dated, ...undated], flow)).map((p) => [p.key, p.value, p.evidence.length]), base.map((p) => [p.key, p.value, p.evidence.length]), "forty undated claims on the intake day change nothing");
  assert.deepEqual(DETECTORS.velocity(input(undated, flow)), [], "claims dated only by intake form no burst");
});

test("INV-DD-4: a bulk intake (items added the same day, documents dated across a year) is no burst; the same claims dated inside the window are one; undated captures leave the corpus's flow", async () => {
  // ten items of one carrier added today with ten sources of three tiers; the planted three-claim burst of the fixture is left undated, so the ten decide
  const GREEN = "Green ammonia offtake agreements were announced by three producers.";
  const bulk = (dates: (n: number) => string | null) => {
    const f = patternFixture();
    for (const g of f.db.rows("section_claim_provenance").filter((x) => String(x.claim_text).startsWith("Green ammonia") && !String(x.source_id).endsWith("0")))
      for (const c of f.db.rows("agent_run_searches").filter((x) => x.id === g.search_result_id)) if (new Date(String(c.document_date)).getTime() > NOW.getTime() - 20 * 86_400_000) { delete c.document_date; delete c.document_date_basis; delete c.document_date_method; }
    const made = Array.from({ length: 10 }, (_, n) => claimWithItem("reg", GREEN, ago(1), `b2000000-0000-4000-8000-${String(n).padStart(12, "0")}`, 1 + (n % 3), "FACT", undefined, dates(n)));
    f.db.seed("intelligence_items", made.map((m) => m.item));
    f.db.seed("agent_run_searches", made.map((m) => m.capture));
    f.db.seed("section_claim_provenance", made.map((m) => m.claim));
    return f;
  };
  const velocity = async (f: ReturnType<typeof patternFixture>) => {
    await propagate(f);
    await connect(f);
    return patterns(f).filter((p) => p.method_id === "pattern_velocity_burst");
  };
  assert.equal((await velocity(bulk((n) => ago(40 + n * 35)))).length, 0, "claims added today, documents dated across the year");
  assert.equal((await velocity(bulk((n) => ago(1 + n * 2)))).length, 1, "the same claims dated inside the window");
  assert.equal((await velocity(bulk(() => null))).length, 0, "no document date, no member");
  const f = bulk(() => null);
  await propagate(f);
  const flow = (await loadPatternInput(f.d.sb, NOW)).input.flow as Map<string, number>;
  const datedClaims = f.db.rows("section_claim_provenance").filter((c) => f.db.rows("agent_run_searches").some((s) => s.id === c.search_result_id && s.document_date)).length;
  assert.equal([...flow.values()].reduce((a, b) => a + b, 0), datedClaims, "the corpus's flow counts dated claims only");
});
