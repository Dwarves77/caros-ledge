// Tree rules: no personal identifier in a file, a valid Ported-from header on every file under src/ (or a line in
// scripts/ci/new-files/<slice>.txt), every header range inside the old file, and no banned dependency.
// Runs over the working tree (tracked plus untracked, minus ignored), so a local run sees what the PR will see.
// Each rule is a pure function of its input (exported, tried against planted inputs in tests/ci/tree-checks.test.mjs); the main below only reads the tree and calls them.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { isMain } from "../lib/fs.mjs";

import { trackedOutputProblems } from "./tracked-output.mjs";

// The operator's name is held only as a hash, so the tree itself never contains it.
const BANNED_TOKEN_HASHES = new Set(["b8809c7a2aba20b78465f21cb521077f856c743bbf5d8dc36064d8283259f4c9"]);
/** A home directory of a person (Windows with either slash, macOS, Linux; a path inside a URL or a repo directory named `home` is not one) and a personal mail address (the common providers). */
export const PATTERNS = [/C:[\\/]+Users[\\/]/i, /(?<![\w/.-])\/Users\/[A-Za-z]/, /(?<![\w/.-])\/home\/[a-z][\w.-]*\//, /@(?:gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|proton|protonmail|aol)\.(?:com|net|me|org)\b/i];

/** One problem per pattern a text matches and per banned token it holds. */
export function identifierProblems(path, text) {
  const problems = [];
  if (text.includes("\0")) return problems;
  for (const re of PATTERNS) if (re.test(text)) problems.push(`${path}:1: matches ${re}`);
  for (const t of new Set(text.toLowerCase().match(/[a-z]{4,}/g) ?? [])) {
    if (BANNED_TOKEN_HASHES.has(createHash("sha256").update(t).digest("hex"))) problems.push(`${path}:1: banned token`);
  }
  return problems;
}

/** The push gate cannot be deleted quietly: package.json "prepare" wires core.hooksPath, the script it names does it, and .githooks/pre-push is executable in the index (git mode 100755). */
export function pushGateProblems({ packageText, prepareText, hookMode }) {
  const problems = [];
  const prepare = JSON.parse(packageText).scripts?.prepare;
  if (prepare !== "node scripts/prepare.mjs" || !prepareText || !prepareText.includes(".githooks")) problems.push("package.json:1: the prepare script that sets core.hooksPath to .githooks is missing");
  if (hookMode !== "100755") problems.push(`.githooks/pre-push:1: missing or not executable in the index (mode ${hookMode || "none"}, want 100755)`);
  return problems;
}

const HEADER = /^\s*\/\/ Ported from old_repo\/(\S+) \(lines? ([\d, -]+)\)/;
/** Header ranges are checked against the old tree's line counts (wc -l convention, scripts/ci/old-tree-lines.json): `old` is that file's {commit, lines}. */
export function headerRangeProblems(path, text, old) {
  const problems = [];
  text.split("\n").forEach((line, i) => {
    if (!/^\s*\/\/ Ported from /.test(line)) return;
    const at = `${path}:${i + 1}`;
    const m = HEADER.exec(line);
    if (!m) return problems.push(`${at}: malformed Ported-from header`);
    const total = old.lines[m[1]];
    if (total === undefined) return problems.push(`${at}: ${m[1]} is not in the old tree at ${old.commit.slice(0, 9)}`);
    for (const r of m[2].split(",")) {
      const [a, b = a] = r.trim().split("-").map(Number);
      if (!(a >= 1 && a <= b && b <= total)) problems.push(`${at}: range ${r.trim()} outside 1-${total} of ${m[1]}`);
    }
  });
  return problems;
}

/** A file under src/ carries a Ported-from header in its first lines or has a reason in the allow-files (`allowed`: path to reason). */
export function sourceOriginProblems(path, text, allowed) {
  if (/^\/\/ Ported from \S+ \(lines? \d+/m.test(text.split("\n", 5).join("\n"))) return [];
  return allowed.get(path) ? [] : [`${path}:1: no "// Ported from" header and no reason in scripts/ci/new-files/*.txt`];
}

/** A dependency is not banned and has a budget line saying why it exists. */
export function dependencyProblems(pkg) {
  const problems = [];
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (/^@anthropic-ai\//.test(name) || name === "openai" || /browserless/.test(name)) problems.push(`package.json:1: banned dependency ${name}`);
    if (!(name in (pkg.budget ?? {}))) problems.push(`package.json:1: dependency ${name} has no budget line`);
  }
  return problems;
}

function allowFiles() {
  const allowed = new Map();
  for (const name of readdirSync("scripts/ci/new-files").filter((n) => n.endsWith(".txt"))) {
    for (const l of readFileSync(`scripts/ci/new-files/${name}`, "utf8").split("\n")) {
      if (!l || l.startsWith("#")) continue;
      const [path, ...reason] = l.split("|");
      allowed.set(path.trim(), reason.join("|").trim());
    }
  }
  return allowed;
}

/** Every problem of the working tree. */
export function treeProblems() {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter((f) => f && existsSync(f));
  const problems = [];
  const text = new Map();
  for (const f of files) {
    try {
      text.set(f, readFileSync(f, "utf8"));
    } catch {
      continue; // a file that cannot be read as text (a directory entry, a binary the OS refuses) has no text to check
    }
  }
  for (const [f, t] of text) problems.push(...identifierProblems(f, t));
  // Machine output is never tracked, and tracked binaries live only in their allowlisted homes (scripts/ci/tracked-output.mjs).
  problems.push(...trackedOutputProblems(execFileSync("git", ["ls-files"], { encoding: "utf8" }).split(String.fromCharCode(10)).filter(Boolean)));
  problems.push(
    ...pushGateProblems({
      packageText: readFileSync("package.json", "utf8"),
      prepareText: existsSync("scripts/prepare.mjs") ? readFileSync("scripts/prepare.mjs", "utf8") : null,
      hookMode: execFileSync("git", ["ls-files", "-s", ".githooks/pre-push"], { encoding: "utf8" }).split(" ")[0],
    }),
  );
  const allowed = allowFiles();
  const old = JSON.parse(readFileSync("scripts/ci/old-tree-lines.json", "utf8"));
  for (const [f, t] of text) {
    if (/\.(ts|tsx|js|mjs|css)$/.test(f) && /^(src|scripts|tests)\//.test(f)) problems.push(...headerRangeProblems(f, t, old));
    if (f.startsWith("src/")) problems.push(...sourceOriginProblems(f, t, allowed));
  }
  problems.push(...dependencyProblems(JSON.parse(readFileSync("package.json", "utf8"))));
  return problems;
}

if (isMain(import.meta.url)) {
  const problems = treeProblems();
  for (const p of problems.slice(0, 10)) console.error(p);
  if (problems.length > 10) console.error(`... and ${problems.length - 10} more`);
  console.log(problems.length ? `${problems.length} problem(s)` : "tree-checks: clean");
  process.exit(problems.length ? 1 : 0);
}
