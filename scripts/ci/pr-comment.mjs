// Posts or updates ONE comment on the PR: run id, per-job conclusions, the loc table. Found by an HTML marker, so a rerun updates it.
// Env: GH_TOKEN, REPO, PR, RUN_ID, CI_STATUS (this job's status so far). DRY=1 prints the body and posts nothing.
import { execFileSync } from "node:child_process";

const { REPO, PR, RUN_ID, CI_STATUS = "success", DRY } = process.env;
const MARKER = "<!-- ci-report -->";
const gh = (args, input) => execFileSync("gh", ["api", ...args], { encoding: "utf8", input, maxBuffer: 1 << 26 });

// The other jobs run in parallel with this one: wait (bounded) for them to finish so the comment carries final conclusions.
async function otherJobs() {
  if (DRY) return [];
  for (let i = 0; i < 60; i += 1) {
    const jobs = JSON.parse(gh([`repos/${REPO}/actions/runs/${RUN_ID}/jobs`])).jobs.filter((j) => j.name !== "ci");
    if (jobs.every((j) => j.status === "completed") || i === 59) return jobs;
    await new Promise((r) => setTimeout(r, 10000));
  }
  return [];
}

// The parity job's per-route table, read back from that job's log between the markers its summary step prints (the jobs call already has actions: read, so no new permission). Empty when the job was skipped.
function parityTable(jobs) {
  const job = jobs.find((j) => j.name === "parity" && j.conclusion && j.conclusion !== "skipped");
  if (!job) return "";
  try {
    const log = gh([`repos/${REPO}/actions/jobs/${job.id}/logs`]).split(/\r?\n/).map((l) => l.replace(/^\S+Z /, ""));
    const a = log.findIndex((l) => l === "=== PARITY-REPORT-BEGIN ===");
    const b = log.findIndex((l) => l === "=== PARITY-REPORT-END ===");
    return a >= 0 && b > a ? log.slice(a + 1, b).join("\n").trim() : "";
  } catch (e) {
    return `(parity report unavailable: ${String(e.message).split("\n")[0]})`;
  }
}

let loc = "";
try {
  loc = execFileSync("node", ["scripts/ci/loc.mjs"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
} catch (e) {
  loc = String(e.stdout ?? "");
}
const others = await otherJobs();
const parity = parityTable(others);
const rows = [["ci", CI_STATUS], ...others.map((j) => [j.name, j.conclusion ?? j.status])];
const body = [
  MARKER,
  `### CI report, run ${RUN_ID}`,
  `https://github.com/${REPO}/actions/runs/${RUN_ID}`,
  "",
  "| job | conclusion |",
  "|---|---|",
  ...rows.map(([n, c]) => `| ${n} | ${c} |`),
  "",
  "### Code lines",
  "",
  loc.trim() || "(loc table unavailable)",
  ...(parity ? ["", "### Parity", "", "```", parity, "```"] : []),
].join("\n");

if (DRY) {
  console.log(body);
  process.exit(0);
}
const existing = JSON.parse(gh(["--paginate", "--slurp", `repos/${REPO}/issues/${PR}/comments?per_page=100`])).flat().find((c) => c.body?.startsWith(MARKER));
const payload = JSON.stringify({ body });
if (existing) gh(["-X", "PATCH", `repos/${REPO}/issues/comments/${existing.id}`, "--input", "-"], payload);
else gh(["-X", "POST", `repos/${REPO}/issues/${PR}/comments`, "--input", "-"], payload);
console.log(`ci-report comment ${existing ? "updated" : "posted"}`);
