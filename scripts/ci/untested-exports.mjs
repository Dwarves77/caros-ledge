// The tested-exports ratchet (G12, C:119, D:139, D:140). An export nothing in tests/ names is code the suite cannot catch: 23 core exports (the gate read, the headless tier, the streamed byte cap) had no test at all and
// three audits found the defects in exactly such code. This reads src, tests and scripts as one graph (scripts/ci/connections/graph.mjs: a use is a use in code, not a word in a comment or a string) and lists every
// value export of a .ts file under src that no test file reaches (a test that imports it, or the barrel that re-exports it, and uses it). The tree has 1,500 such exports today; tests/ci/untested-exports.json names each one
// and the list only shrinks: a NEW export with no test fails the suite, and so does an entry that is now tested or gone (delete it). `node scripts/ci/untested-exports.mjs --write` drops the entries that
// are no longer offenders and never adds one (adding an entry would be loosening the check); the test is tests/ci/exports-have-tests.test.mjs. Components (.tsx), the Next.js files
// (src/app, the instrumentation hook) and type exports are not in scope: pages are swept by the UI checks, a type has no behaviour.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { isMain, posix, walk } from "../lib/fs.mjs";

import { buildGraph } from "./connections/graph.mjs";

export const LIST_FILE = "tests/ci/untested-exports.json";
const NEXT_FILES = /^src\/app\/|^src\/instrumentation\.ts$/;

/** { "src/file.ts": ["name", ...] } for every value export no test reaches. */
export function untestedExports(root = ".") {
  const base = posix(root);
  const under = (dir, rx) => walk(`${base}/${dir}`, (n) => rx.test(n)).map((p) => p.slice(base.length + 1));
  const src = under("src", /\.ts$/);
  const others = [...under("tests", /\.(ts|tsx|mjs)$/), ...under("scripts", /\.mjs$/), ...under("src", /\.tsx$/)];
  const graph = buildGraph(new Map([...src, ...others].map((p) => [p, readFileSync(`${base}/${p}`, "utf8")])));
  const out = {};
  for (const file of src) {
    if (NEXT_FILES.test(file)) continue;
    for (const [name, e] of graph.info.get(file).exports) {
      if (e.kind !== "value") continue;
      const defined = graph.defining(file, name);
      if (!defined || defined[0] !== file) continue;
      if (![...(graph.usedBy.get(`${file}#${name}`) ?? [])].some((u) => u.startsWith("tests/"))) (out[file] ??= []).push(name);
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)).map(([f, names]) => [f, names.sort()]));
}

/** The problems of the committed list against the tree: a new untested export, and an entry that is no longer one. */
export function listProblems(found, listed) {
  const problems = [];
  for (const [file, names] of Object.entries(found)) {
    for (const name of names) if (!(listed[file] ?? []).includes(name)) problems.push(`${file}: \`${name}\` is exported and no test names it: add a test (a planted violation where it guards something), do not add it to ${LIST_FILE}`);
  }
  for (const [file, names] of Object.entries(listed)) {
    for (const name of names) if (!(found[file] ?? []).includes(name)) problems.push(`${LIST_FILE}: ${file}#${name} is now tested or gone: delete the entry (the list only shrinks)`);
  }
  return problems;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { write: { type: "boolean", default: false } }, strict: true });
  const found = untestedExports();
  const listed = JSON.parse(readFileSync(LIST_FILE, "utf8")).exports;
  if (values.write) {
    // The list may only shrink: an entry is kept only if it is still an offender, and nothing is added.
    const next = Object.fromEntries(Object.entries(listed).map(([f, names]) => [f, names.filter((n) => (found[f] ?? []).includes(n))]).filter(([, names]) => names.length));
    writeFileSync(LIST_FILE, `${JSON.stringify({ _why: JSON.parse(readFileSync(LIST_FILE, "utf8"))._why, exports: next }, null, 1)}\n`);
    console.log(`untested-exports: ${Object.values(next).flat().length} entries kept`);
  } else {
    const problems = listProblems(found, listed);
    for (const p of problems) console.error(p);
    console.log(problems.length ? `untested-exports: ${problems.length} problem(s)` : `untested-exports: ${Object.values(found).flat().length} untested exports, all listed`);
    process.exit(problems.length ? 1 : 0);
  }
}
