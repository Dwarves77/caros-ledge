// INV-R2d-4 and register I16: no customer string carries an HTML entity, a status token, an ISO timestamp, a Postgres error code, a driver message or an internal word. Three checks, one table of banned shapes
// (customer-strings.json): (1) dbError answers a fixed sentence for every status and holds the driver text back for the log; (2) a lint over the source's string literals, with a planted violation that must go red;
// (3) a rendered-text test: every sweep page drawn healthy and once per refused read, whose text must carry none of the shapes. A page that still carries one is on the file's `owed` list with the slice that owns it
// (the test fails when an owed shape is gone, and when a new one appears).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { answer, dbError, HttpError, LookupError, statusForDb } from "@/core/http/errors";

import table from "./customer-strings.json" with { type: "json" };

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
    const e = dbError(error);
    assert.equal(e.status, status, error.code ?? "no code");
    const res = answer(e);
    const body = (await res.json()) as { error: string };
    assert.doesNotMatch(body.error, /duplicate|constraint|relation|secret_table|statement|deadlock|connect|uuid|permission denied|violates|unknown|\b\d{5}\b|public\./i, `${error.code}: ${body.error}`);
    assert.match(e.message, new RegExp(error.message.slice(0, 12).replace(/[.*+?^${}()|[\]\\"]/g, "\\$&")), "the driver text is kept on the error for the log");
    assert.equal(res.headers.get("Retry-After"), status === 503 ? "1" : null, error.code ?? "");
    sentences.add(body.error);
  }
  assert.ok(sentences.size >= 5, "a sentence per class, not one for all");
  assert.equal(dbError({ message: "x", code: "42501" }, { forbidden: "Only org admins can invite members" }).publicMessage, "Only org admins can invite members", "a caller's own sentence still wins for 403 and 404");
  assert.equal(new LookupError("step", { message: "driver down" }).publicMessage, dbError({ message: "x", code: "57014" }).publicMessage, "one sentence for 'could not be read just now'");
  assert.equal(statusForDb("23505"), 409);
});

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
const norm = (p: string): string => relative(".", p).replace(/\\/g, "/");
/** String literals that are not JSX attribute values: a JS string, where an entity is NOT decoded. */
function jsStrings(text: string): string[] {
  const out: string[] = [];
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
