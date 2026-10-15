// Tree rules: no personal identifier in a tracked file, a Ported-from header on every file under src/
// (or a line in new-files.txt), and no banned dependency.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
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
  for (const re of PATTERNS) if (re.test(text)) problems.push(`${f}: matches ${re}`);
  for (const t of new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? [])) {
    if (BANNED_TOKEN_HASHES.has(createHash("sha256").update(t).digest("hex"))) problems.push(`${f}: banned token`);
  }
}

const allowed = new Map(
  readFileSync("scripts/ci/new-files.txt", "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => {
    const [path, ...reason] = l.split("|");
    return [path.trim(), reason.join("|").trim()];
  }),
);
for (const f of files.filter((x) => x.startsWith("src/"))) {
  const head = readFileSync(f, "utf8").split("\n", 5).join("\n");
  if (/^\/\/ Ported from \S+ \(lines \d+-\d+\)/m.test(head)) continue;
  if (!allowed.get(f)) problems.push(`${f}: no "// Ported from" header and no reason in scripts/ci/new-files.txt`);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
  if (/^@anthropic-ai\//.test(name) || name === "openai" || /browserless/.test(name)) problems.push(`package.json: banned dependency ${name}`);
  if (!(name in (pkg.budget ?? {}))) problems.push(`package.json: dependency ${name} has no budget line`);
}

for (const p of problems) console.error(p);
console.log(problems.length ? `${problems.length} problem(s)` : "tree-checks: clean");
process.exit(problems.length ? 1 : 0);
