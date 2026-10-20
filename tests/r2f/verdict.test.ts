// R2f F1, F2, F5: one verbatim verdict in JavaScript and SQL. INV-R2f-1 (the structure: one verdict, every span comparison calls it), INV-R2f-2 (the JavaScript side of the 40-span fixture and the generated SQL), and the
// question-answers validator, whose CONFIRMED rule is the verdict applied to whole sentences.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { assertVerbatim, isVerbatim, renderVerbatimSql } from "@/core/contracts";
import { renderCanonicalizeUrlSql } from "@/core/parse";
import { validateAnswerEntry, type QaLive } from "@/features/batches/kinds/question-answers/validate";
import { locateSpan } from "@/features/mint/heal/ground";

interface Pattern { label: string; pattern: string }
const rules = JSON.parse(readFileSync("tests/r2f/data/forbidden-patterns.json", "utf8")) as { singleDeclarations: string[]; comparers: string[]; forbiddenInComparers: Pattern[]; forbiddenInSrc: Pattern[]; allowedFiles: string[]; verdict: { file: string } };
const lines = (text: string): string[] => text.split(/\r?\n/);
/** The offences of one source text against a pattern list: `label at line`. */
function offences(file: string, text: string, list: Pattern[]): string[] {
  return list.flatMap((p) => lines(text).flatMap((l, i) => (!l.trimStart().startsWith("//") && new RegExp(p.pattern).test(l) ? [`${file}:${i + 1}: ${p.label}`] : [])));
}
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(ts|tsx)$/.test(e.name) ? [`${dir}/${e.name}`] : []));
const srcFiles: string[] = walk("src");

test("INV-R2f-1: exactly one verbatim verdict is declared under src, and no comparer of a span with a capture keeps a case-folded test of its own", () => {
  for (const name of rules.singleDeclarations) {
    const where = srcFiles.filter((f) => new RegExp(`export (?:async )?(?:function|const) ${name}\\b`).test(readFileSync(f, "utf8")));
    assert.deepEqual(where, [rules.verdict.file], `${name} is declared in ${where.join(", ")}`);
  }
  assert.ok(rules.comparers.length >= 13);
  const own = rules.comparers.flatMap((f) => offences(f, readFileSync(f, "utf8"), rules.forbiddenInComparers));
  assert.deepEqual(own, []);
  const everywhere = srcFiles.filter((f) => !rules.allowedFiles.includes(f)).flatMap((f) => offences(f, readFileSync(f, "utf8"), rules.forbiddenInSrc));
  assert.deepEqual(everywhere, []);
});

test("INV-R2f-1: the pattern list catches a planted copy of the rule (a case-folded includes of a span, the SQL position test, a second assertVerbatim)", () => {
  const planted = [
    "const ok = capture.toLowerCase().includes(span.toLowerCase());",
    "if (!capturedText.toLowerCase().indexOf(needle)) return null;",
    "const verbatim = position(lower(btrim(source_span)) IN lower(result_content)) > 0;",
    "export function assertVerbatim(text: string, span: string): void {",
    "return pool.some((p) => p.text.includes(span.trim().toLowerCase()));",
  ];
  for (const line of planted) assert.ok(offences("planted.ts", line, [...rules.forbiddenInComparers, ...rules.forbiddenInSrc]).length >= 1, line);
  assert.deepEqual(offences("ok.ts", "const ok = isVerbatim(capture, span);", [...rules.forbiddenInComparers, ...rules.forbiddenInSrc]), []);
});

interface Pair { name: string; capture: string; span: string; verbatim: boolean }
const pairs = (JSON.parse(readFileSync("scripts/ci/fixtures/verbatim-spans.json", "utf8")) as { pairs: Pair[] }).pairs;

test("INV-R2f-2: isVerbatim gives the verdict the fixture states on all 40 spans (no-break space, narrow no-break space digit group, soft hyphen, curly quotes, tabs); schema:local runs the SQL function on the same rows", () => {
  assert.equal(pairs.length, 40);
  assert.deepEqual(pairs.filter((p) => isVerbatim(p.capture, p.span) !== p.verbatim).map((p) => p.name), []);
  assert.equal(isVerbatim(null, "a"), false);
  assert.equal(isVerbatim("a", undefined), false);
});

test("INV-R2f-2: the SQL function in migration 0106 and the canonical-URL functions in 0107 are exactly what the JavaScript renders", () => {
  const block = (file: string, text: string): string => {
    const m = /-- BEGIN generated:[^\n]*\n([\s\S]*?)\n-- END generated/.exec(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
    assert.ok(m, `${file} has no generated block`);
    return m[1] ?? text;
  };
  assert.equal(block("supabase/migrations/0106_verbatim_one_rule.sql", ""), renderVerbatimSql());
  assert.equal(block("supabase/migrations/0107_canonical_url_keeps_case.sql", ""), renderCanonicalizeUrlSql());
});

test("a tolerant search locates and the verdict decides: a located span is a byte-exact slice that isVerbatim accepts, and a figure folded to its value is never cut in half", () => {
  const capture = { id: "c", result_url: null, result_content: "A fine of EUR 1 200 000 applies, and emissions fall by 35,5 % by 2030." };
  for (const needle of ["€1,200,000", "35.5%", "EUR 1 200 000 applies"]) {
    const found = locateSpan(needle, capture);
    assert.ok(found, needle);
    assert.ok(isVerbatim(capture.result_content, found.span), `${needle} -> ${found.span}`);
  }
  assert.equal(locateSpan("1,200", capture), null, "1 200 is the head of EUR 1 200 000, a different figure: a match never ends inside a folded figure");
});

// ---- F5: the question-answers validator ----------------------------------------------------------------------------------------------------------------
const POOL = "Operators must confirm the vessel is registered. Yes, a vessel registered in a Member State qualifies for the exemption under Article 7 of the Regulation.";
const live = (): QaLive => ({
  questions: new Map([["q1", { open: true, answered: false, questionText: "Does a Member State vessel qualify?", itemUnusable: null, pool_hash: "h", members: new Map([["i1", { title: "Regulation", claim_ids: new Set(["k1"]), poolText: POOL }]]), unusable: new Map() }]]),
  done: () => false,
});
const entry = (answer: string, status = "CONFIRMED") => ({ subject_ref: "q1", outcome: "answered", answer, status_token: status, confidence: 0.9, pool_hash: "h", cited_item_ids: ["i1"], evidence: [{ item_id: "i1", claim_ids: ["k1"], source_span: "Yes, a vessel registered in a Member State qualifies for the exemption under Article 7 of the Regulation." }] });
const confirmedErrors = (answer: string): string[] => validateAnswerEntry(entry(answer), 0, live()).errors.filter((e) => /CONFIRMED needs every sentence quoted/.test(e));

test("F5: \"Yes.\" is not CONFIRMED against a span that contains \"yes\"; a whole sentence quoted from the span is; a short fragment of it is not", () => {
  assert.equal(confirmedErrors("Yes.").length, 1, "the register's example");
  assert.equal(confirmedErrors("a vessel registered in a Member State qualifies for the exemption under Article 7 of the Regulation.").length, 0);
  assert.equal(confirmedErrors("Article 7 of the Regulation").length, 0, "a quotation of 20 or more characters inside the span is a quotation");
  assert.equal(confirmedErrors("Article 7.").length, 1, "under the minimum span length it is not evidence of anything");
  assert.equal(confirmedErrors("A vessel registered in a Member State is exempt from the rule.").length, 1, "a paraphrase is not a quotation");
  assert.equal(validateAnswerEntry(entry("Yes.", "HYPOTHESIS"), 0, live()).errors.length, 0, "the same answer as a hypothesis is accepted");
});

test("assertVerbatim is the same rule: it returns the span the verdict accepts and throws on the one it refuses", () => {
  assert.equal(assertVerbatim("Hello World", " world "), " world ");
  assert.throws(() => assertVerbatim("Hello World", "worlds"), /not a substring/);
  assert.throws(() => assertVerbatim("Hello", "   "), /empty/);
});
