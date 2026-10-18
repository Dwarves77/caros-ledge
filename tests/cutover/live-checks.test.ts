// The live checks (scripts/ci/live-checks.mjs, scripts/ci/live/checks.mjs): each check is tried against fakes with its failure planted, so a check that passes a broken system is red here. The real-database proofs are the
// migrations' own self-checks (0068 for the provenance trigger) and the first live run at the window.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// @ts-expect-error plain .mjs modules
import { recordLiveSmoke } from "@/core/harness";
import { runNotificationOutbox } from "@/features/drain/kinds";

import { CHECKS, DEFAULT_CHECKS, FAILURE_BLOCK, identityAnonymous, memberReads, notificationDrain, pageFinding, pages, provenanceTrigger, SURFACE_PAGES } from "../../scripts/ci/live/checks.mjs";
// @ts-expect-error plain .mjs modules
import { planRun, runLive, triggerOf } from "../../scripts/ci/live-checks.mjs";
import { MemDb } from "../_support/memdb.ts";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const absent = (name: string) => ({ error: { code: "PGRST205", message: `relation ${name} does not exist` } });

/** A client whose every read of a table answers what the table says, however the query is chained. */
const chain = (result: unknown): Any => {
  const q: Any = new Proxy(function () {}, { get: (_t, p) => (p === "then" ? (res: (v: unknown) => unknown) => res(result) : () => q), apply: () => q });
  return q;
};
const client = (reads: Record<string, unknown>, writes: Record<string, unknown> = {}, rpcs: Record<string, unknown> = {}): Any => ({
  from: (t: string) => ({ select: () => chain(reads[t] ?? { data: [], error: null }), insert: () => chain(writes[t] ?? { data: null, error: { message: "permission denied", code: "42501" } }) }),
  rpc: async (name: string) => rpcs[name] ?? { data: null, error: null },
});
const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ data, error: null, ...extra });

// ---- the page verdict and the sweep over the surfaces ----
test("a page verdict: a rendered page is none; a failure status, a redirect to sign-in or the unavailable page, the app's own failure block and a page that never answered are each a failure", () => {
  const good = { status: 200, finalUrl: "https://x.test/market", text: "Market Intel — 12 figures" };
  assert.equal(pageFinding("pages", "/market", good), null);
  assert.match(pageFinding("pages", "/market", { ...good, status: 503 }).text, /HTTP 503/);
  assert.match(pageFinding("pages", "/market", { ...good, finalUrl: "https://x.test/login?redirect=%2Fmarket" }).text, /ended at \/login/);
  assert.match(pageFinding("pages", "/market", { ...good, finalUrl: "https://x.test/service-unavailable" }).text, /service-unavailable/);
  assert.match(pageFinding("pages", "/market", { ...good, text: "Your watchlist did not load. Try again" }).text, /failure block/);
  assert.match(pageFinding("pages", "/market", { error: "timeout" }).text, /did not answer: timeout/);
  for (const t of ["Market Intel did not load", "Application error: a server-side exception", "Internal Server Error", "Something went wrong on our side"]) assert.ok(FAILURE_BLOCK.test(t), t);
});

test("one page per surface: the sweep visits every surface path and names the one that fails; the admin console is a separate check", async () => {
  const seen: string[] = [];
  const io = { openPage: async (path: string) => (seen.push(path), { status: path === "/research" ? 500 : 200, finalUrl: `https://x.test${path}`, text: "fine" }) };
  const visited: string[] = [];
  const out = await pages({ io, visited });
  assert.deepEqual(seen, SURFACE_PAGES);
  assert.deepEqual(visited, SURFACE_PAGES);
  assert.deepEqual(out.map((f: Any) => [f.invariant, f.url]), [["pages", "/research"]]);
  for (const s of ["/", "/regulations", "/market", "/research", "/operations", "/community"]) assert.ok(SURFACE_PAGES.includes(s), `${s} is a surface the sweep covers`);
});

// ---- IMP-116: the member reads ----
const healthyMember = () =>
  client(
    { org_memberships: ok([{ org_id: "o1" }]), research_assessments_current: ok([{ item_id: "i1" }]), research_assessment_history: ok([{ id: "h" }]), host_verdicts: ok([]), host_worklist: ok([]) },
    {},
    { load_settings_bundle: ok({ overrides: [], personal: [], supersessions: [], history: [], truncated: {} }) },
  );
const service = (assessed: unknown[], open: unknown[]) => client({ research_assessments_current: ok(assessed), intelligence_items: ok(open) });
const ctxOf = (member: Any, svc: Any, phase = "after") => ({ phase, io: { member: async () => ({ db: member, userId: "u1" }), service: svc } });

test("IMP-116: with 0038, 0040, 0042 and 0064 applied every member read is clean; the member's view agrees with the service role's", async () => {
  assert.deepEqual(await memberReads(ctxOf(healthyMember(), service([{ item_id: "i1" }], [{ id: "i1" }]))), []);
});

test("IMP-116 attack: before the migrations the same reads are failures after the window and named warnings before it; a view that returns a member nothing is caught either way", async () => {
  const before = client({ org_memberships: ok([{ org_id: "o1" }]), research_assessments_current: ok([{ item_id: "i1" }]), research_assessment_history: absent("research_assessment_history"), host_verdicts: absent("host_verdicts"), host_worklist: absent("host_worklist") }, {}, { load_settings_bundle: absent("load_settings_bundle") });
  const svc = service([{ item_id: "i1" }], [{ id: "i1" }]);
  const after = await memberReads(ctxOf(before, svc, "after"));
  assert.deepEqual(after.map((f: Any) => [f.severity, f.url]), [["fail", "load_settings_bundle"], ["fail", "research_assessment_history"], ["fail", "host_verdicts"], ["fail", "host_worklist"]]);
  const pre = await memberReads(ctxOf(before, svc, "before"));
  assert.ok(pre.every((f: Any) => f.severity === "warn"));
  assert.match(pre.map((f: Any) => f.text).join("|"), /migration 0038.*migration 0040.*migration 0042.*migration 0064/);
  const empty = client({ org_memberships: ok([{ org_id: "o1" }]), research_assessments_current: ok([]), research_assessment_history: ok([]), host_verdicts: ok([]), host_worklist: ok([]) }, {}, { load_settings_bundle: ok({ overrides: [], personal: [], supersessions: [], history: [], truncated: {} }) });
  const zero = await memberReads(ctxOf(empty, service([{ item_id: "i1" }, { item_id: "i2" }], [{ id: "i1" }, { id: "i2" }])));
  assert.deepEqual(zero.map((f: Any) => [f.severity, f.url]), [["fail", "research_assessments_current"]]);
  assert.match(zero[0].text, /reads 0 current assessments where 2 belong to items a member may open/);
  assert.equal((await memberReads(ctxOf(empty, service([{ item_id: "i1" }], [{ id: "i1" }]), "before")))[0].severity, "warn");
  assert.equal((await memberReads(ctxOf(empty, service([{ item_id: "i1" }], []))))[0].severity, "warn", "nothing open to compare is said, not passed silently");
});

test("IMP-116 attack: a member who reads host_verdicts rows, or can write to it, fails; a bundle without its parts fails; a member with no workspace fails", async () => {
  const leaky = client({ org_memberships: ok([{ org_id: "o1" }]), research_assessments_current: ok([{ item_id: "i1" }]), research_assessment_history: ok([]), host_verdicts: ok([{ host: "a.example" }]), host_worklist: ok([]) }, { host_worklist: ok(null) }, { load_settings_bundle: ok({ overrides: [] }) });
  const out = await memberReads(ctxOf(leaky, service([{ item_id: "i1" }], [{ id: "i1" }])));
  assert.deepEqual(out.map((f: Any) => f.url), ["load_settings_bundle", "host_verdicts", "host_worklist"]);
  assert.match(out[1].text, /reads 1 row/);
  assert.match(out[2].text, /wrote a row/);
  const homeless = client({ org_memberships: ok([]) });
  assert.match((await memberReads(ctxOf(homeless, service([], []))))[0].text, /no readable workspace membership/);
});

// ---- the identity route ----
const svcCount = (before: number, after: number) => {
  let n = 0;
  return { from: () => ({ select: () => ({ then: (r: (v: unknown) => unknown) => r({ count: n++ === 0 ? before : after, error: null }) }) }) };
};
test("the identity route: 25 anonymous calls are 200 with no user and leave the limiter table as it was; a 429, a user, or a moved limiter is caught", async () => {
  const get = (status: number, user: unknown = null) => async () => ({ status, body: { user } });
  assert.deepEqual(await identityAnonymous({ io: { service: svcCount(4, 4), getJson: get(200) } }), []);
  assert.match((await identityAnonymous({ io: { service: svcCount(4, 4), getJson: get(429) } }))[0].text, /call 1: HTTP 429/);
  assert.match((await identityAnonymous({ io: { service: svcCount(4, 4), getJson: get(200, { id: "u" }) } }))[0].text, /user \{"id":"u"\}/);
  assert.match((await identityAnonymous({ io: { service: svcCount(4, 5), getJson: get(200) } }))[0].text, /moved the limiter table \(4 -> 5\)/);
  let calls = 0;
  await identityAnonymous({ io: { service: svcCount(1, 1), getJson: async () => (calls++, { status: 200, body: { user: null } }) } });
  assert.equal(calls, 25);
});

// ---- the provenance trigger ----
test("IMP-074's residue: a trigger that flipped the fixture is clean; one that did not, one that left rows behind, and the function absent are each a finding", async () => {
  const svc = (data: unknown, error: unknown = null) => ({ rpc: async () => ({ data, error }) });
  assert.deepEqual(await provenanceTrigger({ io: { service: svc({ flipped: true, before: "verified", after: "quarantined", left_behind: 0 }) } }), []);
  assert.match((await provenanceTrigger({ io: { service: svc({ flipped: false, before: "verified", after: "verified", left_behind: 0 }) } }))[0].text, /did not take the verified fixture out of verified/);
  assert.match((await provenanceTrigger({ io: { service: svc({ flipped: true, before: "verified", after: "pending", left_behind: 2 }) } }))[0].text, /left 2 fixture row/);
  const gone = { code: "PGRST202", message: "no function" };
  assert.deepEqual((await provenanceTrigger({ phase: "after", io: { service: svc(null, gone) } })).map((f: Any) => f.severity), ["fail"]);
  assert.deepEqual((await provenanceTrigger({ phase: "before", io: { service: svc(null, gone) } })).map((f: Any) => f.severity), ["warn"]);
});

// ---- the notification drain: the real drain over a memory database ----
const drainWorld = () => {
  const db = new MemDb({ ids: "uuid" });
  db.seed("notification_outbox", [{ id: "f0000000-0000-4000-8000-000000000001", user_id: "e0000000-0000-4000-8000-000000000009", kind: "invite", payload: { title: "someone else's" }, status: "pending", attempts: 0 }]);
  const io = { runId: "run-1", service: db.client as Any, member: async () => ({ db: null, userId: "e0000000-0000-4000-8000-000000000001" }), drain: (ids: string[]) => runNotificationOutbox({ sb: db.client as Any, now: () => new Date("2026-10-17T12:00:00Z") }, { dry: false, ids }) };
  return { db, io };
};
test("the notification drain drains the planted row and only that row: it is sent, the member's notification exists, both are removed, and another recipient's pending row is untouched", async () => {
  const { db, io } = drainWorld();
  assert.deepEqual(await notificationDrain({ io }), []);
  assert.deepEqual(db.rows("notification_outbox").map((r) => [r.user_id, r.status]), [["e0000000-0000-4000-8000-000000000009", "pending"]], "the other pending row is still pending and the planted one is gone");
  assert.equal(db.rows("notifications").length, 0);
});
test("the notification drain attack: a drain that sends nothing, a row left pending, a missing notification and a failed cleanup are each a failure", async () => {
  const { io } = drainWorld();
  const none = await notificationDrain({ io: { ...io, drain: async () => ({ counts: { sent: 0 }, outcome: "ok", notes: ["nothing"] }) } });
  assert.deepEqual(none.map((f: Any) => f.url), ["notification_outbox", "notification_outbox", "notifications"]);
  const w = drainWorld();
  w.db.fail("notifications", "delete", "cleanup refused");
  assert.match((await notificationDrain({ io: w.io })).map((f: Any) => f.text).join("|"), /planted rows were not removed: cleanup refused/);
  const gone = drainWorld();
  gone.db.fail("notification_outbox", "insert", "relation does not exist", { code: "42P01" });
  assert.equal((await notificationDrain({ phase: "before", io: gone.io }))[0].severity, "warn");
});

// ---- the runner: one live-smoke row per check ----
test("each check is one live-smoke row through recordRun: a clean check is a success row naming it, a failing or throwing check is a failed row with its first failure, a warning does not fail it, and a row that cannot be recorded fails the run", async () => {
  const db = new MemDb({ ids: "uuid" });
  const rec = (report: Any, o: Any) => recordLiveSmoke(db.client as Any, report, o);
  const checks = ["sign-in", "pages", "provenance-trigger"];
  const io = { base: "https://preview.example.test", signInMember: async () => ({ ok: true }), openPage: async () => ({ status: 500, finalUrl: "https://x.test/", text: "" }), service: { rpc: async () => { throw new Error("rpc down"); } } };
  const results = await runLive({ checks, io, phase: "after", record: rec, env: { GITHUB_EVENT_NAME: "deployment_status", GITHUB_SHA: "abc", GITHUB_RUN_ID: "77" }, log: () => {} });
  assert.deepEqual(results.map((r: Any) => [r.check, r.failed > 0]), [["sign-in", false], ["pages", true], ["provenance-trigger", true]]);
  const rows = db.rows("harness_runs");
  assert.deepEqual(rows.map((r) => [r.family, (r.inputs as Any).check, r.outcome, r.trigger, r.code_sha, r.github_run_id]), [["live-smoke", "sign-in", "success", "push", "abc", "77"], ["live-smoke", "pages", "failed", "push", "abc", "77"], ["live-smoke", "provenance-trigger", "failed", "push", "abc", "77"]]);
  assert.match(String(rows[2]?.error), /provenance-trigger|the check threw/);
  assert.equal((rows[0]?.inputs as Any).target, "https://preview.example.test");
  const down = new MemDb({ ids: "uuid" });
  down.fail("harness_runs", "insert", "ledger down");
  const lost = await runLive({ checks: ["sign-in"], io, phase: "after", record: (r: Any, o: Any) => recordLiveSmoke(down.client as Any, r, o), env: {}, log: () => {} });
  assert.match(lost[0].recordError, /harness_runs insert failed: ledger down/);
  assert.equal(triggerOf({ GITHUB_EVENT_NAME: "workflow_dispatch" }), "dispatch");
  assert.equal(triggerOf({}), "manual");
});

// ---- the plan and the self-skip ----
test("the plan names the environment NAMES that are missing and never runs half-equipped; the admin check skips on its own account; an unknown check is refused; the e-mail check runs only when named", () => {
  const full = { NEXT_PUBLIC_SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "s", NEXT_PUBLIC_SUPABASE_ANON_KEY: "a", LIVE_SMOKE_EMAIL: "e", LIVE_SMOKE_PASSWORD: "p" };
  assert.deepEqual(DEFAULT_CHECKS, CHECKS.filter((c: string) => c !== "invitation-email"));
  const none = planRun({ env: {}, base: "", record: true });
  assert.deepEqual(none.missing.sort(), ["LIVE_BASE_URL", "LIVE_SMOKE_EMAIL", "LIVE_SMOKE_PASSWORD", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].sort());
  const ready = planRun({ env: full, base: "https://x.test", record: true });
  assert.deepEqual([ready.missing, ready.skipped.map((s: Any) => s.check), ready.run.includes("admin-pages"), ready.run.includes("invitation-email")], [[], ["admin-pages"], false, false]);
  const admin = planRun({ env: { ...full, LIVE_ADMIN_EMAIL: "a", LIVE_ADMIN_PASSWORD: "p" }, base: "https://x.test", record: true });
  assert.ok(admin.run.includes("admin-pages") && admin.skipped.length === 0);
  assert.deepEqual(planRun({ only: "invitation-email", env: full, base: "https://x.test", record: true }).missing.sort(), ["INVITATION_FROM_EMAIL", "RESEND_API_KEY"]);
  assert.deepEqual(planRun({ only: "provenance-trigger", env: {}, base: "https://x.test", record: false }).missing.sort(), ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"], "a service check needs the service names even when nothing is recorded");
  assert.deepEqual(planRun({ only: "sign-in,pages", env: {}, base: "https://x.test", record: false }).missing.sort(), ["LIVE_SMOKE_EMAIL", "LIVE_SMOKE_PASSWORD", "NEXT_PUBLIC_SUPABASE_ANON_KEY"], "the page checks need the member account only");
  assert.match(planRun({ only: "nope", env: full, base: "x", record: true }).error, /unknown check/);
  assert.deepEqual(planRun({ only: "identity-anonymous", env: { NEXT_PUBLIC_SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "s" }, base: "https://x.test", record: true }).missing, []);
});

test("the script itself self-skips with exit 2 and names what is missing, never a value, when the environment carries no credentials", () => {
  const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" };
  const r = spawnSync(process.execPath, ["scripts/ci/live-checks.mjs", "--base", "https://preview.example.test"], { env, encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stdout, /self-skipped \(exit 2\).*NEXT_PUBLIC_SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(spawnSync(process.execPath, ["scripts/ci/live-checks.mjs", "--only", "nope", "--base", "https://x.test"], { env, encoding: "utf8" }).status, 1);
});
