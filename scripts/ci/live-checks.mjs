// The live checks, run against a DEPLOYED URL (P2-15 PART A; the smoke that replaces the capture, P2-08 D). Called by the `live` job of .github/workflows/ci.yml on the successful `Vercel` commit status (a status event) and on a
// dispatch with only=live, and by hand at the window. Each check (scripts/ci/live/checks.mjs) is written to the `live-smoke` family through recordRun, one row per check, the same ledger every other run lands in.
//
//   node scripts/ci/live-checks.mjs --base https://<deployment> [--only member-reads,pages] [--phase before|after] [--no-record]
//
// --phase before is the run made BEFORE the cutover window (the first live check, IMP-116): an object a pending migration adds is reported as a warning naming the migration. The default (after) fails it.
// A missing credential follows the one exit-code contract (src/core/harness/exit.ts): exit 2 (a skip) only where the event cannot carry secrets, a pull request from a fork; on a deployment, a dispatch, a check named with --only and every other
// CI event it is exit 1, and the message and the job summary list the environment NAMES that are missing, never a value. Exit 1 also when a check failed or a row could not be recorded.
// Environment names: LIVE_BASE_URL (or --base), NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, LIVE_SMOKE_EMAIL, LIVE_SMOKE_PASSWORD, LIVE_ADMIN_EMAIL, LIVE_ADMIN_PASSWORD,
// VERCEL_AUTOMATION_BYPASS_SECRET (sent as x-vercel-protection-bypass, to the target origin only, when the preview is behind Vercel deployment protection), LIVE_ADMIN_PAGES ("off" skips admin-pages: the workflow sets it on a branch preview), and for invitation-email RESEND_API_KEY and INVITATION_FROM_EMAIL. LIVE_CODE_SHA is the deployed commit (data: the
// scripts run are the default branch's), written on every ledger row as its code_sha.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { bypassHeaders, installBypass } from "./live/bypass.mjs";
import { CHECKS, DEFAULT_CHECKS, missingNames, NEEDS, RUNNERS } from "./live/checks.mjs";

/** The checks that need the signed-in member. */
const MEMBER_CHECKS = new Set(["member-reads", "sign-in", "pages", "notification-drain", "invitation-email"]);
/** The checks that read or write the database with the service key. */
const SERVICE_CHECKS = new Set(["member-reads", "identity-anonymous", "provenance-trigger", "notification-drain", "production-shape"]);

/**
 * Which checks run, which are skipped, and which environment names are missing for the rest. A check the caller named (`only`) is never skipped for lack of an account, and neither is any check in CI (`ci`, from isCi in src/core/harness/exit.ts): a check that cannot run is then a missing name, which the exit contract turns into exit 1 (a fork PR excepted).
 * The admin console is checked only where the workflow allows it (`adminPages`): production, or a dispatch that chose its target. A preview of a branch runs that branch's code on the production database, so the production admin account never signs in to it (audit 2.3.10); the check is then skipped by name, whatever is set. Pure.
 */
export function planRun({ only, env, base, record, ci = false, adminPages = true }) {
  const wanted = only ? only.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_CHECKS;
  const unknown = wanted.filter((c) => !CHECKS.includes(c));
  if (unknown.length) return { error: `unknown check(s): ${unknown.join(", ")} (checks: ${CHECKS.join(", ")})` };
  const run = [];
  const skipped = [];
  const missing = new Set();
  if (!base) NEEDS.base.forEach((n) => missing.add(n));
  if (record) missingNames(NEEDS.record, env).forEach((n) => missing.add(n));
  for (const c of wanted) {
    const gaps = [];
    if (c === "admin-pages" && !adminPages) {
      skipped.push({ check: c, missing: [], reason: "the admin account signs in to production or a dispatch's chosen target only, never to a branch preview" });
      continue;
    }
    if (c === "admin-pages") gaps.push(...missingNames(NEEDS.admin, env));
    if (MEMBER_CHECKS.has(c)) gaps.push(...missingNames(NEEDS.member, env));
    if (SERVICE_CHECKS.has(c)) gaps.push(...missingNames(NEEDS.record, env));
    if (c === "invitation-email") gaps.push(...missingNames(NEEDS.email, env));
    if (c === "admin-pages" && gaps.length && !only && !ci) skipped.push({ check: c, missing: gaps });
    else {
      run.push(c);
      gaps.forEach((n) => missing.add(n));
    }
  }
  return { run, skipped, missing: [...missing] };
}

/** The commit a row is written against: the deployed one when the workflow passes it as data, else the commit the script runs from. */
export const codeShaOf = (env) => env.LIVE_CODE_SHA || env.GITHUB_SHA || null;
export const triggerOf = (env) => (env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "dispatch" : env.GITHUB_EVENT_NAME === "status" ? "push" : "manual");

export async function runLive({ checks, io, phase, record, env, now = () => new Date(), log = console.log }) {
  const results = [];
  for (const check of checks) {
    const startedAt = now();
    const visited = [];
    let findings;
    try {
      findings = await RUNNERS[check]({ io, phase, visited });
    } catch (e) {
      findings = [{ severity: "fail", invariant: check, url: check, text: `the check threw: ${e instanceof Error ? e.message : String(e)}` }];
    }
    const report = { baseUrl: io.base, findings, pagesVisited: visited.map((url) => ({ url })) };
    const failed = findings.filter((f) => f.severity === "fail");
    let recorded = null;
    if (record) recorded = await record(report, { now: now(), startedAt, check, phase, trigger: triggerOf(env), codeSha: codeShaOf(env), githubRunId: env.GITHUB_RUN_ID ?? null });
    log(`${failed.length ? "FAIL" : "PASS"} ${check}${findings.length ? ` (${failed.length} failure(s), ${findings.length - failed.length} warning(s))` : ""}${recorded?.error ? ` [NOT RECORDED: ${recorded.error}]` : ""}`);
    for (const f of findings) log(`  ${f.severity} ${f.url}: ${f.text}`);
    results.push({ check, failed: failed.length, warnings: findings.length - failed.length, recordError: recorded?.error ?? null });
  }
  return results;
}

async function main() {
  register("../lib/ts-hooks.mjs", import.meta.url, { data: {} });
  const { isCi, skipVerdict, summarise } = await import("../../src/core/harness/exit.ts");
  const { values } = parseArgs({ options: { base: { type: "string" }, only: { type: "string" }, phase: { type: "string", default: "after" }, "no-record": { type: "boolean", default: false } }, strict: true });
  const env = process.env;
  const base = (values.base ?? env.LIVE_BASE_URL ?? "").replace(/\/+$/, "");
  if (!["before", "after"].includes(values.phase)) {
    console.error("live-checks: --phase must be before or after");
    process.exit(1);
  }
  // LIVE_ADMIN_PAGES is set by the workflow: "off" on a branch preview (a status event that is not the default branch), "on" otherwise. Unset (a workstation) is on.
  const plan = planRun({ only: values.only, env, base, record: !values["no-record"], ci: isCi(env), adminPages: env.LIVE_ADMIN_PAGES !== "off" });
  if (plan.error) {
    console.error(`live-checks: ${plan.error}`);
    process.exit(1);
  }
  for (const s of plan.skipped) console.log(`skipped ${s.check}: ${s.reason ?? `set ${s.missing.join(", ")} to run it`}`);
  const verdict = skipVerdict(env, plan.missing, Boolean(values.only));
  if (verdict.message) {
    console.log(`live-checks: ${verdict.message}`);
    summarise(env, "Live checks", verdict);
    process.exit(verdict.exit);
  }
  const { createClient } = await import("@supabase/supabase-js");
  const { recordLiveSmoke } = await import("../../src/core/harness/live-smoke.ts");
  const { runNotificationOutbox } = await import("../../src/features/drain/kinds.ts");
  const { sendInvitationEmail } = await import("../../src/core/shared/email.ts");
  // The bypass header goes to the target origin only (scripts/ci/live/bypass.mjs): the pages call the database and other origins, and none of them may receive the secret.
  const bypass = bypassHeaders(base, base, env);
  const service = env.SUPABASE_SERVICE_ROLE_KEY ? createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;
  let member = null;
  let browser = null;
  const contexts = {};
  const accounts = { member: [env.LIVE_SMOKE_EMAIL, env.LIVE_SMOKE_PASSWORD], admin: [env.LIVE_ADMIN_EMAIL, env.LIVE_ADMIN_PASSWORD] };
  const context = async (as) => {
    if (contexts[as]) return contexts[as];
    const { chromium } = await import("playwright");
    browser ??= await chromium.launch();
    const ctx = await browser.newContext();
    await installBypass(ctx, base, env);
    const page = await ctx.newPage();
    await page.goto(`${base}/login`, { waitUntil: "load", timeout: 60000 });
    await page.fill('input[type="email"]', accounts[as][0]);
    await page.fill('input[type="password"]', accounts[as][1]);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
    await page.close();
    return (contexts[as] = ctx);
  };
  const io = {
    base,
    service,
    expectedShape: JSON.parse(readFileSync("scripts/ci/data/production-shape.json", "utf8")).shape,
    runId: randomUUID(),
    async member() {
      if (!member) {
        const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
        const { data, error } = await db.auth.signInWithPassword({ email: env.LIVE_SMOKE_EMAIL, password: env.LIVE_SMOKE_PASSWORD });
        if (error || !data.user) throw new Error(`the member test account could not sign in to the database: ${error?.message ?? "no user"}`);
        member = { db, userId: data.user.id };
      }
      return member;
    },
    async signInMember() {
      try {
        await context("member");
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async openPage(path, as) {
      try {
        const page = await (await context(as)).newPage();
        try {
          const res = await page.goto(`${base}${path}`, { waitUntil: "load", timeout: 60000 });
          await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
          return { status: res?.status() ?? 0, finalUrl: page.url(), text: await page.innerText("body") };
        } finally {
          await page.close();
        }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    },
    async getJson(path) {
      const res = await fetch(`${base}${path}`, { headers: bypass, signal: AbortSignal.timeout(30000) });
      return { status: res.status, body: await res.json().catch(() => null), headerNames: [...res.headers.keys()].map((h) => h.toLowerCase()) };
    },
    drain: (ids) => runNotificationOutbox({ sb: service, now: () => new Date() }, { dry: false, ids }),
    sendInvitation: () => sendInvitationEmail({ to: env.LIVE_SMOKE_EMAIL, inviteUrl: `${base}/login`, orgName: "the live check", proposedRole: "member" }),
  };
  const record = values["no-record"] ? null : (report, o) => recordLiveSmoke(service, report, o);
  try {
    const results = await runLive({ checks: plan.run, io, phase: values.phase, record, env });
    console.log(`live-checks: ${results.length} check(s), ${results.filter((r) => r.failed).length} failed, ${results.filter((r) => r.recordError).length} not recorded`);
    process.exitCode = results.some((r) => r.failed || r.recordError) ? 1 : 0;
  } finally {
    await Promise.all(Object.values(contexts).map((c) => c.close().catch(() => {})));
    await browser?.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
