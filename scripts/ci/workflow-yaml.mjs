// IMP-100: every .github/workflows/*.yml must parse as YAML, so a malformed workflow is refused here and not by a "workflow file issue" red run.
import { readdirSync, readFileSync } from "node:fs";

import { parse } from "yaml";

/** Returns one problem line per workflow that does not parse. */
export function workflowProblems(dir = ".github/workflows") {
  const problems = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")).sort()) {
    try {
      parse(readFileSync(`${dir}/${f}`, "utf8"), { prettyErrors: false });
    } catch (e) {
      problems.push(`${dir}/${f}: ${String(e.message).split("\n")[0]}`);
    }
  }
  return problems;
}
