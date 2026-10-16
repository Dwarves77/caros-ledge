// Code lines (non-blank, non-comment) per directory under src/. Exit 1 when src/core > 25000 or src > 75000.
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LIMITS = { "src/core": 25000, src: 75000 };
const EXT = /\.(ts|tsx|js|jsx|mjs)$/;

function codeLines(file) {
  let inBlock = false;
  let n = 0;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
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

const totals = new Map();
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (EXT.test(e.name)) {
      const n = codeLines(p);
      const parts = dir.split("/");
      for (let depth = 1; depth <= parts.length; depth += 1) {
        const key = parts.slice(0, depth).join("/");
        totals.set(key, (totals.get(key) ?? 0) + n);
      }
    }
  }
}
walk("src");

const rows = [...totals].sort(([a], [b]) => a.localeCompare(b)).filter(([k]) => k.split("/").length <= 3);
const failures = Object.entries(LIMITS).filter(([k, max]) => (totals.get(k) ?? 0) > max);
const table = ["| directory | code lines |", "|---|---|", ...rows.map(([k, n]) => `| ${k} | ${n} |`)].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Code lines\n\n${table}\n`);
for (const [k, max] of failures) console.error(`${k} has ${totals.get(k)} code lines, limit ${max}`);
process.exit(failures.length ? 1 : 0);
