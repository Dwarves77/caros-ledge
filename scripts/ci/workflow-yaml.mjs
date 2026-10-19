// IMP-100: every .github/workflows/*.yml must be a valid workflow, so a malformed one is refused here and not by a "workflow file issue" red run. Two layers: the YAML must parse, and the pinned actionlint
// (the actionlint npm package, the project's own wasm build, version fixed in package.json) must find nothing: unknown `needs`, a bad `if` or ${{ }} expression, a missing `runs-on`, an unknown context
// property are schema and expression errors a YAML parse cannot see, and they are what produced the "workflow file issue" reds.
import { readdirSync, readFileSync } from "node:fs";

import { createLinter } from "actionlint";
import { parse } from "yaml";

import { isMain } from "../lib/fs.mjs";

/** The text of one workflow: the problems the YAML parser and actionlint report, one `file:line: message` each. Pure given the text. */
export async function textProblems(file, text, lint) {
  try {
    parse(text, { prettyErrors: false });
  } catch (e) {
    return [`${file}: ${String(e.message).split("\n")[0]}`];
  }
  return lint(text, file).map((r) => `${file}:${r.line}: ${r.message} [${r.kind}]`);
}

/** Returns one problem line per defect of every workflow under `dir`. */
export async function workflowProblems(dir = ".github/workflows") {
  const lint = await createLinter();
  const problems = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")).sort()) problems.push(...(await textProblems(`${dir}/${f}`, readFileSync(`${dir}/${f}`, "utf8"), lint)));
  return problems;
}

if (isMain(import.meta.url)) {
  const problems = await workflowProblems();
  for (const p of problems) console.error(p);
  console.log(problems.length ? `workflow-yaml: ${problems.length} problem(s)` : "workflow-yaml: clean");
  process.exit(problems.length ? 1 : 0);
}
