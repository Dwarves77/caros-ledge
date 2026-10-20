// INV-R2d-4 and register I16: no customer string carries an HTML entity, a status token, an ISO timestamp, a Postgres error code, a driver message or an internal word. Three checks, one table of banned shapes
// (customer-strings.json): (1) dbError answers a fixed sentence for every status and holds the driver text back for the log; (2) a lint over the source's string literals, with a planted violation that must go red;
// (3) a rendered-text test: every sweep page drawn healthy and once per refused read, whose text must carry none of the shapes. A page that still carries one is on the file's `owed` list with the slice that owns it
// (the test fails when an owed shape is gone, and when a new one appears).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { answer, dbError, HttpError, LookupError, statusForDb } from "@/core/http/errors";
import { DB_SENTENCES, refusal, refusalSentence, type RefusalReason } from "@/core/http/failure";
import sentences from "@/core/http/data/sentences.json" with { type: "json" };
import { log } from "@/core/shared/log";

import table from "./customer-strings.json" with { type: "json" };
import refusalDebt from "./refusal-literals.json" with { type: "json" };

type Shape = { id: string; re: string; why: string };
type Owed = { where: string; shape: string; owner: string; finding: string };
type Exempt = { where: string; shape: string; why: string };
const SHAPES = (table as { shapes: Shape[] }).shapes.map((s) => ({ ...s, rx: new RegExp(s.re, "i") }));
const OWED = (table as { owed: Owed[] }).owed;
const EXEMPT = (table as { exempt: Exempt[] }).exempt;

test("I16 dbError: every status answers the table's customer sentence, the driver's code, constraint, table and message are held back for the log, and a transient failure is 503 with Retry-After", async () => {
  const planted = [
    { error: { message: 'duplicate key value violates unique constraint "org_invitations_pkey"', code: "23505" }, status: 409 },
    { error: { message: 'relation "public.secret_table" does not exist', code: "42P01" }, status: 500 },
    { error: { message: "canceling statement due to statement timeout", code: "57014" }, status: 503 },
    { error: { message: "deadlock detected", code: "40P01" }, status: 503 },
    { error: { message: "could not connect to server", code: "08006" }, status: 503 },
    { error: { message: 'invalid input syntax for type uuid: "x"', code: "22P02" }, status: 400 },
    { error: { message: "permission denied for table x", code: "42501" }, status: 403 },
    { error: { message: "no rows", code: "P0002" }, status: 404 },
    { error: { message: "something unknown", code: null }, status: 500 },
  ];
  const sentences = new Set<string>();
  for (const { error, status } of planted) {
    const logged: unknown[][] = [];
    const warn = log.warn;
    log.warn = (...a: Parameters<typeof log.warn>) => void logged.push(a);
    const e = (() => {
      try {
        return dbError(error);
      } finally {
        log.warn = warn;
      }
    })();
    assert.equal(e.status, status, error.code ?? "no code");
    const res = answer(e);
    const body = (await res.json()) as { error: string };
    assert.doesNotMatch(body.error, /duplicate|constraint|relation|secret_table|statement|deadlock|connect|uuid|permission denied|violates|unknown|\b\d{5}\b|public\./i, `${error.code}: ${body.error}`);
    assert.equal(logged.length, 1, "the driver's message is logged where the error is made");
    assert.equal(logged[0]?.[1], error.message, "the log carries the driver's own text");
    assert.doesNotMatch(e.message, /duplicate|constraint|relation|statement|deadlock|permission denied/i, "the error that travels carries the code only");
    assert.equal(res.headers.get("Retry-After"), status === 503 ? "1" : null, error.code ?? "");
    sentences.add(body.error);
  }
  assert.ok(sentences.size >= 5, "a sentence per class, not one for all");
  assert.equal(dbError({ message: "x", code: "42501" }, { forbidden: "Only org admins can invite members" }).publicMessage, "Only org admins can invite members", "a caller's own sentence still wins for 403 and 404");
  assert.equal(dbError({ message: "only an owner may grant the owner role", code: "42501" }, { own: true }).publicMessage, "only an owner may grant the owner role", "a function of this schema writes its refusal for the member: own passes it for 403");
  assert.equal(dbError({ message: "duplicate key value violates unique constraint \"x_pkey\"", code: "XX000" }, { own: true }).publicMessage, DB_SENTENCES["500"], "own never passes a 500: a driver failure is the table sentence");
  assert.equal(dbError({ message: "permission denied for table secret", code: "42501" }).publicMessage, DB_SENTENCES["403"], "without own the driver text never reaches the customer");
  assert.equal(new LookupError("step", { message: "driver down" }).publicMessage, dbError({ message: "x", code: "57014" }).publicMessage, "one sentence for 'could not be read just now'");
  assert.equal(statusForDb("23505"), 409);
});

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
const norm = (p: string): string => relative(".", p).replace(/\\/g, "/");
/** String literals that are not JSX attribute values: a JS string, where an entity is NOT decoded. */
function jsStrings(source: string): string[] {
  const out: string[] = [];
  // a comment is documentation: a backtick pair in a JSDoc block is not a template literal a customer reads
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
  const rx = /(^|[^A-Za-z0-9_-])(["'`])((?:\\.|(?!\2)[^\\\n])*)\2/g;
  for (let m = rx.exec(text); m; m = rx.exec(text)) {
    const before = text.slice(Math.max(0, m.index), m.index + m[1]!.length);
    if (/=$/.test(before) && !/ =$/.test(text.slice(Math.max(0, m.index - 1), m.index + m[1]!.length))) continue; // JSX attribute: name="..."
    out.push(m[3] as string);
  }
  return out;
}
const LITERAL_RULES: { id: string; re: RegExp }[] = [
  { id: "entity-in-a-js-string", re: /&(?:[a-z]{2,6}|#\d+);/ },
  { id: "driver-message-into-an-error", re: /^$/ },
];

test("I16 lint: no string literal under src/features, src/ui or src/core/http carries an HTML entity, and no error is built from a driver message (planted violations must be flagged)", () => {
  const planted = ['const m = "the finding&apos;s brief";', "const n = `Reg&nbsp;ulation`;", 'return <p title="Caro&apos;s Ledge">ok</p>;'];
  assert.deepEqual(planted.map((p) => jsStrings(p).some((s) => LITERAL_RULES[0]!.re.test(s))), [true, true, false], "the lint flags a JS string and a template, and leaves a JSX attribute alone");
  const bad: string[] = [];
  for (const root of ["src/features", "src/ui", "src/core/http"]) {
    for (const p of walk(root)) {
      const text = readFileSync(p, "utf8");
      for (const s of jsStrings(text)) if (LITERAL_RULES[0]!.re.test(s) && !/^\s*(?:\.replace|new RegExp)/.test(s) && !/\/(?:&|nbsp|amp|lt|gt|quot|apos|#\d)/.test(s)) bad.push(`${norm(p)}: ${s.slice(0, 70)}`);
    }
  }
  const allowed = [...OWED, ...EXEMPT].filter((o) => o.shape === "entity-in-a-js-string").map((o) => o.where);
  const unlisted = bad.filter((b) => !allowed.some((w) => b.startsWith(`${w}:`)));
  assert.deepEqual(unlisted, [], "an HTML entity inside a JS string is printed as characters: write the character");
});

test("I16 lint: an error built from a driver message is flagged (new HttpError(500, error.message)), and every such call left in the tree is owed to a slice", () => {
  const SHAPE = /(?:new HttpError|collabFail)\(\s*\d{3},\s*[A-Za-z_.]*\.message\b/;
  assert.ok(SHAPE.test("throw new HttpError(500, error.message);"), "the planted violation is flagged");
  assert.ok(!SHAPE.test('throw new HttpError(500, "Something went wrong");'));
  assert.ok(!SHAPE.test("throw dbError(error);"));
  const found = new Set<string>();
  for (const p of walk("src")) if (SHAPE.test(readFileSync(p, "utf8"))) found.add(norm(p));
  const owed = new Set(OWED.filter((o) => o.shape === "driver-message-into-an-error").map((o) => o.where));
  assert.deepEqual([...found].filter((f) => !owed.has(f)).sort(), [], "route a database failure through dbError (a fixed sentence), or a caller's own sentence");
  assert.deepEqual([...owed].filter((f) => !found.has(f)).sort(), [], "owed but no longer present: remove it from customer-strings.json");
});

test("the table is made of findings: every shape carries a reason and every owed entry an owner and a finding", () => {
  for (const s of SHAPES) assert.ok(s.why.length > 15 && /^[a-z0-9-]+$/.test(s.id), s.id);
  for (const o of OWED) assert.ok(/^R[\w-]+/.test(o.owner) && o.finding.length > 20, `${o.where} ${o.shape}`);
  for (const e of EXEMPT) assert.ok(e.why.length > 20, e.where);
  assert.ok(new HttpError(500, "x") instanceof Error);
});

// ---- INV-R2d-4, the source half: a customer sentence in a component never carries a status token, an ISO timestamp or a Postgres error code ----
const SENTENCE_RULES: { id: string; re: RegExp }[] = [
  { id: "status-token-in-a-sentence", re: /\b(?:HYPOTHESIS|CONFIRMED|REFUTED)\b/ },
  { id: "iso-timestamp", re: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/ },
  { id: "postgres-code", re: /\b(?:23505|23503|23502|23514|42P01|42501|42703|40001|40P01|57014|22023|22P02|PGRST\d{3}|SQLSTATE)\b/ },
];
/** A string a person reads is a sentence: it holds a space. A bare token compared in code ("REFUTED") is not one. */
const isSentence = (s: string): boolean => /\S\s+\S/.test(s);
/** JSX text a person reads (between a tag and the next tag or expression) that holds a status token, and a stored token printed through an expression (`{x.statusToken}`). */
const JSX_TEXT_TOKEN = />([^<>{}]*\b(?:HYPOTHESIS|CONFIRMED|REFUTED)\b[^<>{}]*)[<{]/g;
const TOKEN_EXPRESSION = /\{[A-Za-z_.?!]*(?:statusToken|status_token)\}/g;
function sentenceViolations(text: string): string[] {
  const inStrings = jsStrings(text).filter(isSentence).flatMap((s) => SENTENCE_RULES.filter((r) => r.re.test(s)).map((r) => `${r.id}: ${s.slice(0, 70)}`));
  const inJsx = [...text.matchAll(JSX_TEXT_TOKEN)].map((m) => `status-token-in-a-sentence: ${(m[1] ?? "").trim().slice(0, 70)}`);
  const printed = [...text.matchAll(TOKEN_EXPRESSION)].map((m) => `status-token-in-a-sentence: ${m[0]}`);
  return [...inStrings, ...inJsx, ...printed];
}

test("INV-R2d-4 lint: no sentence in a component carries a status token, an ISO timestamp or a Postgres code (planted violations must be flagged)", () => {
  const planted = ['const a = "Inference · HYPOTHESIS";', "const b = `Updated 2026-10-13T10:00:00Z`;", 'const c = "failed with 23505 on the table";', 'if (x.status_token === "REFUTED") return null;', 'const ok = "Source ratings did not load.";', "<p>Inference · {x.statusToken}</p>", "<p>Verdict: HYPOTHESIS on this item</p>"];
  assert.deepEqual(planted.map((p) => sentenceViolations(p).length), [1, 1, 1, 0, 0, 1, 1], "the lint flags a sentence with a token, a timestamp or a code, and leaves a bare comparison alone");
  const found: string[] = [];
  for (const root of ["src/features", "src/ui"]) {
    for (const p of walk(root)) {
      if (!p.endsWith(".tsx")) continue;
      for (const v of sentenceViolations(readFileSync(p, "utf8"))) found.push(`${norm(p)}: ${v}`);
    }
  }
  const exempt = EXEMPT.filter((e) => SENTENCE_RULES.some((r) => r.id === e.shape)).map((e) => e.where);
  assert.deepEqual(found.filter((f) => !exempt.some((w) => f.startsWith(`${w}:`))), [], "write the customer's words, or give the file an exempt entry with its reason (an operator console)");
});

// ---- S2: a stated refusal is drawn from the ONE table (data/sentences.json, "refusal") ----
// A failed read returns `{ ok: false, reason }` and the component draws refusalSentence(reason). The sentences written inline before the table existed are a counted debt per file
// (refusal-literals.json): a new literal fails the test, and a file that paid some of its debt must lower its count here.
const REFUSAL_LITERAL = /did not load|could not be (?:loaded|read)|is unavailable|are unavailable/g;
const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

test("S2 lint: no new stated-refusal sentence is written inline (planted violations must be flagged); the inline ones left are a counted debt that only shrinks", () => {
  const count = (text: string): number => (withoutComments(text).match(REFUSAL_LITERAL) ?? []).length;
  assert.deepEqual(['<StateNote>The list did not load.</StateNote>', 'const m = "Search is unavailable right now.";', "<StateNote>{refusalSentence(\"coverage_unavailable\")}</StateNote>", "// the brief did not load: a comment"].map(count), [1, 1, 0, 0], "the lint flags an inline sentence and leaves a table lookup and a comment alone");
  const debt = refusalDebt as Record<string, number>;
  const found: Record<string, number> = {};
  for (const root of ["src/features", "src/ui"]) for (const p of walk(root)) if (/\.(tsx|ts)$/.test(p)) { const n = count(readFileSync(p, "utf8")); if (n > 0) found[norm(p)] = n; }
  const grew = Object.entries(found).filter(([f, n]) => n > (debt[f] ?? 0)).map(([f, n]) => `${f}: ${n} inline refusal sentence(s), ${debt[f] ?? 0} allowed: put the sentence in data/sentences.json and draw refusalSentence(reason)`);
  assert.deepEqual(grew, []);
  const paid = Object.entries(debt).filter(([f, n]) => (found[f] ?? 0) < n).map(([f, n]) => `${f}: ${found[f] ?? 0} left, ${n} recorded: lower refusal-literals.json (the debt was paid)`);
  assert.deepEqual(paid, []);
});

test("S2 the refusal table: every reason is a stated sentence free of every banned shape, and refusal() carries the reason a component maps back to it", () => {
  const reasons = Object.keys(sentences.refusal) as RefusalReason[];
  assert.ok(reasons.length >= 13);
  for (const reason of reasons) {
    const text = refusalSentence(reason);
    assert.match(text, /^[A-Za-z][a-z]+ [a-z]/, `${reason} is words`);
    for (const s of SHAPES) assert.ok(!s.rx.test(text), `${reason} carries the shape ${s.id}: ${text}`);
    assert.deepEqual(refusal(reason), { ok: false, reason });
  }
});
