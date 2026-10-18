// The cutover runbook lists the environment the tree reads, each name with where it is set: a variable read in src (or the Edge Function) without a row in docs/runbooks/cutover-2026-10.md, and a row for a name nothing reads,
// are both failures, so the operator is never asked to set a variable the runbook does not know, nor to hunt for one the code stopped using. Names only: no value is read or compared.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// @ts-expect-error plain .mjs module
import { envNamesRead } from "../../scripts/ci/env-names.mjs";
// @ts-expect-error plain .mjs module
import { NEEDS } from "../../scripts/ci/live/checks.mjs";

const runbook = readFileSync("docs/runbooks/cutover-2026-10.md", "utf8");
const section = runbook.slice(runbook.indexOf("## Environment names"), runbook.indexOf("## The window"));
const tableNames = new Set(section.split("\n").filter((l) => l.startsWith("| `")).flatMap((l) => [...(l.split(" | ")[0] ?? "").matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1] as string)));

test("every environment name the tree reads has a row in the runbook, and every row names something the tree reads", () => {
  const read = new Set((envNamesRead() as Map<string, string[]>).keys());
  assert.deepEqual([...read].filter((n) => !tableNames.has(n)).sort(), [], "read in the code but not in the runbook");
  assert.deepEqual([...tableNames].filter((n) => !read.has(n)).sort(), [], "in the runbook but read by nothing");
});

test("the brief's names are there with their homes: the Supabase URL and keys, WORKER_SECRET, the Resend key, and the community organisation salt that must equal the old project's", () => {
  for (const n of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "WORKER_SECRET", "RESEND_API_KEY", "COMMUNITY_ORG_SALT"]) assert.ok(tableNames.has(n), n);
  assert.match(section, /`COMMUNITY_ORG_SALT`[^\n]*SAME value as the old project[^\n]*never rotated/);
  assert.match(section, /`UI_FIXTURES`[^\n]*\*\*never\*\* in Vercel/);
});

test("the names the live checks and the workflow use are in the runbook too, and the runbook carries no secret-looking value", () => {
  const needed = [...Object.values(NEEDS as Record<string, string[]>).flat(), "VERCEL_AUTOMATION_BYPASS_SECRET", "DATABASE_URL"];
  for (const n of needed) assert.ok(runbook.includes(`\`${n}\``), `${n} is in the runbook`);
  assert.doesNotMatch(runbook, /eyJ[A-Za-z0-9_-]{20,}|sb_secret_|re_[A-Za-z0-9]{20,}|postgres(ql)?:\/\/[^\s`<]+:[^\s`@<]+@/, "no key, token or connection string with a password");
});
