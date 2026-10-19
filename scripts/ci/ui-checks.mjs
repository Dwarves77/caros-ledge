// The UI checks (ui-kit.md proof 3, grown into G4): the laws of the kit and the screens, read from the TypeScript syntax tree and the stylesheets. Run from the repo root; exits 1 with every offence listed.
//
//   node scripts/ci/ui-checks.mjs               check src/ against scripts/ci/ui-checks-allow.json
//   node scripts/ci/ui-checks.mjs --list-rules  the rule ids (tests/ci/ui-checks.test.mjs holds one planted violation for each and fails on a rule without one)
//   node scripts/ci/ui-checks.mjs --counts      the offences found, counted per rule and file, as JSON (how an allow list is written down or lowered)
//
// The rules are in scripts/ci/ui-rules.mjs. Debt that predates a rule is in ui-checks-allow.json as a COUNT per rule and file with the reason and the slice that owes the fix; the count is a ratchet:
// one more offence than allowed fails, and one fewer fails too (lower the number), so the debt can only go down and an entry cannot outlive its cause. A file entry is a count, or {count, reason} when
// that file needs a reason of its own beside the rule's.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

import { RULES } from "./ui-rules.mjs";

const ALLOW_FILE = "scripts/ci/ui-checks-allow.json";
const MIN_REASON = 20;

if (process.argv.includes("--list-rules")) {
  console.log(RULES.map((r) => r.id).join("\n"));
  process.exit(0);
}

const files = [];
(function walk(dir) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name).replaceAll("\\", "/");
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(e.name)) files.push(p);
  }
})("src");
files.sort();

const text = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const stripped = (f) => text.get(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
// The context some rules need: the custom properties that exist (theme.css, or set by code under src/ui) and the classes base.css defines.
const defined = new Set();
for (const f of files.filter((x) => x.startsWith("src/ui/"))) {
  for (const m of stripped(f).matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(m[1]);
  for (const m of stripped(f).matchAll(/"(--[a-z0-9-]+)"/g)) defined.add(m[1]);
}
const defClasses = new Set([...(text.get("src/ui/base.css") ?? "").matchAll(/\.(cl-[a-z0-9-]+)/g)].map((m) => m[1]));

const found = new Map(RULES.map((r) => [r.id, new Map()]));
for (const f of files) {
  const scoped = RULES.filter((r) => r.scope(f));
  if (!scoped.length) continue;
  const sf = /\.tsx?$/.test(f) ? ts.createSourceFile(f, text.get(f), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS) : null;
  for (const r of scoped) {
    const hits = [...r.check({ file: f, text: text.get(f), sf, defined, defClasses })];
    if (hits.length) found.get(r.id).set(f, hits);
  }
}

if (process.argv.includes("--counts")) {
  console.log(JSON.stringify(Object.fromEntries([...found].filter(([, m]) => m.size).map(([id, m]) => [id, Object.fromEntries([...m].map(([f, h]) => [f, h.length]))])), null, 2));
  process.exit(0);
}

const problems = [];
const allow = existsSync(ALLOW_FILE) ? JSON.parse(readFileSync(ALLOW_FILE, "utf8")).rules ?? {} : {};
for (const [id, a] of Object.entries(allow)) {
  if (!RULES.some((r) => r.id === id)) problems.push(`${ALLOW_FILE}: names the rule ${id}, which does not exist`);
  if (typeof a.reason !== "string" || a.reason.trim().length < MIN_REASON) problems.push(`${ALLOW_FILE}: ${id} carries no reason (at least ${MIN_REASON} characters)`);
  if (typeof a.owner !== "string" || !a.owner) problems.push(`${ALLOW_FILE}: ${id} names no owner (the slice that removes the debt)`);
  for (const [f, v] of Object.entries(a.files ?? {})) {
    const n = typeof v === "number" ? v : v?.count;
    if (!Number.isInteger(n) || n < 1) problems.push(`${ALLOW_FILE}: ${id} ${f} must allow a whole number of offences, at least 1`);
    if (typeof v === "object" && (typeof v.reason !== "string" || v.reason.trim().length < MIN_REASON)) problems.push(`${ALLOW_FILE}: ${id} ${f} carries no reason of its own (at least ${MIN_REASON} characters)`);
  }
}
for (const r of RULES) {
  const allowed = allow[r.id]?.files ?? {};
  for (const f of new Set([...found.get(r.id).keys(), ...Object.keys(allowed)])) {
    const hits = found.get(r.id).get(f) ?? [];
    const n = typeof allowed[f] === "object" ? allowed[f].count : (allowed[f] ?? 0);
    if (hits.length > n) for (const h of hits) problems.push(`${f}:${h.line}: ${h.message} (${r.id}${n ? `; ${n} allowed in this file, ${hits.length} found` : ""}): ${r.law}`);
    else if (hits.length < n) problems.push(`${ALLOW_FILE}: ${r.id} allows ${n} in ${f} and finds ${hits.length}; lower the count (the debt was paid)`);
  }
}

for (const p of [...new Set(problems)]) console.error(p);
console.log(problems.length ? `ui-checks: ${new Set(problems).size} problem(s)` : `ui-checks: clean (${files.length} files, ${RULES.length} rules)`);
process.exit(problems.length ? 1 : 0);
