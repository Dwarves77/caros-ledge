// Running one mutant: apply its edits (or its script) to the scratch tree, run the gate it names, read the verdict. No file of the real tree is touched; the scratch is restored by scratch.mjs between mutants.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const win = process.platform === "win32";
export const GATE_TIMEOUT_MS = 15 * 60 * 1000;

/** Replace the first occurrence of each edit's `find` in its file under `dir` (line endings of the file are kept). Throws when a file lacks the text: a stale mutant is an error, never a pass. */
export function applyEdits(dir, edits) {
  for (const { file, find, replace } of edits) {
    const path = resolve(dir, file);
    const raw = readFileSync(path, "utf8");
    const crlf = raw.includes("\r\n");
    const text = crlf ? raw.replace(/\r\n/g, "\n") : raw;
    const at = text.indexOf(find);
    if (at < 0) throw new Error(`${file} does not contain the text this mutant replaces`);
    const next = text.slice(0, at) + replace + text.slice(at + find.length);
    writeFileSync(path, crlf ? next.replace(/\n/g, "\r\n") : next);
  }
}

/** Spawn a command in `dir`; the combined output, the exit code and the time taken. A timeout is reported, never read as a red. */
export function execIn(dir, command, args, env = {}, timeout = GATE_TIMEOUT_MS) {
  const started = Date.now();
  const r = spawnSync(command, args, { cwd: dir, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 1 << 28, shell: win && command === "npm", timeout });
  return { code: r.status, signal: r.signal, spawnError: r.error ? String(r.error.message) : null, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, ms: Date.now() - started };
}

/** Apply a mutant's `apply` to `dir`: edits in place, or its script run there with the mutant id in MUTANT_ID. */
export function applyMutant(dir, mutant) {
  if (Array.isArray(mutant.apply)) return applyEdits(dir, mutant.apply);
  const r = execIn(dir, process.execPath, [mutant.apply.script, ...(mutant.apply.args ?? [])], { MUTANT_ID: mutant.id }, 120_000);
  if (r.code !== 0) throw new Error(`the mutant script ${mutant.apply.script} failed: ${firstRedLine(r.output)}`);
  return undefined;
}

/** The command that runs a gate on a tree: an npm script by name; the test gate narrowed to a scope; a property check against DATABASE_URL. */
export function gateCommand(gate, { scope, stepEnv = {} } = {}) {
  if (gate === "test" && scope) return { command: process.execPath, args: ["--import", "./tests/_support/register.mjs", "--test", ...scope], env: {} };
  if (gate === "property:generator-pins") return { command: process.execPath, args: ["--import", "./tests/_support/register.mjs", "scripts/ci/checks/generator-pins.mjs"], env: {} };
  if (gate.startsWith("property:")) return { command: process.execPath, args: ["scripts/ci/properties.mjs", "--only", gate.slice("property:".length)], env: {} };
  return { command: "npm", args: ["run", "--silent", gate], env: stepEnv };
}

const NOISE = /^(npm (error|warn|notice)|> |\(node:|\(Use `node|Reparsing as ES module|To eliminate this warning|ℹ )/;
const LOCATED = /^[\w./@-]+:\d+(:\d+)?[: ]/;
const NAMES_FAILURE = /\b(error|fail(ed|ure)?|problem|unexplained|refused|mismatch|✖|not ok)\b/i;
/** The first line of a gate's output that says what went red: a `file:line` problem, else a line naming an error, a failure or a problem, else the last line that is not tool noise. */
export function firstRedLine(output) {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !NOISE.test(l));
  return (lines.find((l) => LOCATED.test(l)) ?? lines.find((l) => NAMES_FAILURE.test(l)) ?? lines[lines.length - 1] ?? "(no output)").slice(0, 300);
}

/** The gates whose own scripts print their problems: a crash of the script (a missing import, a thrown TypeError) is not the gate catching the mutant. */
const SELF_REPORTING = (gate) => !["lint", "typecheck", "build", "test"].includes(gate);
const CRASH = /(ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|ReferenceError|TypeError|is not a function|does not provide an export named)/;

/** The verdict of a gate run: `red` (the gate failed on the mutant), `green` (it passed: the mutant survived), `error` (a timeout, a spawn failure or a crashed gate script: nothing was proved). */
export function judge(gate, r) {
  if (r.spawnError || r.signal || r.code === null) return { verdict: "error", line: r.spawnError ?? `no exit code (signal ${r.signal ?? "none"}; timed out?)` };
  if (r.code === 0) return { verdict: "green", line: firstRedLine(r.output) };
  if (SELF_REPORTING(gate) && CRASH.test(r.output)) return { verdict: "error", line: `the gate script crashed instead of reporting: ${firstRedLine(r.output)}` };
  return { verdict: "red", line: firstRedLine(r.output) };
}
