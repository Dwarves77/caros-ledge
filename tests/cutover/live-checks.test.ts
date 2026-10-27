// The live checks (scripts/ci/live-checks.mjs, scripts/ci/live/checks.mjs): each check is tried against fakes with its failure planted, so a check that passes a broken system is red here. The real-database proofs are the
// migrations' own self-checks (0068 for the provenance trigger) and the first live run at the window.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { recordLiveSmoke } from "@/core/harness";
import { runNotificationOutbox } from "@/features/drain/kinds";
import { skipVerdict } from "@/core/harness/exit";

// @ts-expect-error plain .mjs modules
import { appliedItemsRender, CHECKS, DEFAULT_CHECKS, identityAnonymous, memberReads, notificationDrain, pageFinding, pages, productionShape, provenanceTrigger, SURFACE_PAGES } from "../../scripts/ci/live/checks.mjs";
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
test("a page verdict: a rendered page is none; a failure status, a redirect to sign-in or the unavailable page, a typed failure element, a failed api read and a page that never answered are each a failure", () => {
  const good = { status: 200, finalUrl: "https://x.test/market", uiFailures: [], apiFailures: [] };
  assert.equal(pageFinding("pages", "/market", good), null);
  assert.match(pageFinding("pages", "/market", { ...good, status: 503 }).text, /HTTP 503/);
  assert.match(pageFinding("pages", "/market", { ...good, finalUrl: "https://x.test/login?redirect=%2Fmarket" }).text, /ended at \/login/);
  assert.match(pageFinding("pages", "/market", { ...good, finalUrl: "https://x.test/service-unavailable" }).text, /service-unavailable/);
  assert.match(pageFinding("pages", "/market", { error: "timeout" }).text, /did not answer: timeout/);
});

test("ADR-053: no English word is the test. Body text that says a thing did not load, with no typed failure element, PASSES; a typed failure element fails and its marker and text are diagnostics; a failed api read fails and is named", () => {
  const good = { status: 200, finalUrl: "https://x.test/regulations", uiFailures: [], apiFailures: [] };
  // the page's body text is not even an input of the verdict
  assert.equal(pageFinding("pages", "/regulations", { ...good, text: "cargo did not load. Application error. Internal Server Error" }), null);
  const marker = pageFinding("pages", "/regulations", { ...good, uiFailures: [{ marker: "state-note", text: "Your watchlist did not load. Try again" }, { marker: "data-list-state=failed", text: "" }] });
  assert.equal(marker.severity, "fail");
  assert.match(marker.text, /shows 2 failure element\(s\): \[state-note\] "Your watchlist did not load. Try again"; \[data-list-state=failed\] ""/);
  const api = pageFinding("pages", "/regulations", { ...good, apiFailures: [{ path: "/api/workspace/bootstrap", status: 500 }, { path: "/api/saved-views", status: 429 }] });
  assert.equal(api.severity, "fail");
  assert.match(api.text, /had failed api read\(s\): \/api\/workspace\/bootstrap 500, \/api\/saved-views 429/);
  const both = pageFinding("pages", "/regulations", { ...good, uiFailures: [{ marker: "page-failure", text: "boom" }], apiFailures: [{ path: "/api/listings/rest", status: 503 }] });
  assert.match(both.text, /\[page-failure\] "boom"; failed api read\(s\): \/api\/listings\/rest 503/);
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
const U = "11111111-2222-3333-4444-555555555555";
const svcKeys = (before: string[], after: string[]) => {
  let n = 0;
  return { from: () => ({ select: () => ({ limit: () => ({ then: (r: (v: unknown) => unknown) => r({ data: (n++ === 0 ? before : after).map((key) => ({ key })), error: null }) }) }) }) };
};
test("the identity route: 25 anonymous calls are 200 with no user, no cookie, no limiter header; a 429, a user, a header, an anonymous-shaped new key are caught; another session's user:/worker: key is informational", async () => {
  const get = (status: number, user: unknown = null, headerNames?: string[]) => async () => ({ status, body: { user }, headerNames });
  const same = [`user:${U}`, "worker:/api/revalidate"];
  assert.deepEqual(await identityAnonymous({ io: { service: svcKeys(same, same), getJson: get(200, null, ["content-type", "cache-control"]) } }), []);
  assert.match((await identityAnonymous({ io: { service: svcKeys(same, same), getJson: get(429) } }))[0].text, /call 1: HTTP 429/);
  assert.match((await identityAnonymous({ io: { service: svcKeys(same, same), getJson: get(200, { id: "u" }) } }))[0].text, /user \{"id":"u"\}/);
  assert.match((await identityAnonymous({ io: { service: svcKeys(same, same), getJson: get(200, null, ["set-cookie"]) } }))[0].text, /carries set-cookie/);
  assert.match((await identityAnonymous({ io: { service: svcKeys(same, same), getJson: get(200, null, ["x-ratelimit-limit"]) } }))[0].text, /x-ratelimit-limit/);
  // red first: an ip: or anon: key the calls could only have written fails
  for (const k of ["ip:203.0.113.9", "anon:unknown", "stray"]) {
    const f = await identityAnonymous({ io: { service: svcKeys(same, [...same, k]), getJson: get(200) } });
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, "fail");
    assert.match(f[0].text, new RegExp(`${k}.*touched the database`));
  }
  // another session's windows are reported, not failed (the 28 -> 30 of production run 39187609395)
  const others = await identityAnonymous({ io: { service: svcKeys(same, [...same, "user:aaaaaaaa-2222-3333-4444-555555555555", "bbbbbbbb-2222-3333-4444-555555555555"]), getJson: get(200) } });
  assert.deepEqual(others.map((f: Any) => f.severity), ["warn"]);
  assert.match(others[0].text, /2 new authenticated or worker limiter key/);
  let calls = 0;
  await identityAnonymous({ io: { service: svcKeys([], []), getJson: async () => (calls++, { status: 200, body: { user: null } }) } });
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

// ---- the production shape (G11) ----
test("the production-shape check: production equal to the recorded shape is clean; a role setting that differs, a role that is missing, a schema ACL that moved and the function absent are each a finding", async () => {
  const expectedShape = JSON.parse(readFileSync("scripts/ci/data/production-shape.json", "utf8")).shape;
  const svc = (data: unknown, error: unknown = null) => ({ rpc: async () => ({ data, error }) });
  const run = (data: unknown, phase = "after", error: unknown = null) => productionShape({ phase, io: { service: svc(data, error), expectedShape } }) as Promise<Any[]>;
  assert.deepEqual(await run(structuredClone(expectedShape)), []);
  assert.deepEqual(await run(JSON.stringify(expectedShape)), [], "the function may answer text");
  const settings = structuredClone(expectedShape);
  settings.roleSettings[0].settings = [...settings.roleSettings[0].settings, "planted_setting=1"];
  assert.match((await run(settings))[0].text, /roleSettings: .*production-shape\.json .*; production /);
  const noRole = structuredClone(expectedShape);
  const gone = noRole.roles.pop();
  assert.match((await run(noRole)).map((f: Any) => f.text).join("\n"), new RegExp(`roles: ${gone.name}: production-shape\\.json has .*; production has none`));
  const acl = structuredClone(expectedShape);
  acl.schemaAcls[0].acl = [...acl.schemaAcls[0].acl, "anon=U/postgres"];
  assert.match((await run(acl))[0].text, /schemaAcls: /);
  const absentFn = { code: "PGRST202", message: "no function" };
  assert.deepEqual((await run(null, "after", absentFn)).map((f: Any) => f.severity), ["fail"]);
  assert.deepEqual((await run(null, "before", absentFn)).map((f: Any) => f.severity), ["warn"]);
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
test("the notification drain removes its planted rows even when the drain throws: no pending row is left for a real drain to send to the member (K:26)", async () => {
  const { db, io } = drainWorld();
  const findings = await notificationDrain({ io: { ...io, drain: async () => { throw new Error("drain exploded"); } } }).catch((e: Error) => e);
  assert.match(String((findings as Error).message), /drain exploded/, "the throw still reaches the runner, which records the check as failed");
  assert.deepEqual(db.rows("notification_outbox").map((r) => r.user_id), ["e0000000-0000-4000-8000-000000000009"], "only the other recipient's row remains: the planted pending row was deleted in the finally");
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
  const results = await runLive({ checks, io, phase: "after", record: rec, env: { GITHUB_EVENT_NAME: "status", GITHUB_SHA: "abc", GITHUB_RUN_ID: "77" }, log: () => {} });
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
  assert.deepEqual(DEFAULT_CHECKS, CHECKS.filter((c: string) => c !== "invitation-email" && c !== "provenance-trigger"), "the e-mail check and the trigger check (a short lock on intelligence_items) run only when a dispatch names them");
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
  // G3: the admin check skips for lack of its account only in the default set; a dispatch that names it has asked for it, and a rotated admin password is then a missing name, not a green skip.
  const named = planRun({ only: "admin-pages", env: full, base: "https://x.test", record: true });
  assert.deepEqual([named.skipped, named.run, named.missing.sort()], [[], ["admin-pages"], ["LIVE_ADMIN_EMAIL", "LIVE_ADMIN_PASSWORD"]]);
  // In CI the admin account is a configured secret: its absence is a missing name (exit 1 through the exit contract), never a skipped check.
  const inCi = planRun({ env: full, base: "https://x.test", record: true, ci: true });
  assert.deepEqual([inCi.skipped, inCi.run.includes("admin-pages"), inCi.missing.sort()], [[], true, ["LIVE_ADMIN_EMAIL", "LIVE_ADMIN_PASSWORD"]]);
  assert.equal(skipVerdict({ GITHUB_ACTIONS: "true" }, inCi.missing).exit, 1);
  // Audit 2.3.10: on a branch preview (adminPages false) the production admin account never signs in, whatever is set, in CI, and even when the dispatch named the check; nothing is then missing for it.
  const adminEnv = { ...full, LIVE_ADMIN_EMAIL: "a", LIVE_ADMIN_PASSWORD: "p" };
  for (const only of [undefined, "admin-pages"]) {
    const preview = planRun({ only, env: adminEnv, base: "https://x.test", record: true, ci: true, adminPages: false });
    assert.deepEqual([preview.run.includes("admin-pages"), preview.skipped.map((s: Any) => s.check), preview.missing], [false, ["admin-pages"], []], `only=${only}`);
  }
  assert.deepEqual(planRun({ env: full, base: "https://x.test", record: true, ci: true, adminPages: false }).missing, [], "a preview run needs no admin name");
});

test("the live checks send the protection bypass to the target origin only: no context-wide header, and the shared route-scoped installer is the one the browser context gets", () => {
  const source = readFileSync("scripts/ci/live-checks.mjs", "utf8");
  assert.doesNotMatch(source, /extraHTTPHeaders/);
  assert.match(source, /import \{[^}]*installBypass[^}]*\} from "\.\/live\/bypass\.mjs"/);
  assert.match(source, /await installBypass\(ctx, base, env\)/);
});

test("the script follows the one exit-code contract: a workstation with no credentials skips (exit 2) and names what is missing, never a value; a CI event that can carry secrets, or a named check, fails (exit 1) and lists the names; only a fork PR skips in CI", () => {
  const env = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" } as unknown as NodeJS.ProcessEnv;
  const run = (extra: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, ["scripts/ci/live-checks.mjs", "--base", "https://preview.example.test", ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  const local = run({});
  assert.equal(local.status, 2, local.stderr);
  assert.match(local.stdout, /self-skipped \(exit 2\).*NEXT_PUBLIC_SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/);
  for (const event of ["status", "workflow_dispatch", "push"]) {
    const ci = run({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: event });
    assert.equal(ci.status, 1, `${event}: a CI event that can carry secrets and lacks them has not run`);
    assert.match(ci.stdout, /missing \(exit 1\).*NEXT_PUBLIC_SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY/);
  }
  assert.equal(run({}, "--only", "member-reads").status, 1, "a check the caller named is a failure even on a workstation");
  const dir = mkdtempSync(join(tmpdir(), "live-event-"));
  writeFileSync(join(dir, "fork.json"), JSON.stringify({ pull_request: { head: { repo: { fork: true } } } }));
  const fork = run({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: join(dir, "fork.json") });
  assert.equal(fork.status, 2, "a fork PR cannot carry secrets: the one event that skips in CI");
  assert.match(fork.stdout, /fork cannot carry secrets; not set: .*SUPABASE_SERVICE_ROLE_KEY/);
  assert.equal(spawnSync(process.execPath, ["scripts/ci/live-checks.mjs", "--only", "nope", "--base", "https://x.test"], { env, encoding: "utf8" }).status, 1);
});

test("DRAIN-FIX-2 visibility: an applied item opens on its surface's route and draws a detail section head (a typed marker); no head, or an end away from the item, is a failure", async () => {
  const ID = "b293a2b6-c882-44dc-8efc-a801ed6a160b";
  const run = (page: Record<string, unknown>) => appliedItemsRender({ io: { appliedItemIds: [ID], itemPath: (_t: string, _d: number, id: string) => `/regulations/${id}`, service: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { item_type: "regulation", domain: 1 }, error: null }) }) }) }) }, openPage: async () => ({ status: 200, finalUrl: `https://x.test/regulations/${ID}`, uiFailures: [], apiFailures: [], ...page }) } });
  assert.deepEqual(await run({ sectionHeads: 5, itemId: ID }), []);
  assert.deepEqual(await run({ sectionHeads: 5, itemId: ID, finalUrl: "https://x.test/regulations/g19" }), [], "a uuid redirects to its slug: the landing URL is not judged (VISIBLE-FIX-2)");
  assert.match((await run({ sectionHeads: 0, itemId: ID }))[0]?.text ?? "", /drew no/);
  assert.match((await run({ sectionHeads: 5, itemId: "g19", finalUrl: "https://x.test/regulations/g19" }))[0]?.text ?? "", /shows item g19, not the item/);
  assert.match((await run({ sectionHeads: 5 }))[0]?.text ?? "", /no data-item-id/);
});
