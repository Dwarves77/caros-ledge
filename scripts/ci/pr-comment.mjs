// The `report` job's one writer: it reads the other jobs' conclusions (NEEDS, the needs context as JSON), the parity artifact and the test output (downloaded into PARITY_DIR and RESULTS_DIR),
// writes ONE job summary, and posts or updates ONE PR comment (found by an HTML marker, so a rerun updates it). Nothing waits on anything: the job runs after the others have finished.
// It reports; it never fails the run itself. A thing it cannot read is printed as that exact error, never a generic note.
// Env: NEEDS, REPO, RUN_ID, PR (pull requests only), GH_TOKEN, PARITY_DIR, RESULTS_DIR, GITHUB_STEP_SUMMARY (set by the runner). DRY=1 prints the body and posts nothing.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const { NEEDS = "{}", REPO, PR, RUN_ID, PARITY_DIR = "parity-artifact", RESULTS_DIR = "results-artifact", DRY, GITHUB_STEP_SUMMARY } = process.env;
const MARKER = "<!-- ci-report -->";
const gh = (args, input) => execFileSync("gh", ["api", ...args], { encoding: "utf8", input, maxBuffer: 1 << 26 });

const fail = (what, e) => `${what} could not be read: ${String(e?.stderr || e?.message || e).trim()}`;

/** Job conclusions from the needs context: { job: { result } }. */
export function jobRows(needsJson) {
  const needs = JSON.parse(needsJson);
  return Object.entries(needs).map(([name, v]) => [name, v.result]);
}

/** The test counts out of node's test reporter lines in the captured npm test output. */
export function testCounts(text) {
  const pick = (k) => new RegExp(`^ℹ ${k} (\\d+)`, "m").exec(text)?.[1];
  const [tests, pass, failed, skipped] = ["tests", "pass", "fail", "skipped"].map(pick);
  return tests === undefined ? null : `tests ${tests}, pass ${pass ?? "?"}, fail ${failed ?? "?"}, skipped ${skipped ?? "0"}`;
}

function read(dir, file) {
  const p = join(dir, file);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

function parityTable(rows) {
  const state = rows.find(([n]) => n === "parity")?.[1];
  if (state === undefined || state === "skipped") return "";
  try {
    if (!existsSync(PARITY_DIR)) return `parity job ${state}, but its artifact was not downloaded (no parity-capture artifact in this run)`;
    const report = read(PARITY_DIR, "parity-report.txt");
    const diffs = existsSync(join(PARITY_DIR, "parity-diff")) ? readdirSync(join(PARITY_DIR, "parity-diff")).length : 0;
    const note = diffs ? `\n\n${diffs} pixel-diff image(s) are in the parity-capture artifact under parity-diff/.` : "";
    return report ? `${report.trim()}${note}` : `parity job ${state}, but parity-report.txt is absent from the artifact (the job stopped before the compare step; see next-start.log in the artifact)`;
  } catch (e) {
    return fail("the parity report", e);
  }
}

function locLine() {
  try {
    return execFileSync("node", ["scripts/ci/loc.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (e) {
    return String(e.stdout ?? "").trim() || fail("the loc table", e);
  }
}

function build() {
  let rows;
  let needsError = null;
  try {
    rows = jobRows(NEEDS);
  } catch (e) {
    rows = [];
    needsError = fail("the needs context", e);
  }
  const tests = (() => {
    try {
      const out = read(RESULTS_DIR, "test-output.txt");
      return out === null ? "test output not downloaded (the ci job did not upload it)" : testCounts(out) ?? "no test counts in the test output";
    } catch (e) {
      return fail("the test output", e);
    }
  })();
  const parity = parityTable(rows);
  return [
    MARKER,
    `### CI report, run ${RUN_ID}`,
    `https://github.com/${REPO}/actions/runs/${RUN_ID}`,
    "",
    "| job | conclusion |",
    "|---|---|",
    ...rows.map(([n, c]) => `| ${n} | ${c} |`),
    ...(needsError ? ["", needsError] : []),
    "",
    `Tests: ${tests}`,
    "",
    "### Code lines",
    "",
    locLine() || "(loc table unavailable)",
    ...(parity ? ["", "### Parity", "", "```", parity, "```"] : []),
  ].join("\n");
}

const body = build();
if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${body.replace(MARKER, "")}\n`);
if (DRY) {
  console.log(body);
  process.exit(0);
}
if (!PR) {
  console.log("not a pull request: summary written, no comment");
  process.exit(0);
}
try {
  const existing = JSON.parse(gh(["--paginate", "--slurp", `repos/${REPO}/issues/${PR}/comments?per_page=100`])).flat().find((c) => c.body?.startsWith(MARKER));
  const payload = JSON.stringify({ body });
  if (existing) gh(["-X", "PATCH", `repos/${REPO}/issues/comments/${existing.id}`, "--input", "-"], payload);
  else gh(["-X", "POST", `repos/${REPO}/issues/${PR}/comments`, "--input", "-"], payload);
  console.log(`ci-report comment ${existing ? "updated" : "posted"}`);
} catch (e) {
  console.log(fail("the PR comment post", e));
}
