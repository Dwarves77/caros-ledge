// DOC-DATE-1 (ADR-053 section 2): the date a stored document states about itself, read from formal codes only; DOC-DATE-2 retired the English word triggers and reverts the dates they wrote. The velocity detector reads it as its clock in CONNECT-2 PR B (patterns.json 1.2.0, capture.document_date); this file proves the column's writer. The fragments are quoted from production captures (read 2026-10-26); the negative cases are planted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { extractDocumentDate } from "@/core/fetch/document-date";
import tokens from "@/core/fetch/data/document-date.json" with { type: "json" };
import { runProducer } from "@/core/producers";
import { datedRows } from "@/core/fetch/document-date";
import { documentDate } from "@/core/producers/document-date";
import { runTurn } from "@/core/turn";

import { fixture } from "../integration/world.ts";

import { NOW, patternFixture } from "./_world.ts";

const ETS_2003 = '<p>\n         <em>OJ L 275, 25.10.2003, pp. 32–46\n</em> ... <p class="normal">Done at Luxembourg, 13 October 2003.</p>';
const FUELEU = "( OJ L 243, 9.7.2021, p. 1 ). ( 5 ) OJ L 282, 19.10.2016, p. 4 . ( 6 ) ... licable in all Member States. Done at Strasbourg, 13 September 2023. For the European Parliament";
const NEW_FORMAT = '<p>PE/84/2023/REV/1</p>\n      <p>\n         <em>OJ L, 2024/1157,  30.4.2024, ELI: <a class="underlineLink" href="';
const META = (d: string) => `<meta property="article:published_time" content="${d}" />`;
const FEDERAL_REGISTER = '<meta property="article:published_time" content="2026-07-09" />\n\n    <link rel="image_src"';

test("the formal forms: each real fragment gives its date, the kind and a basis that is a substring of the text", () => {
  const cases: [string, string, string, string, string][] = [
    ["ETS directive, OJ header before the signature", ETS_2003, "https://eur-lex.europa.eu/eli/dir/2003/87/oj/eng", "2003-10-25", "oj_header"],
    ["new-format OJ header with the act number", NEW_FORMAT, "https://eur-lex.europa.eu/eli/reg/2024/1157/oj/eng", "2024-04-30", "oj_header"],
    ["Federal Register published_time metadata", FEDERAL_REGISTER, "https://www.federalregister.gov/documents/2026/07/09/2026-13843/air-plan-approval", "2026-07-09", "eli_metadata"],
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
    ["DOC-DATE-2: the signature line is English prose, not a formal code (citations of other acts are no header either)", FUELEU, "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32023R1805"],
    ["DOC-DATE-2: the signature sentence alone", "Done at Strasbourg, 13 September 2023.", "https://example.invalid/g"],
    ["DOC-DATE-2: a dated header label at a line start", "<dl>\n  Date: 2025-03-31\n</dl>", "https://example.invalid/x"],
    ["DOC-DATE-2: a published label", "<p>Published: 2026-09-01</p>", "https://example.invalid/y"],
  ];
  for (const [name, text, url] of nulls) assert.equal(extractDocumentDate(text, url), null, name);
});

test("INV-DD-5: the accepted tokens are the metadata property names and no English word (DOC-DATE-2), under the 2.0.0 method", () => {
  assert.deepEqual(tokens.metadata, ["dc:date", "eli:date_publication", "article:published_time"]);
  assert.deepEqual(Object.keys(tokens).sort(), ["gapChars", "metadata", "version"]);
  assert.equal(tokens.version, "doc-date@2.0.0");
});

test("INV-DD-1: a date whose basis is not in its capture is refused, whichever reader produced it; a verbatim one is kept", () => {
  const caps = [{ id: "c1", result_url: "https://x.invalid/1", result_content: ETS_2003 }, { id: "c2", result_url: "https://x.invalid/2", result_content: "no formal date here" }];
  const honest = datedRows(caps, extractDocumentDate);
  assert.deepEqual([honest.rows.map((r) => r.id), honest.refused], [["c1"], []]);
  const recomposed = datedRows(caps, (t) => (t.includes("OJ L 275") ? { date: "2003-10-25", basis: "OJ L 275, dated 25.10.2003", kind: "oj_header" } : null));
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
  assert.deepEqual(dated.map((r) => [r.document_date, r.document_date_method]).sort(), [["2003-10-25", "doc-date@2.0.0"], ["2026-07-09", "doc-date@2.0.0"]]);
  assert.ok(dated.every((r) => String(r.result_content).includes(String(r.document_date_basis))), "every stored basis is verbatim in its capture");
  const again = await runProducer(deps(f), { spec: documentDate, dry: false });
  assert.deepEqual([again.counts.written ?? 0, again.counts.read, again.counts.undated], [0, 1, 1], "only the undated capture is read again; nothing is written");
});

test("the propagate stage runs it with the fetch gate closed (it reads stored data only) and writes the date of each capture that states one", async () => {
  const f = patternFixture();
  (f.d.producers.env as Record<string, string>).DOCUMENT_DATE_PRODUCER_ENABLED = "1";
  const mine = new Set(f.db.rows("agent_run_searches").map((c) => c.id));
  for (const c of f.db.rows("agent_run_searches")) {
    delete c.document_date;
    delete c.document_date_basis;
    delete c.document_date_method;
    c.result_content = META("2026-09-01");
  }
  await runTurn({ stage: "propagate", mode: "dry", input: { propagate: { producers: { only: "document-date" } } } }, { d: f.d, env: {}, now: () => NOW });
  assert.ok(f.db.rows("agent_run_searches").every((c) => !c.document_date), "dry wrote no date");
  await runTurn({ stage: "propagate", mode: "apply", input: { propagate: { producers: { only: "document-date" }, cadence_exception: "ruling" } } }, { d: f.d, env: {}, now: () => NOW });
  assert.ok(f.db.rows("agent_run_searches").filter((c) => mine.has(c.id)).every((c) => c.document_date === "2026-09-01" && String(c.document_date_basis) === 'article:published_time" content="2026-09-01'), "the apply turn dated every capture that states one (the seed pages it captured in the same run are read by the next run)");
});

test("INV-DD-2: the extractor and the producer read no intake or retrieval date, and a capture whose text states none stays undated whatever its retrieval day", async () => {
  for (const f of ["src/core/producers/document-date.ts", "src/core/fetch/document-date.ts"]) assert.doesNotMatch(readFileSync(f, "utf8").replace(/^\/\/.*$/gm, ""), /added_date|searched_at|retrieved_at|extracted_at/, f);
  const f = fixture();
  f.db.seed("agent_run_searches", [{ ...cap(4, "https://example.invalid/undated", "Regulation text with no dated header."), searched_at: `${NOW.toISOString().slice(0, 10)}T09:00:00Z` }]);
  await runProducer(deps(f), { spec: documentDate, dry: false });
  const row = f.db.rows("agent_run_searches").find((r) => String(r.id).includes("0d0004"));
  assert.deepEqual([row?.document_date ?? null, row?.document_date_basis ?? null, row?.document_date_method ?? null], [null, null, null], "no fallback to the retrieval day");
});

test("INV-DD-4: a bulk intake (ten captures retrieved on one day, ten documents dated across a year) is dated by the documents, one date each, none on the intake day", async () => {
  const f = fixture();
  const intake = NOW.toISOString().slice(0, 10);
  const published = Array.from({ length: 10 }, (_, n) => new Date(NOW.getTime() - (40 + n * 35) * 86_400_000).toISOString().slice(0, 10));
  f.db.seed("agent_run_searches", published.map((d, n) => ({ ...cap(n, `https://bulk.invalid/${n}`, META(d)), id: `a0000000-0000-4000-8000-0000000e00${String(n).padStart(2, "0")}`, searched_at: `${intake}T09:00:00Z` })));
  await runProducer(deps(f), { spec: documentDate, dry: false });
  const rows = f.db.rows("agent_run_searches").filter((r) => String(r.id).includes("0e00"));
  assert.deepEqual(rows.map((r) => r.document_date).sort(), [...published].sort());
  assert.ok(rows.every((r) => r.document_date !== intake), "no capture is dated by its intake day");
  assert.equal(new Set(rows.map((r) => r.document_date)).size, 10, "ten distinct document dates, not one burst day");
});

const stored = (n: number, url: string, content: string | null, date: string, basis: string) => ({ ...cap(n, url, content as string), document_date: date, document_date_basis: basis, document_date_method: "doc-date@1.0.0" });
const OJ_URL = "https://eur-lex.europa.eu/eli/dir/2003/87/oj/eng";

test("DOC-DATE-2: a capture the retired word-list method dated is set back to NULL on all three columns; one the new method re-produces is re-stamped; dry writes nothing; a second run is silent", async () => {
  const f = fixture();
  f.db.seed("agent_run_searches", [
    stored(5, "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32023R1805", FUELEU, "2023-09-13", "Done at Strasbourg, 13 September 2023"),
    stored(6, OJ_URL, ETS_2003, "2003-10-25", "OJ L 275, 25.10.2003"),
    stored(7, "https://example.invalid/x", "<dl>\n  Date: 2025-03-31\n</dl>", "2025-03-31", "Date: 2025-03-31"),
    stored(8, "https://example.invalid/nocontent", null, "2025-03-31", "Date: 2025-03-31"),
    { ...stored(9, OJ_URL, ETS_2003, "2003-10-25", "OJ L 275, 25.10.2003"), document_date_method: "doc-date@2.0.0" },
  ]);
  const row = (n: number) => f.db.rows("agent_run_searches").find((r) => String(r.id).endsWith(`0d000${n}`));
  const triple = (n: number) => [row(n)?.document_date ?? null, row(n)?.document_date_basis ?? null, row(n)?.document_date_method ?? null];
  const dry = await runProducer(deps(f), { spec: documentDate, dry: true });
  assert.deepEqual([dry.outcome, dry.counts.reverted, dry.counts.restamped, dry.counts.stale], ["ok", 3, 1, 4], "the 2.0.0 row is not read again");
  assert.deepEqual([triple(5)[2], triple(6)[2]], ["doc-date@1.0.0", "doc-date@1.0.0"], "dry wrote nothing");
  const run = await runProducer(deps(f), { spec: documentDate, dry: false });
  assert.deepEqual([run.outcome, run.counts.written, run.counts.reverted, run.counts.restamped], ["ok", 4, 3, 1]);
  for (const n of [5, 7, 8]) assert.deepEqual(triple(n), [null, null, null], `capture ${n}: all three columns back to NULL together`);
  assert.deepEqual(triple(6), ["2003-10-25", "OJ L 275, 25.10.2003", "doc-date@2.0.0"], "the OJ row is re-stamped, date and basis untouched");
  assert.deepEqual(triple(9), ["2003-10-25", "OJ L 275, 25.10.2003", "doc-date@2.0.0"]);
  const again = await runProducer(deps(f), { spec: documentDate, dry: false });
  assert.deepEqual([again.counts.written ?? 0, again.counts.reverted, again.counts.restamped, again.counts.stale], [0, 0, 0, 0], "a second run writes nothing");
});
