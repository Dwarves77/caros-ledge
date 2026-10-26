// The propagation method version check (INV-202, G10): a method is registered under (table, id, version) and a derived row names the key that computed it, so the code behind a key must never change.
// "Changed behaviour takes a new version" was a sentence in a comment; this is the check. For every `registry.register(table, ID, VERSION, fn)` under src/core/propagation it hashes the code the registration runs
// (the registered expression and, transitively, every value declaration in the propagation directory it names; comments and layout do not count, the syntax tree does) and compares it with the hash recorded for that
// key in scripts/ci/data/method-hashes.json. It fails when
//   - a recorded key's code changed and its version did not (register a NEW version; the old key stays registered so rows computed by it stay reproducible),
//   - a registered key has no record (a new method or version: `node scripts/ci/method-versions.mjs --write` records it),
//   - a recorded key is no longer registered (a derived row can still name it), unless scripts/ci/data/method-retired.json retires it by name: a retirement states the reason and the registered successor of the same method id, and the rows the key computed stay as they are
//     (the drain leaves a value whose method is unregistered stale, and the next run supersedes it under the successor). A retired key that is still registered, or whose successor is not, is a problem too.
// `--write` records the current hashes of keys that are new and refuses to overwrite one whose code changed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import ts from "typescript";

import { isMain, walk } from "../lib/fs.mjs";

export const HASH_FILE = "scripts/ci/data/method-hashes.json";
export const RETIRED_FILE = "scripts/ci/data/method-retired.json";
// A method's code is the registration, every value declaration it reaches and every JSON table those declarations import (a threshold in data/rules.json is part of the method). The methods live in propagation; the impact score's pure code and rules in impact; the five pattern detectors, their thresholds and fact adapters in flywheel/patterns, and the coupling vocabulary they read in coupling.
export const DIRS = ["src/core/propagation", "src/core/impact", "src/core/flywheel/patterns", "src/core/coupling"];
const TABLES = new Set(["derived_values", "inference_records", "item_impact_scores"]);

const sha = (text) => createHash("sha256").update(text).digest("hex");
const printer = ts.createPrinter({ removeComments: true });

/** Every top-level value declaration (function, class, enum, variable) of the files: name -> { text (comments and layout removed), refs (the identifiers it mentions) }. */
function declarationsOf(files) {
  const decls = new Map();
  const add = (name, node, sf) => {
    const refs = new Set();
    const visit = (n) => {
      if (ts.isIdentifier(n)) refs.add(n.text);
      ts.forEachChild(n, visit);
    };
    visit(node);
    // The `export` keyword is not behaviour: exporting or unexporting a helper the method reaches does not change the method.
    decls.set(name, { text: printer.printNode(ts.EmitHint.Unspecified, node, sf).replace(/^export\s+(?:default\s+)?/, ""), refs, node });
  };
  for (const [file, text] of files) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      // A JSON table the file imports is a value the code reaches: its content hash stands for it, so editing a threshold is editing the method.
      if (ts.isImportDeclaration(st) && st.importClause?.name && ts.isStringLiteralLike(st.moduleSpecifier) && st.moduleSpecifier.text.endsWith(".json")) {
        const path = resolve(dirname(file), st.moduleSpecifier.text);
        if (existsSync(path)) decls.set(st.importClause.name.text, { text: `json ${st.moduleSpecifier.text} ${sha(JSON.stringify(JSON.parse(readFileSync(path, "utf8"))))}`, refs: new Set(), node: st });
        continue;
      }
      if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) add(st.name.text, st, sf);
      else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) add(d.name.text, d, sf);
    }
  }
  return decls;
}

/** The registrations in the files: [{ file, line, table, id, version, expr }] with id and version resolved to their string values. */
export function registrationsOf(files) {
  const decls = declarationsOf(files);
  const literal = (node) => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) {
      const init = decls.get(node.text)?.node?.initializer;
      return init && ts.isStringLiteralLike(init) ? init.text : null;
    }
    return null;
  };
  const found = [];
  for (const [file, text] of files) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "register" && n.arguments.length === 4 && ts.isStringLiteralLike(n.arguments[0]) && TABLES.has(n.arguments[0].text)) {
        const [table, id, version, expr] = n.arguments;
        found.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, table: table.text, id: literal(id), version: literal(version), expr });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { found, decls };
}

/** The hash of the code a registration runs: its expression and the value declarations it reaches by name, sorted so the order of the file does not matter. */
function hashOf(reg, decls) {
  const sf = reg.expr.getSourceFile();
  const seen = new Set();
  const queue = [];
  const mention = (node) => {
    if (ts.isIdentifier(node)) queue.push(node.text);
    ts.forEachChild(node, mention);
  };
  mention(reg.expr);
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name) || !decls.has(name)) continue;
    seen.add(name);
    queue.push(...decls.get(name).refs);
  }
  return sha([printer.printNode(ts.EmitHint.Unspecified, reg.expr, sf), ...[...seen].sort().map((n) => `${n}=${decls.get(n).text}`)].join("\n"));
}

/** The current method keys: Map "table:id@version" -> { hash, where }. */
export function currentMethods(files) {
  const { found, decls } = registrationsOf(files);
  const out = new Map();
  const problems = [];
  for (const reg of found) {
    if (!reg.id || !reg.version) {
      problems.push(`${reg.file}:${reg.line}: a method registration whose id or version is not a string literal or a const holding one: the key cannot be read`);
      continue;
    }
    out.set(`${reg.table}:${reg.id}@${reg.version}`, { hash: hashOf(reg, decls), where: `${reg.file}:${reg.line}` });
  }
  return { methods: out, problems };
}

/** Compare the current methods with the recorded hashes. Returns the problem lines. */
export function versionProblems(methods, recorded, retired = {}) {
  const problems = [];
  for (const [key, m] of methods) {
    if (!(key in recorded)) problems.push(`${m.where}: ${key} is registered but not recorded in ${HASH_FILE}: run \`node scripts/ci/method-versions.mjs --write\` and commit it`);
    else if (recorded[key] !== m.hash) problems.push(`${m.where}: ${key}: the code its registration runs changed and its version did not. A released method is never edited (INV-202): register the new behaviour under a new version and keep this one`);
  }
  for (const key of Object.keys(recorded)) {
    if (methods.has(key)) continue;
    const r = retired[key];
    if (!r) problems.push(`${HASH_FILE}: ${key} is recorded but no longer registered: a derived row can still name it (retire it in ${RETIRED_FILE} with its successor and the reason, or keep it registered)`);
    else if (!methods.has(r.successor)) problems.push(`${RETIRED_FILE}: ${key} is retired in favour of ${String(r.successor)}, which is not registered`);
  }
  for (const [key, r] of Object.entries(retired)) {
    if (methods.has(key)) problems.push(`${RETIRED_FILE}: ${key} is retired but still registered`);
    if (!(key in recorded)) problems.push(`${RETIRED_FILE}: ${key} was never recorded in ${HASH_FILE}`);
    if (typeof r.reason !== "string" || r.reason.trim().length < 20) problems.push(`${RETIRED_FILE}: ${key} states no reason`);
  }
  return problems;
}

const methodFiles = () => new Map(DIRS.flatMap((dir) => walk(dir, (n) => /\.ts$/.test(n))).map((f) => [f, readFileSync(f, "utf8")]));

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { write: { type: "boolean", default: false } }, strict: true });
  const { methods, problems: unreadable } = currentMethods(methodFiles());
  const recorded = existsSync(HASH_FILE) ? JSON.parse(readFileSync(HASH_FILE, "utf8")) : {};
  const retired = existsSync(RETIRED_FILE) ? JSON.parse(readFileSync(RETIRED_FILE, "utf8")) : {};
  let problems = [...unreadable, ...versionProblems(methods, recorded, retired)];
  if (values.write) {
    const next = { ...recorded };
    for (const [key, m] of methods) if (!(key in recorded)) next[key] = m.hash;
    writeFileSync(HASH_FILE, `${JSON.stringify(Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`);
    problems = problems.filter((p) => !p.includes("is registered but not recorded"));
  }
  for (const p of problems) console.error(p);
  console.log(problems.length ? `method-versions: ${problems.length} problem(s)` : `method-versions: ${methods.size} method(s), none changed under its version`);
  process.exit(problems.length ? 1 : 0);
}
