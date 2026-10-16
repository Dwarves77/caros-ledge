// Tree rules: no personal identifier in a file, a valid Ported-from header on every file under src/ (or a line in
// scripts/ci/new-files/<slice>.txt), every header range inside the old file, and no banned dependency.
// Runs over the working tree (tracked plus untracked, minus ignored), so a local run sees what the PR will see.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0").filter((f) => f && existsSync(f));
const problems = [];

// The operator's name is held only as a hash, so the tree itself never contains it.
const BANNED_TOKEN_HASHES = new Set(["b8809c7a2aba20b78465f21cb521077f856c743bbf5d8dc36064d8283259f4c9"]);
const PATTERNS = [/@gmail\./i, /C:\\Users/i, /\/Users\/[A-Za-z]/];

for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  for (const re of PATTERNS) if (re.test(text)) problems.push(`${f}:1: matches ${re}`);
  for (const t of new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? [])) {
    if (BANNED_TOKEN_HASHES.has(createHash("sha256").update(t).digest("hex"))) problems.push(`${f}:1: banned token`);
  }
}

// One allow-file per slice: lines of `path | reason`.
const allowed = new Map();
for (const name of readdirSync("scripts/ci/new-files").filter((n) => n.endsWith(".txt"))) {
  for (const l of readFileSync(`scripts/ci/new-files/${name}`, "utf8").split("\n")) {
    if (!l || l.startsWith("#")) continue;
    const [path, ...reason] = l.split("|");
    allowed.set(path.trim(), reason.join("|").trim());
  }
}

// Header ranges are checked against the old tree's line counts (wc -l convention, scripts/ci/old-tree-lines.json).
const old = JSON.parse(readFileSync("scripts/ci/old-tree-lines.json", "utf8"));
const HEADER = /^\s*\/\/ Ported from old_repo\/(\S+) \(lines? ([\d, -]+)\)/;
for (const f of files.filter((x) => /\.(ts|tsx|js|mjs|css)$/.test(x) && /^(src|scripts|tests)\//.test(x))) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    if (!/^\s*\/\/ Ported from /.test(line)) return;
    const at = `${f}:${i + 1}`;
    const m = HEADER.exec(line);
    if (!m) return problems.push(`${at}: malformed Ported-from header`);
    const total = old.lines[m[1]];
    if (total === undefined) return problems.push(`${at}: ${m[1]} is not in the old tree at ${old.commit.slice(0, 9)}`);
    for (const r of m[2].split(",")) {
      const [a, b = a] = r.trim().split("-").map(Number);
      if (!(a >= 1 && a <= b && b <= total)) problems.push(`${at}: range ${r.trim()} outside 1-${total} of ${m[1]}`);
    }
  });
}
for (const f of files.filter((x) => x.startsWith("src/"))) {
  const head = readFileSync(f, "utf8").split("\n", 5).join("\n");
  if (/^\/\/ Ported from \S+ \(lines? \d+/m.test(head)) continue;
  if (!allowed.get(f)) problems.push(`${f}:1: no "// Ported from" header and no reason in scripts/ci/new-files/*.txt`);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
  if (/^@anthropic-ai\//.test(name) || name === "openai" || /browserless/.test(name)) problems.push(`package.json:1: banned dependency ${name}`);
  if (!(name in (pkg.budget ?? {}))) problems.push(`package.json:1: dependency ${name} has no budget line`);
}

for (const p of problems.slice(0, 10)) console.error(p);
if (problems.length > 10) console.error(`... and ${problems.length - 10} more`);
console.log(problems.length ? `${problems.length} problem(s)` : "tree-checks: clean");
process.exit(problems.length ? 1 : 0);
