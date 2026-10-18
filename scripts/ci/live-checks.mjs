// The live checks, run against a DEPLOYED URL (P2-15 PART A; the smoke that replaces the capture, P2-08 D). Called by the `live` job of .github/workflows/ci.yml on a successful preview deployment (deployment_status) and on a
// dispatch with only=live, and by hand at the window. Each check (scripts/ci/live/checks.mjs) is written to the `live-smoke` family through recordRun, one row per check, the same ledger every other run lands in.
//
//   node scripts/ci/live-checks.mjs --base https://<deployment> [--only member-reads,pages] [--phase before|after] [--no-record]
//
// --phase before is the run made BEFORE the cutover window (the first live check, IMP-116): an object a pending migration adds is reported as a warning naming the migration. The default (after) fails it.
// Self-skips with exit 2 (and says which environment NAMES are missing, never a value) when the credentials are not there; exit 1 when a check failed or a row could not be recorded.
// Environment names: LIVE_BASE_URL (or --base), NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, LIVE_SMOKE_EMAIL, LIVE_SMOKE_PASSWORD, LIVE_ADMIN_EMAIL, LIVE_ADMIN_PASSWORD,
// VERCEL_AUTOMATION_BYPASS_SECRET (sent as x-vercel-protection-bypass when the preview is behind Vercel deployment protection), and for invitation-email RESEND_API_KEY and INVITATION_FROM_EMAIL.
import { randomUUID } from "node:crypto";
import { register } from "node:module";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { CHECKS, DEFAULT_CHECKS, missingNames, NEEDS, RUNNERS } from "./live/checks.mjs";

/** The checks that need the signed-in member. */
const MEMBER_CHECKS = new Set(["member-reads", "sign-in", "pages", "notification-drain", "invitation-email"]);
/** The checks that read or write the database with the service key. */
const SERVICE_CHECKS = new Set(["member-reads", "identity-anonymous", "provenance-trigger", "notification-drain"]);

/** Which checks run, which are skipped for lack of an account, and which environment names are missing for the rest. Pure. */
export function planRun({ only, env, base, record }) {
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
    if (c === "admin-pages") gaps.push(...missingNames(NEEDS.admin, env));
    if (MEMBER_CHECKS.has(c)) gaps.push(...missingNames(NEEDS.member, env));
    if (SERVICE_CHECKS.has(c)) gaps.push(...missingNames(NEEDS.record, env));
    if (c === "invitation-email") gaps.push(...missingNames(NEEDS.email, env));
    if (c === "admin-pages" && gaps.length) skipped.push({ check: c, missing: gaps });
    else {
      run.push(c);
      gaps.forEach((n) => missing.add(n));
    }
  }
  return { run, skipped, missing: [...missing] };
}

export const triggerOf = (env) => (env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "dispatch" : env.GITHUB_EVENT_NAME === "deployment_status" ? "push" : "manual");

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
    if (record) recorded = await record(report, { now: now(), startedAt, check, phase, trigger: triggerOf(env), codeSha: env.GITHUB_SHA ?? null, githubRunId: env.GITHUB_RUN_ID ?? null });
    log(`${failed.length ? "FAIL" : "PASS"} ${check}${findings.length ? ` (${failed.length} failure(s), ${findings.length - failed.length} warning(s))` : ""}${recorded?.error ? ` [NOT RECORDED: ${recorded.error}]` : ""}`);
    for (const f of findings) log(`  ${f.severity} ${f.url}: ${f.text}`);
    results.push({ check, failed: failed.length, warnings: findings.length - failed.length, recordError: recorded?.error ?? null });
  }
  return results;
}

async function main() {
  const { values } = parseArgs({ options: { base: { type: "string" }, only: { type: "string" }, phase: { type: "string", default: "after" }, "no-record": { type: "boolean", default: false } }, strict: true });
  const env = process.env;
  const base = (values.base ?? env.LIVE_BASE_URL ?? "").replace(/\/+$/, "");
  if (!["before", "after"].includes(values.phase)) {
    console.error("live-checks: --phase must be before or after");
    process.exit(1);
  }
  const plan = planRun({ only: values.only, env, base, record: !values["no-record"] });
  if (plan.error) {
    console.error(`live-checks: ${plan.error}`);
    process.exit(1);
  }
  for (const s of plan.skipped) console.log(`skipped ${s.check}: set ${s.missing.join(", ")} to run it`);
  if (plan.missing.length) {
    console.log(`live-checks: self-skipped (exit 2): the environment does not carry ${plan.missing.join(", ")}`);
    process.exit(2);
  }
  register("../lib/ts-hooks.mjs", import.meta.url, { data: {} });
  const { createClient } = await import("@supabase/supabase-js");
  const { recordLiveSmoke } = await import("../../src/core/harness/live-smoke.ts");
  const { runNotificationOutbox } = await import("../../src/features/drain/kinds.ts");
  const { sendInvitationEmail } = await import("../../src/core/shared/email.ts");
  const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET ? { "x-vercel-protection-bypass": env.VERCEL_AUTOMATION_BYPASS_SECRET } : {};
  const service = env.SUPABASE_SERVICE_ROLE_KEY ? createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }) : null;
  let member = null;
  let browser = null;
  const contexts = {};
  const accounts = { member: [env.LIVE_SMOKE_EMAIL, env.LIVE_SMOKE_PASSWORD], admin: [env.LIVE_ADMIN_EMAIL, env.LIVE_ADMIN_PASSWORD] };
  const context = async (as) => {
    if (contexts[as]) return contexts[as];
    const { chromium } = await import("playwright");
    browser ??= await chromium.launch();
    const ctx = await browser.newContext({ extraHTTPHeaders: bypass });
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
      return { status: res.status, body: await res.json().catch(() => null) };
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
