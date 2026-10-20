// P5 and INV-R2f-5: the parse module is data-driven. Units, gases, scale words, locale glyphs and identifier schemes live in src/core/parse/data/*.json; no literal of
// them may appear in the code of the parse module, Gate A, the mint gates, the slot matcher, the mention matcher or any consumer of the parse module (the R2f write set: the healer, the verbatim and number rules, the URL and host readers, the timeline, the deriver, the claim-tier view model). The check reads the data to know what
// is forbidden (nothing here to loosen), parses each file, and refuses a string, template or regular-expression literal that spells one. A planted literal is red.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import ts from "typescript";

import { LOCALE_FILE, UNIT_FILE } from "@/core/parse/data";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NON_ASCII = /[^\x00-\x7f]/;

interface Forbidden { label: string; test: (literal: string) => boolean }
function forbidden(): Forbidden[] {
  const out: Forbidden[] = [];
  const add = (label: string, alias: string, exact: boolean) => {
    if (NON_ASCII.test(alias)) out.push({ label, test: (l) => l.includes(alias) });
    else if (alias.length >= 2) {
      // A letter-hyphen-letter compound is one word ("EUR-Lex" is a publisher, not the euro): the alias must not be glued to a letter through a hyphen either.
      const re = new RegExp(`(?<![A-Za-z0-9]|[A-Za-z]-)${escape(alias).replace(/ /g, "\\s+")}(?![A-Za-z0-9]|-[A-Za-z])`, exact ? "" : "i");
      out.push({ label, test: (l) => re.test(l) });
    }
  };
  for (const u of UNIT_FILE.units) {
    for (const s of u.symbols) add(`unit symbol ${s}`, s, !u.money);
    for (const w of u.words) add(`unit word ${w}`, w, false);
  }
  for (const g of UNIT_FILE.gases) for (const a of g.aliases) add(`gas ${a}`, a, false);
  for (const s of UNIT_FILE.scales) add(`scale word ${s.word}`, s.word, false);
  for (const c of [...LOCALE_FILE.groupSpaces, ...LOCALE_FILE.minusSigns]) if (NON_ASCII.test(c)) out.push({ label: `locale glyph U+${c.codePointAt(0)?.toString(16)}`, test: (l) => l.includes(c) });
  return out;
}

/** Every string, template and regular-expression literal of a source file that spells a unit, gas, scale word or locale glyph from the data. */
export function literalViolations(source: string, file = "planted.ts"): string[] {
  const rules = forbidden();
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const check = (node: ts.Node, text: string) => {
    for (const r of rules) if (r.test(text)) found.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}: literal ${JSON.stringify(text.slice(0, 40))} spells ${r.label}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node)) check(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const REPO_FILES = [
  ...readdirSync("src/core/parse").filter((n) => n.endsWith(".ts")).map((n) => `src/core/parse/${n}`),
  "src/core/grounding/gate-a-scan.ts", "src/core/grounding/gates.ts", "src/core/grounding/slots.ts", "src/core/entities/mentions.ts",
  // INV-R2f-5: the consumers of the parse module
  "src/core/brief/timeline.ts", "src/core/contracts/numbers.ts", "src/core/contracts/verbatim.ts", "src/core/grounding/ground.ts", "src/core/grounding/pool.ts", "src/core/intake/identity.ts", "src/core/shared/url.ts",
  "src/features/batches/kinds/question-answers/validate.ts", "src/features/intake/quarantine/resolver.ts", "src/features/intake/record-facts/extract.ts", "src/features/mint/heal/brief-honest.ts", "src/features/mint/heal/ground.ts",
  "src/features/mint/heal/run.ts", "src/features/mint/preflight.ts", "src/features/obligations/derive/derive-objects.ts", "src/features/sources/holdings-audit.ts", "src/features/sources/snapshot-verify.ts",
  "src/features/sources/verify-candidate.ts", "src/ui/claim-tier.ts",
];

test("the parse module and every consumer of it (Gate A, the mint gates, the slot and mention matchers, the healer, the URL and host readers, the view model) hold no unit, gas, scale or locale literal", () => {
  assert.ok(REPO_FILES.length >= 30, REPO_FILES.join(", "));
  const all = REPO_FILES.flatMap((f) => literalViolations(readFileSync(f, "utf8"), f));
  assert.deepEqual(all, []);
});

test("a planted literal is red: a unit in a string, a gas in a template, a currency sign in a regex, a no-break space, a scale word", () => {
  const plant = (body: string) => literalViolations(`export function planted(x: string) {\n  ${body}\n}\n`);
  assert.ok(plant('return x === "kg";').length >= 1, 'return x === "kg";');
  assert.ok(plant('return x.endsWith("TEU-km");').length >= 1, 'return x.endsWith("TEU-km");');
  assert.ok(plant("return `${x} CO2e`;").length >= 1, "return `${x} CO2e`;");
  assert.ok(plant("return /€\\d+/.test(x);").length >= 1, "return /€\\d+/.test(x);");
  assert.ok(plant('return x.split(" ");').length >= 1, 'return x.split(" ");');
  assert.ok(plant('return x.replace("million", "");').length >= 1, 'return x.replace("million", "");');
  assert.ok(plant('return x.includes("tonnes");').length >= 1, 'return x.includes("tonnes");');
  assert.ok(plant('return x.replace("EUR", "");').length >= 1, 'return x.replace("EUR", "");');
  assert.deepEqual(plant('return x.trim().toLowerCase() === "total";'), [], "an ordinary string is not a unit");
  assert.deepEqual(plant('return x === "eur-lex.europa.eu";'), [], "EUR-Lex is a publisher: a unit alias glued to a word through a hyphen is not that unit");
  assert.deepEqual(literalViolations('import u from "./data/units.json";\nexport const a = u;\n'), [], "a module specifier is not a literal of the module");
});
