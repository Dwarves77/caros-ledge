// Code lines (non-blank, non-comment) per directory under src/. Exit 1 when a directory exceeds its pinned LIMIT (LOCK-NO-BLOAT-1: the post-cleanup counts; a cut lowers the pin, growth is a problem).
import { appendFileSync, readFileSync } from "node:fs";

import { isMain, walk } from "../lib/fs.mjs";

// LOCK-NO-BLOAT-2 2026-10-31: re-pinned to actuals after the customer-context wave; src only shrinks from here (operator-override marker required to raise).
export const LIMITS = { src: 67640, "src/core": 20905, "src/core/brief": 1334, "src/core/digest": 270, "src/features": 40040 };
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs)$/;

/** The code lines of one source text: blank lines, `//` lines and block comments do not count. */
export function codeLines(text) {
  let inBlock = false;
  let n = 0;
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
    }
    while (line.startsWith("/*")) {
      const end = line.indexOf("*/", 2);
      if (end < 0) {
        inBlock = true;
        line = "";
        break;
      }
      line = line.slice(end + 2).trim();
    }
    if (line && !line.startsWith("//")) n += 1;
  }
  return n;
}

/**
 * The code lines of every directory under `root`, keyed by its posix path ("src", "src/core", ...): a file counts toward its directory and every ancestor. The keys are posix on every platform
 * (`walk` returns posix paths), so a limit named "src/core" is compared with the lines of src/core on Windows too.
 */
export function totalsOf(root = "src") {
  const totals = new Map();
  for (const file of walk(root, (name) => CODE_FILE.test(name))) {
    const n = codeLines(readFileSync(file, "utf8"));
    const parts = file.split("/").slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const key = parts.slice(0, depth).join("/");
      totals.set(key, (totals.get(key) ?? 0) + n);
    }
  }
  return totals;
}

/** One line per limit the totals exceed. A limit whose directory holds no code at all is a problem too: a gate that compares nothing is not a gate. */
export function limitProblems(totals, limits = LIMITS) {
  return Object.entries(limits).flatMap(([dir, max]) => {
    const n = totals.get(dir);
    if (n === undefined) return [`${dir} has no code lines at all: the limit ${max} compared nothing (a path-key defect)`];
    return n > max ? [`${dir} has ${n} code lines, limit ${max}`] : [];
  });
}

if (isMain(import.meta.url)) {
  const totals = totalsOf("src");
  const rows = [...totals].sort(([a], [b]) => a.localeCompare(b)).filter(([k]) => k.split("/").length <= 3);
  const table = ["| directory | code lines |", "|---|---|", ...rows.map(([k, n]) => `| ${k} | ${n} |`)].join("\n");
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Code lines\n\n${table}\n`);
  const problems = limitProblems(totals);
  for (const p of problems) console.error(p);
  process.exit(problems.length ? 1 : 0);
}
