// Posts or updates ONE comment on the PR: run id, per-job conclusions, the loc table. Found by an HTML marker, so a rerun updates it.
// Env: GH_TOKEN, REPO, PR, RUN_ID, CI_STATUS (this job's status so far). DRY=1 prints the body and posts nothing.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

// The parity job's per-route table: parity-report.txt from the run's uploaded `parity-capture` artifact (the artifacts API is covered by actions: read; the zip download answers a 302 to a signed URL, which gh follows). A job that did not run has no table; any failure is printed as its exact error text, never a generic note.
function parityTable(jobs) {
  const job = jobs.find((j) => j.name === "parity");
  if (!job || job.conclusion === "skipped") return "";
  try {
    const list = JSON.parse(gh([`repos/${REPO}/actions/runs/${RUN_ID}/artifacts?per_page=100`])).artifacts;
    const art = list.find((a) => a.name === "parity-capture" && !a.expired);
    if (!art) return `parity job ${job.conclusion ?? job.status}, but no parity-capture artifact was uploaded (${list.map((a) => a.name).join(", ") || "none"})`;
    const zip = join(mkdtempSync(join(tmpdir(), "parity-")), "a.zip");
    writeFileSync(zip, execFileSync("gh", ["api", `repos/${REPO}/actions/artifacts/${art.id}/zip`], { maxBuffer: 1 << 28 }));
    return execFileSync("unzip", ["-p", zip, "parity-report.txt"], { encoding: "utf8" }).trim() || "parity-report.txt is empty";
  } catch (e) {
    return `parity report could not be read: ${String(e.stderr || e.message).trim()}`;
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
