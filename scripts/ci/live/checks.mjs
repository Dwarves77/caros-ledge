// The live checks (P2-15 PART A, P2-08 D): what is proven about a DEPLOYED URL and the database behind it, as functions of an injected `io`, so each one is tried against fakes (tests/cutover/live-checks.test.ts) and run against the
// real thing by scripts/ci/live-checks.mjs. A check returns findings {severity: "fail" | "warn", invariant, url, text}; the runner turns each check's findings into one `live-smoke` row (src/core/harness/live-smoke.ts, through recordRun).
// `phase` is "before" when the run is the one made BEFORE the cutover window (the new tree's preview on the database that does not carry the new migrations yet): an object a pending migration adds is then a warning that names the
// migration; in "after" (the default) it is a failure. Everything else is a failure in both phases.
import { isMissingObject } from "../../../src/core/db/absent.ts";
import { shapeDiff } from "../schema/shape.mjs";

export const CHECKS = ["member-reads", "sign-in", "pages", "identity-anonymous", "provenance-trigger", "notification-drain", "admin-pages", "invitation-email", "production-shape"];
/**
 * Checks that run only when a dispatch names them (--only): invitation-email sends a real message, and provenance-trigger takes a short lock on intelligence_items (migration 0069 disables a trigger under lock_timeout), which a
 * preview deployment must not do to production each time one is built. The default set runs on every preview; these two run on a named dispatch (the nightly one).
 */
export const NAMED_ONLY = ["invitation-email", "provenance-trigger"];
export const DEFAULT_CHECKS = CHECKS.filter((c) => !NAMED_ONLY.includes(c));
/** One page per surface: the Dashboard, Regulations, Market Intel, Research, Operations, the watchlist, Search, Community and Settings. */
export const SURFACE_PAGES = ["/", "/regulations", "/market", "/research", "/operations", "/watchlist", "/search", "/community", "/settings"];
export const ADMIN_PAGES = ["/admin"];
/** The words of the app's own failure blocks (PageFailure, ErrorState, the stated-failure parts) and of the framework's error pages. */
export const FAILURE_BLOCK = /did not load|could not be loaded|could not load|Application error|Something went wrong on our side|Internal Server Error|This page couldn.t load/i;

/** The environment NAMES each check needs; a check whose names are not all set is skipped (admin) or the run self-skips (the rest). */
export const NEEDS = {
  base: ["LIVE_BASE_URL"],
  record: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
  member: ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "LIVE_SMOKE_EMAIL", "LIVE_SMOKE_PASSWORD"],
  admin: ["LIVE_ADMIN_EMAIL", "LIVE_ADMIN_PASSWORD"],
  email: ["RESEND_API_KEY", "INVITATION_FROM_EMAIL"],
};
export const missingNames = (names, env) => names.filter((n) => !env[n]);

const fail = (invariant, url, text) => ({ severity: "fail", invariant, url, text });
const warn = (invariant, url, text) => ({ severity: "warn", invariant, url, text });
export const isAbsent = isMissingObject; // the one list of "the object a pending migration adds is not there" codes (src/core/db/absent.ts)
/** An absent object is a warning before the window and a failure after it; any other error is a failure. */
const absentOr = (phase, invariant, url, e, migration) => (isAbsent(e) ? (phase === "before" ? warn : fail)(invariant, url, `${url} is absent (migration ${migration} is not applied here): ${e.message}`) : fail(invariant, url, `${url} failed: ${e.message}`));

/** The finding for one page load, or null when it rendered. A failure status, a redirect to the sign-in or unavailable page, or the app's own failure block is a failure. */
export function pageFinding(invariant, path, page) {
  if (!page || page.error) return fail(invariant, path, `${path} did not answer: ${page?.error ?? "no response"}`);
  if (page.status >= 400) return fail(invariant, path, `${path} answered HTTP ${page.status}`);
  if (/^\/(login|service-unavailable)/.test(new URL(page.finalUrl, "https://x.invalid").pathname) && !path.startsWith("/login")) return fail(invariant, path, `${path} ended at ${new URL(page.finalUrl, "https://x.invalid").pathname}`);
  const block = FAILURE_BLOCK.exec(page.text ?? "");
  return block ? fail(invariant, path, `${path} shows a failure block ("${block[0]}")`) : null;
}

/** IMP-116: the member reads of 0038, 0040, 0042 and 0064 as `authenticated` on the live database, and a member select from research_assessments_current against what the service role can see. */
export async function memberReads(ctx) {
  const { phase = "after", io } = ctx;
  const out = [];
  const m = await io.member();
  const org = await m.db.from("org_memberships").select("org_id").eq("user_id", m.userId).limit(1);
  if (org.error || !org.data?.[0]) return [fail("member-reads", "org_memberships", `the member test account has no readable workspace membership${org.error ? `: ${org.error.message}` : ""}`)];
  const bundle = await m.db.rpc("load_settings_bundle", { p_org_id: org.data[0].org_id, p_user_id: m.userId, p_limit: 5 });
  if (bundle.error) out.push(absentOr(phase, "member-reads", "load_settings_bundle", bundle.error, "0038"));
  else if (!bundle.data || !["overrides", "personal", "supersessions", "history", "truncated"].every((k) => k in bundle.data)) out.push(fail("member-reads", "load_settings_bundle", "load_settings_bundle answered without its five parts"));

  const seen = await m.db.from("research_assessments_current").select("item_id").limit(200);
  if (seen.error) out.push(absentOr(phase, "member-reads", "research_assessments_current", seen.error, "0040"));
  else {
    const all = await io.service.from("research_assessments_current").select("item_id").limit(500);
    if (all.error) out.push(fail("member-reads", "research_assessments_current", `the service-role read of the same view failed: ${all.error.message}`));
    else {
      const ids = [...new Set((all.data ?? []).map((r) => r.item_id))];
      const open = ids.length ? await io.service.from("intelligence_items").select("id").in("id", ids).eq("provenance_status", "verified").eq("is_archived", false) : { data: [], error: null };
      if (open.error) out.push(fail("member-reads", "intelligence_items", `the service-role read of the items failed: ${open.error.message}`));
      else if (open.data.length > 0 && (seen.data ?? []).length === 0) out.push((phase === "before" ? warn : fail)("member-reads", "research_assessments_current", `a member reads 0 current assessments where ${open.data.length} belong to items a member may open (the view returns nothing to a member until 0040 is applied)`));
      else if (open.data.length === 0) out.push(warn("member-reads", "research_assessments_current", "no current assessment belongs to an open item, so there is nothing to compare the member's read with"));
    }
  }
  const hist = await m.db.from("research_assessment_history").select("id").limit(1);
  if (hist.error) out.push(absentOr(phase, "member-reads", "research_assessment_history", hist.error, "0040"));

  for (const [table, migration] of [["host_verdicts", "0042"], ["host_worklist", "0064"]]) {
    const r = await m.db.from(table).select("host").limit(5);
    if (r.error) out.push(absentOr(phase, "member-reads", table, r.error, migration));
    else {
      if ((r.data ?? []).length > 0) out.push(fail("member-reads", table, `a member reads ${r.data.length} row(s) of ${table}, which only a platform admin may read`));
      const w = await m.db.from(table).insert({ host: "live-check.invalid", ...(table === "host_verdicts" ? { class: "company" } : { reason: "live check" }) });
      if (!w.error) out.push(fail("member-reads", table, `a member wrote a row to ${table}`));
    }
  }
  return out;
}

/** The member signs in through the form and lands off /login. */
export async function signIn(ctx) {
  const r = await ctx.io.signInMember();
  return r.ok ? [] : [fail("sign-in", "/login", `member sign-in failed: ${r.error}`)];
}

/** One page per surface renders for the signed-in member without a failure block. */
export async function pages(ctx, list = SURFACE_PAGES, as = "member", invariant = "pages") {
  const out = [];
  const visited = [];
  for (const path of list) {
    const page = await ctx.io.openPage(path, as);
    visited.push(path);
    const f = pageFinding(invariant, path, page);
    if (f) out.push(f);
  }
  ctx.visited?.push(...visited);
  return out;
}

/** The admin console renders for the admin test account (skipped by the runner when no admin credentials are set). */
export async function adminPages(ctx) {
  return pages(ctx, ADMIN_PAGES, "admin", "admin-pages");
}

/**
 * The key shapes the tree writes into rate_limit_windows (src/core/http/rate-limit.ts checkRateLimit callers), all behind authentication or a worker secret:
 *   user:<uuid>  src/features/auth/api/identity.ts:21     bare <uuid>  src/core/http/guard.ts:51 (every guarded member route)
 *   worker:<route>  health/api/surfaces.ts:30, sources/api/check-sources.ts:22, telemetry/api/revalidate.ts:21
 * An anonymous caller can only produce what clientKey() makes (rate-limit.ts:~100): `ip:<address>` or `anon:unknown` (auth/api/callback.ts:9), never one of these.
 */
export const AUTHENTICATED_KEY = /^(user:[0-9a-f-]{36}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|worker:\/.+)$/i;
const KEY_PAGE = 5000;

/** The keys now in the limiter table: a Set, or {error}. */
async function limiterKeys(io) {
  const r = await io.service.from("rate_limit_windows").select("key").limit(KEY_PAGE);
  return r.error ? { error: r.error } : { keys: new Set((r.data ?? []).map((x) => x.key)), full: (r.data ?? []).length >= KEY_PAGE };
}

/**
 * The identity route answers an anonymous caller 200 with the empty identity, 25 times in a row, with no cookie and no rate-limit header, and writes no limiter window an anonymous caller could own.
 * The instrument is the SET of keys, not the table's row count: other sessions (the member's, the operator's, real users) add user:<uuid> windows in the same seconds, which are reported, not failed.
 */
export async function identityAnonymous(ctx) {
  const { phase = "after", io } = ctx;
  const before = await limiterKeys(io);
  if (before.error && !isAbsent(before.error)) return [fail("identity-anonymous", "rate_limit_windows", `the limiter keys could not be read: ${before.error.message}`)];
  const out = [];
  for (let i = 0; i < 25; i += 1) {
    const r = await io.getJson("/api/auth/identity");
    if (r.status !== 200 || r.body?.user !== null) {
      out.push(fail("identity-anonymous", "/api/auth/identity", `call ${i + 1}: HTTP ${r.status}, user ${JSON.stringify(r.body?.user ?? null)} (an anonymous caller is 200 with no user, every time)`));
      break;
    }
    const bad = (r.headerNames ?? []).filter((h) => h === "set-cookie" || h === "retry-after" || h.startsWith("x-ratelimit-"));
    if (bad.length) {
      out.push(fail("identity-anonymous", "/api/auth/identity", `call ${i + 1}: the anonymous answer carries ${bad.join(", ")} (no session and no limiter: nothing to set, nothing to count)`));
      break;
    }
  }
  const after = await limiterKeys(io);
  if (before.error) out.push((phase === "before" ? warn : fail)("identity-anonymous", "rate_limit_windows", "rate_limit_windows is absent (migration 0019 is not applied here): the limiter is not observable"));
  else if (after.error) out.push(fail("identity-anonymous", "rate_limit_windows", `the limiter keys could not be read after the calls: ${after.error.message}`));
  else {
    const added = [...after.keys].filter((k) => !before.keys.has(k));
    const foreign = added.filter((k) => !AUTHENTICATED_KEY.test(k));
    if (foreign.length) out.push(fail("identity-anonymous", "rate_limit_windows", `the anonymous calls left limiter key(s) only an anonymous caller writes: ${foreign.slice(0, 5).join(", ")}: the route touched the database`));
    const others = added.length - foreign.length;
    if (others > 0) out.push(warn("identity-anonymous", "rate_limit_windows", `${others} new authenticated or worker limiter key(s) appeared meanwhile (other sessions, not these calls); informational`));
    if (before.full || after.full) out.push(warn("identity-anonymous", "rate_limit_windows", `the limiter table has at least ${KEY_PAGE} keys: the key comparison read only the first ${KEY_PAGE}`));
  }
  return out;
}

/** IMP-074's residue: the database trigger set_provenance_status_trg takes a verified fixture whose ledger is empty out of `verified` (live_check_provenance_trigger plants it, touches it and rolls back). */
export async function provenanceTrigger(ctx) {
  const r = await ctx.io.service.rpc("live_check_provenance_trigger");
  if (r.error) return [absentOr(ctx.phase ?? "after", "provenance-trigger", "live_check_provenance_trigger", r.error, "0068")];
  const d = r.data ?? {};
  const out = [];
  if (d.flipped !== true) out.push(fail("provenance-trigger", "set_provenance_status_trg", `the trigger did not take the verified fixture out of verified (before ${d.before}, after ${d.after}): the grounding apply relies on it`));
  if (d.left_behind !== 0) out.push(fail("provenance-trigger", "intelligence_items", `the check left ${d.left_behind} fixture row(s) behind`));
  return out;
}

/**
 * The notification drain drains a planted outbox row: the row is sent, the member's notification exists, and both are removed again. The removal is in a `finally`: a drain that throws must not leave a `pending` row
 * behind for the next real drain to send ("Live check") to the member account.
 */
export async function notificationDrain(ctx) {
  const { io } = ctx;
  const m = await io.member();
  const tag = io.runId;
  const planted = await io.service.from("notification_outbox").insert({ user_id: m.userId, kind: "invite", payload: { title: "Live check", body: "A planted notification; it is removed again.", link: "/", live_check: tag }, status: "pending" }).select("id").single();
  if (planted.error) return [absentOr(ctx.phase ?? "after", "notification-drain", "notification_outbox", planted.error, "0025")];
  const id = planted.data.id;
  const out = [];
  try {
    const run = await io.drain([id]);
    if (run.counts?.sent !== 1 || run.outcome === "failed") out.push(fail("notification-drain", "notification_outbox", `the drain did not send the planted row (${JSON.stringify(run.counts)}; ${(run.notes ?? []).join("; ")})`));
    const row = await io.service.from("notification_outbox").select("status, sent_at").eq("id", id).single();
    if (row.error || row.data?.status !== "sent" || !row.data?.sent_at) out.push(fail("notification-drain", "notification_outbox", `the planted row is not stamped sent (${row.error?.message ?? JSON.stringify(row.data)})`));
    const note = await io.service.from("notifications").select("id").eq("user_id", m.userId).eq("payload->>live_check", tag);
    if (note.error || (note.data ?? []).length !== 1) out.push(fail("notification-drain", "notifications", `the member's notification was not written once (${note.error?.message ?? (note.data ?? []).length})`));
  } finally {
    const cleanup = [await io.service.from("notifications").delete().eq("user_id", m.userId).eq("payload->>live_check", tag), await io.service.from("notification_outbox").delete().eq("id", id)];
    for (const c of cleanup) if (c.error) out.push(fail("notification-drain", "cleanup", `the planted rows were not removed: ${c.error.message}`));
  }
  return out;
}

/** IMP-014 at the window: one invitation e-mail goes to the member test account through the configured provider. */
export async function invitationEmail(ctx) {
  const r = await ctx.io.sendInvitation();
  return r.delivered ? [] : [fail("invitation-email", "sendInvitationEmail", `the invitation e-mail was not delivered (configured ${r.configured}): ${r.reason ?? "no reason given"}`)];
}

/**
 * G11: the database behind the deployment is shaped as scripts/ci/data/production-shape.json says (roles and their attributes, memberships, role settings such as search_path and statement_timeout, schema and default
 * ACLs, server settings, the database owner). The CI database is built from that file, so a drift in production (a platform change, a hand edit in the dashboard) would otherwise leave every schema job proving things about
 * a database that no longer exists. The query is public.live_check_production_shape() (migration 0071, the text of scripts/ci/data/production-shape.sql); `io.expectedShape` is the file's `shape`.
 */
export async function productionShape(ctx) {
  const r = await ctx.io.service.rpc("live_check_production_shape");
  if (r.error) return [absentOr(ctx.phase ?? "after", "production-shape", "live_check_production_shape", r.error, "0071")];
  const actual = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
  if (!actual || typeof actual !== "object") return [fail("production-shape", "live_check_production_shape", "the function answered with no shape document")];
  return shapeDiff(ctx.io.expectedShape, actual, { want: "production-shape.json", have: "production" }).map((d) => fail("production-shape", "production-shape.json", d));
}

export const RUNNERS = { "member-reads": memberReads, "sign-in": signIn, pages, "identity-anonymous": identityAnonymous, "provenance-trigger": provenanceTrigger, "notification-drain": notificationDrain, "admin-pages": adminPages, "invitation-email": invitationEmail, "production-shape": productionShape };
