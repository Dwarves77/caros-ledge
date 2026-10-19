/* eslint-disable no-console -- the log-capture test replaces the console methods to prove the token reaches no log line */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ClaimsUnavailable, getClaims } from "@/core/auth/claims";
import { ensureProfile } from "@/core/auth/ensure-profile";
import { EMPTY_IDENTITY, resolveIdentity } from "@/core/auth/identity";
import { acceptInvitation, createInvitation, declineInvitation, listInvitations, lookupInvitation, pendingInvitationsFor, revokeInvitation } from "@/core/auth/invitations";
import { assertNotLastOwner, currentMembership, isBanned, LookupError } from "@/core/auth/membership";
import { createOrgBody, createOrgForSelf, updateOrg } from "@/core/auth/orgs";
import { decidePlatformAdmin, isPlatformAdmin, readOwnPlatformAdmin } from "@/core/auth/platform-admin";
import { decideRoute, sanitizeReturnPath } from "@/core/auth/route-policy";
import { HttpError } from "@/core/http/errors";

import { scripted } from "../_support/fake-clients.ts";
import { fakeDb, filterValue, signedIn, signedOut, wrote } from "../_support/fake-db.ts";

const TOKEN = "a".repeat(64);
const ORG = "11111111-1111-4111-8111-111111111111";

test("getClaims: verified locally, null for no or bad session, ClaimsUnavailable for an outage", async () => {
  assert.deepEqual(await getClaims(fakeDb(undefined, { claims: signedIn("u1", "a@b.test") }).db), { userId: "u1", email: "a@b.test" });
  assert.equal(await getClaims(fakeDb(undefined, { claims: signedOut }).db), null);
  assert.equal(await getClaims(fakeDb(undefined, { claims: { data: { claims: {} }, error: null } }).db), null);
  await assert.rejects(getClaims(fakeDb(undefined, { claims: { data: null, error: { name: "AuthRetryableFetchError", message: "x" } } }).db), ClaimsUnavailable);
  await assert.rejects(getClaims(fakeDb(undefined, { claims: () => Promise.reject(new Error("boom")) }).db), (e: unknown) => e instanceof LookupError && (e as HttpError).status === 503);
});

test("currentMembership: the oldest membership wins and a read error is a LookupError, never null", async () => {
  const { db, calls } = fakeDb(() => ({ data: { org_id: ORG, role: "admin" } }));
  assert.deepEqual(await currentMembership(db, "u1"), { orgId: ORG, role: "admin" });
  assert.deepEqual(calls[0]?.order, [["created_at", true]]);
  assert.equal(calls[0]?.limit, 1);
  await currentMembership(db, "u1", ORG);
  assert.equal(filterValue(calls[1]!, "eq:org_id"), ORG);
  assert.equal(await currentMembership(fakeDb(() => ({ data: null })).db, "u1"), null);
  await assert.rejects(currentMembership(fakeDb(() => ({ error: { message: "down" } })).db, "u1"), LookupError);
});

test("INV-153: an organisation keeps at least one owner", async () => {
  const owners = (count: number | null, error?: { message: string }) => fakeDb(() => ({ count, error: error ?? null })).db;
  await assert.rejects(assertNotLastOwner(owners(1), ORG, "demote"), (e: unknown) => e instanceof HttpError && e.status === 409 && /Cannot demote the only owner/.test(e.message));
  await assert.rejects(assertNotLastOwner(owners(0), ORG, "ban"), HttpError);
  await assertNotLastOwner(owners(2), ORG, "demote");
  await assert.rejects(assertNotLastOwner(owners(null), ORG, "demote"), LookupError);
  await assert.rejects(assertNotLastOwner(owners(5, { message: "x" }), ORG, "demote"), LookupError);
});

test("isBanned is org-scoped and fails closed", async () => {
  const { db, calls } = fakeDb(() => ({ data: { user_id: "u1" } }));
  assert.equal(await isBanned(db, ORG, "u1"), true);
  assert.equal(filterValue(calls[0]!, "eq:org_id"), ORG);
  assert.equal(await isBanned(fakeDb(() => ({ data: null })).db, ORG, "u1"), false);
  await assert.rejects(isBanned(fakeDb(() => ({ error: { message: "x" } })).db, ORG, "u1"), LookupError);
});

test("decideRoute: segment matching, scanner 404, signed-in bounce, the query string survives the login redirect", () => {
  const anon = (pathname: string, search = "") => decideRoute({ pathname, search, authenticated: false });
  const authed = (pathname: string) => decideRoute({ pathname, authenticated: true });
  assert.deepEqual(anon("/dashboard", "?tab=a"), { action: "redirect-login", redirectTo: "/dashboard?tab=a" });
  const down = (pathname: string) => decideRoute({ pathname, authenticated: false, authUnavailable: true });
  assert.deepEqual(down("/dashboard"), { action: "service-unavailable" }, "an unreachable auth service is a 503 page, not the login form");
  assert.deepEqual(down("/login"), { action: "allow" });
  assert.deepEqual(down("/privacy"), { action: "allow" });
  assert.deepEqual(down("/api/health/surfaces"), { action: "allow" });
  assert.deepEqual(decideRoute({ pathname: "/dashboard", authenticated: true, authUnavailable: true }), { action: "allow" });
  assert.deepEqual(down("/wp-admin/x"), { action: "scanner-404" });
  for (const p of ["/login", "/signup", "/privacy", "/bot", "/auth/callback", "/auth/reset-password", "/login/x", "/api/anything", "/_next/data/x", "/robots.txt", "/favicon.ico"]) assert.deepEqual(anon(p), { action: "allow" }, p);
  for (const p of ["/loginx", "/privacy-evil", "/signup2", "/apixyz", "/_nextx", "/auth/callbackx"]) assert.equal(anon(p).action, "redirect-login", `${p} is not under a public prefix`);
  for (const p of ["/wp-admin/x", "/wp-login.php", "/a/b.php", "/xmlrpc.php"]) assert.deepEqual(anon(p), { action: "scanner-404" }, p);
  assert.deepEqual(authed("/login"), { action: "redirect-home" });
  assert.deepEqual(authed("/signup"), { action: "redirect-home" });
  assert.deepEqual(authed("/privacy"), { action: "allow" });
  assert.deepEqual(authed("/dashboard"), { action: "allow" });
});

test("sanitizeReturnPath: same-origin paths only, no control characters", () => {
  for (const ok of ["/", "/dashboard", "/a/b?x=1&y=2#h"]) assert.equal(sanitizeReturnPath(ok), ok);
  for (const bad of ["//evil.test", "/\\evil.test", "https://evil.test", "evil", "", null, undefined, "/\t/evil.test", "/\n//evil.test", "/a\rb", "/a\u0000b", "/a\u007fb"]) assert.equal(sanitizeReturnPath(bad as string), "/", JSON.stringify(bad));
});

test("decidePlatformAdmin: anonymous, denied (including a failed read) and admitted", async () => {
  assert.deepEqual(await decidePlatformAdmin(fakeDb(undefined, { claims: signedOut }).db), { kind: "anonymous" });
  assert.deepEqual(await decidePlatformAdmin(fakeDb(undefined, { claims: signedIn("u1"), rpc: () => ({ data: false }) }).db), { kind: "denied", userId: "u1" });
  assert.deepEqual(await decidePlatformAdmin(fakeDb(undefined, { claims: signedIn("u1"), rpc: () => ({ error: { message: "x" } }) }).db), { kind: "denied", userId: "u1" });
  assert.deepEqual(await decidePlatformAdmin(fakeDb(undefined, { claims: signedIn("u1", "a@b.test"), rpc: () => ({ data: true }) }).db), { kind: "admitted", userId: "u1", email: "a@b.test" });
  assert.equal(await readOwnPlatformAdmin(fakeDb(undefined, { rpc: () => ({ data: "true" }) }).db), false, "only a literal true admits");
  await assert.rejects(readOwnPlatformAdmin(fakeDb(undefined, { rpc: () => ({ error: { message: "x" } }) }).db), LookupError);
  assert.equal(await isPlatformAdmin("u1", fakeDb(() => ({ data: { is_platform_admin: true } })).db), true);
  assert.equal(await isPlatformAdmin("u1", fakeDb(() => ({ data: { is_platform_admin: 1 } })).db), false);
  await assert.rejects(isPlatformAdmin("u1", fakeDb(() => ({ error: { message: "x" } })).db), LookupError);
});

test("INV-154 / INV-137: ensureProfile creates the row with no privilege column; a race re-reads; a failure is counted", async () => {
  const created = fakeDb((c) => (c.op === "select" ? { data: null } : undefined));
  assert.deepEqual(await ensureProfile("u1", "a@b.test", created.db), { created: true, exists: true });
  assert.deepEqual(wrote(created.calls, "profiles", "insert")[0]?.payload, { id: "u1", email: "a@b.test", role: "member", settings: {} });
  assert.deepEqual(await ensureProfile("u1", "a@b.test", fakeDb(() => ({ data: { id: "u1" } })).db), { created: false, exists: true });

  let reads = 0;
  const race = fakeDb((c) => (c.op === "select" ? { data: ++reads > 1 ? { id: "u1" } : null } : { error: { message: "dup", code: "23505" } }));
  assert.deepEqual(await ensureProfile("u1", null, race.db), { created: false, exists: true });

  const events = fakeDb((c) => (c.table === "profiles" ? (c.op === "select" ? { data: null } : { error: { message: "denied", code: "42501" } }) : undefined));
  scripted.service = () => events.db;
  const failed = await ensureProfile("u1", "a@b.test", events.db);
  assert.deepEqual(failed, { created: false, exists: false, failedStep: "profiles_insert", reason: "denied" });
  assert.match(String((wrote(events.calls, "error_events", "insert")[0]?.payload as { message: string }).message), /ensure-profile failed at profiles_insert/);
});

test("P1 part a: sign in, claims, membership, organisation resolved", async () => {
  const { db } = fakeDb(
    (c) => (c.table === "org_memberships" ? { data: { org_id: ORG, role: "owner", organizations: { id: ORG, name: "Acme Freight", workspace_settings: [{ sector_profile: ["air", "road"] }] } } } : c.table === "profiles" ? { data: { sector_overrides: ["ocean"] } } : undefined),
    { claims: signedIn("u1", "ada@example.test"), rpc: () => ({ data: false }) },
  );
  assert.deepEqual(await resolveIdentity(db), { user: { id: "u1", email: "ada@example.test" }, orgId: ORG, orgName: "Acme Freight", role: "owner", sectors: ["ocean"], workspaceSectors: ["air", "road"], isPlatformAdmin: false });
  assert.deepEqual(await resolveIdentity(fakeDb(undefined, { claims: signedOut }).db), EMPTY_IDENTITY);
  const noOrg = await resolveIdentity(fakeDb((c) => (c.table === "profiles" ? { data: { sector_overrides: null } } : { data: null }), { claims: signedIn("u2"), rpc: () => ({ data: true }) }).db);
  assert.equal(noOrg.orgId, null);
  assert.equal(noOrg.isPlatformAdmin, true);
});

test("a failed identity lookup is a LookupError (503 and retry), never 'no workspace'", async () => {
  const claims = signedIn("u1");
  await assert.rejects(resolveIdentity(fakeDb((c) => (c.table === "org_memberships" ? { error: { message: "down" } } : undefined), { claims, rpc: () => ({ data: false }) }).db), LookupError);
  await assert.rejects(resolveIdentity(fakeDb((c) => (c.table === "profiles" ? { error: { message: "down" } } : undefined), { claims, rpc: () => ({ data: false }) }).db), LookupError);
  await assert.rejects(resolveIdentity(fakeDb(undefined, { claims, rpc: () => ({ error: { message: "down" } }) }).db), LookupError);
  await assert.rejects(resolveIdentity(fakeDb(undefined, { claims: { data: null, error: { name: "AuthRetryableFetchError", message: "x" } } }).db), ClaimsUnavailable);
});

test("INV-154: the identity pass heals a missing profile row", async () => {
  scripted.service = null;
  const caller = fakeDb((c) => (c.table === "profiles" ? { data: null } : { data: null }), { claims: signedIn("u9", "n@e.test"), rpc: () => ({ data: false }) });
  const identity = await resolveIdentity(caller.db);
  assert.equal(identity.user?.id, "u9");
  assert.equal(wrote(caller.calls, "profiles", "insert").length, 1, "the heal writes on the caller's own client (profiles_self_insert), with no service key configured");
  const none = fakeDb((c) => (c.op === "select" ? { data: null } : undefined));
  scripted.service = () => none.db;
  await resolveIdentity(fakeDb(() => ({ data: null }), { claims: signedIn("u9"), rpc: () => ({ data: false }) }).db, { heal: false });
  assert.equal(none.calls.length, 0);
});

test("INV-155: revoke is scoped to the URL's org BEFORE the write; the token is never logged", async () => {
  const other = fakeDb((c) => (c.table === "org_invitations" ? { data: { id: "i1", org_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", status: "pending" } } : undefined));
  await assert.rejects(revokeInvitation(other.db, ORG, "i1"), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.equal(other.rpcs.length, 0, "the rpc never runs for another org's invitation");
  const missing = fakeDb(() => ({ data: null }));
  await assert.rejects(revokeInvitation(missing.db, ORG, "i1"), HttpError);
  assert.equal(missing.rpcs.length, 0);
  const own = fakeDb(() => ({ data: { id: "i1", org_id: ORG, status: "pending" } }));
  await revokeInvitation(own.db, ORG, "i1");
  assert.deepEqual(own.rpcs, [{ name: "revoke_invitation", args: { p_invitation_id: "i1" } }]);
  const denied = fakeDb(() => ({ data: { id: "i1", org_id: ORG } }), { rpc: () => ({ error: { message: "x", code: "42501" } }) });
  await assert.rejects(revokeInvitation(denied.db, ORG, "i1"), (e: unknown) => e instanceof HttpError && e.status === 403);

  const logged: string[] = [];
  let issued = "";
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => ({ m, orig: console[m] }));
  for (const { m } of spies) console[m] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
  try {
    const issuing = fakeDb(() => ({ data: { id: "i2", token_last4: "aaaa", invited_email: "x@y.test", proposed_role: "member", expires_at: "2099-01-01", status: "pending", created_at: "2026-01-01" } }));
    await createInvitation(issuing.db, { orgId: ORG, userId: "u1", email: "x@y.test", role: "member", baseUrl: "https://app.example.test" });
    issued = String(wrote(issuing.calls, "org_invitations", "insert")[0]?.payload?.token_input);
    await createInvitation(fakeDb(() => ({ error: { message: `dup ${TOKEN}`, code: "23505" } })).db, { orgId: ORG, userId: "u1", email: "x@y.test", role: "member", baseUrl: "" }).catch(() => undefined);
  } finally {
    for (const { m, orig } of spies) console[m] = orig;
  }
  assert.equal(logged.filter((l) => l.includes(TOKEN) || l.includes(issued)).length, 0, "the token reached no log line");
  assert.match(issued, /^[0-9a-f]{64}$/, "the generated token was captured");
});

test("IMP-009: issue generates the token, returns the URL once, stores only the hash input, and the row read back carries token_last4 and no token", async () => {
  const issued = fakeDb(() => ({ data: { id: "i2", token_last4: "beef", invited_email: "x@y.test", proposed_role: "member", expires_at: "2099-01-01", status: "pending", created_at: "2026-01-01" } }));
  const { invitation, emailDelivery } = await createInvitation(issued.db, { orgId: ORG, userId: "u1", email: "x@y.test", role: "viewer", baseUrl: "https://app.example.test" });
  const insert = wrote(issued.calls, "org_invitations", "insert")[0]?.payload as Record<string, unknown>;
  const token = String(insert.token_input);
  assert.match(token, /^[0-9a-f]{64}$/, "a 32-byte hex token is generated in code and handed to the database as token_input");
  assert.equal(invitation.invite_url, `https://app.example.test/invitations/${token}`);
  assert.equal("token" in invitation, false);
  assert.equal("token_input" in invitation, false);
  assert.equal(invitation.token_last4, "beef");
  assert.deepEqual(insert, { org_id: ORG, invited_email: "x@y.test", invited_by_user_id: "u1", proposed_role: "viewer", token_input: token });
  assert.doesNotMatch(String(issued.calls[0]?.columns), /(^|[ ,])token(,|$)|token_input/, "the read-back never selects a raw token column");
  assert.deepEqual(emailDelivery, { delivered: false, configured: false, reason: "No email provider is configured on this deployment." });
  const again = fakeDb(() => ({ data: { id: "i3", token_last4: "cafe" } }));
  await createInvitation(again.db, { orgId: ORG, userId: "u1", email: "z@y.test", role: "member", baseUrl: "" });
  assert.notEqual((wrote(again.calls, "org_invitations", "insert")[0]?.payload as Record<string, unknown>).token_input, token, "every invitation gets a fresh token");
  const status = async (error: { message: string; code?: string }) => createInvitation(fakeDb(() => ({ error })).db, { orgId: ORG, userId: "u", email: "a@b.test", role: "member", baseUrl: "" }).catch((e: HttpError) => e.status);
  assert.equal(await status({ message: "dup", code: "23505" }), 409);
  assert.equal(await status({ message: "rls", code: "42501" }), 403);
  assert.equal(await status({ message: "boom" }), 500);
  await assert.rejects(createInvitation(fakeDb(() => ({ data: null })).db, { orgId: ORG, userId: "u", email: "a@b.test", role: "member", baseUrl: "" }), (e: unknown) => (e as HttpError).status === 403);
});

test("invitations: lazy expiry, lookup, accept and decline go through the rpc only (promotion-only accept)", async () => {
  const rows = [{ id: "1", status: "pending", expires_at: "2020-01-01" }, { id: "2", status: "pending", expires_at: "2099-01-01" }, { id: "3", status: "accepted", expires_at: "2020-01-01" }];
  const list = await listInvitations(fakeDb(() => ({ data: rows })).db, ORG, Date.parse("2026-06-01"));
  assert.deepEqual(list.map((r) => r.status), ["expired", "pending", "accepted"]);
  assert.equal((await lookupInvitation(fakeDb(undefined, { rpc: () => ({ data: [{ id: "1", org_name: "Acme" }] }) }).db, TOKEN)).org_name, "Acme");
  await assert.rejects(lookupInvitation(fakeDb(undefined, { rpc: () => ({ data: [] }) }).db, TOKEN), (e: unknown) => (e as HttpError).status === 404);
  const accepting = fakeDb(undefined, { rpc: () => ({ data: ORG }) });
  assert.equal(await acceptInvitation(accepting.db, TOKEN), ORG);
  assert.deepEqual(accepting.calls, [], "accept writes nothing itself: no org_memberships insert");
  const refused = (code: string) => acceptInvitation(fakeDb(undefined, { rpc: () => ({ error: { message: "raw", code } }) }).db, TOKEN).catch((e: HttpError) => [e.status, e.message]);
  assert.deepEqual(await refused("42501"), [403, "Not authorized to accept this invitation"]);
  assert.deepEqual(await refused("P0002"), [404, "Invitation not found"]);
  assert.deepEqual(await refused("22023"), [409, "raw"]);
  await assert.rejects(declineInvitation(fakeDb(undefined, { rpc: () => ({ error: { message: "x", code: "42501" } }) }).db, TOKEN), (e: unknown) => (e as HttpError).message === "Not authorized to decline this invitation");
});

test("pendingInvitationsFor: a failed user lookup is an error, never an empty list", async () => {
  const mine = fakeDb(() => ({ data: [{ id: "1", org_id: ORG, expires_at: "2099-01-01", organizations: { name: "Acme", slug: "acme" }, token_last4: "aaaa", proposed_role: "member", status: "pending", created_at: "x" }, { id: "2", expires_at: "2020-01-01" }] }), { users: { u1: { email: "Ada@Example.test" } } });
  const list = await pendingInvitationsFor(mine.db, "u1", Date.parse("2026-06-01"));
  assert.equal(list.length, 1);
  assert.equal(list[0]?.org_name, "Acme");
  assert.equal(list[0]?.token_last4, "aaaa");
  assert.equal("token" in (list[0] ?? {}), false, "IMP-009: mine returns the last four characters, never a token");
  assert.doesNotMatch(String(mine.calls[0]?.columns), /(^|[ ,])token(,|$)/);
  assert.equal(filterValue(mine.calls[0]!, "eq:invited_email"), "ada@example.test");
  assert.deepEqual(await pendingInvitationsFor(fakeDb(undefined, { users: {} }).db, "u1"), []);
  await assert.rejects(pendingInvitationsFor(fakeDb(undefined, { userError: { message: "auth down" } }).db, "u1"), (e: unknown) => (e as HttpError).status === 500);
});

test("INV-137: a request body cannot set privilege columns or any column but its own", async () => {
  const body = createOrgBody().parse({ name: " Acme ", is_platform_admin: true, role: "owner", org_id: "x", sectors: ["air", "air"], regions: ["EU"] });
  assert.deepEqual(Object.keys(body).sort(), ["headcount_band", "job_title", "name", "regions", "sectors"].filter((k) => k in body).sort());
  assert.equal("is_platform_admin" in body, false);
  assert.equal("role" in body, false);
  assert.deepEqual(body.sectors, ["air"]);
  assert.equal(body.name, "Acme");
});

test("orgs: vocabulary sets are enforced when the workspace slice passes them; a failed patch is reported", async () => {
  const vocab = { sectors: new Set(["air"]), regions: new Set(["EU"]), headcountBands: new Set(["1-10"]) };
  assert.equal(createOrgBody(vocab).safeParse({ name: "A", sectors: ["rail"] }).success, false);
  assert.equal(createOrgBody(vocab).safeParse({ name: "A", regions: ["XX"] }).success, false);
  assert.equal(createOrgBody(vocab).safeParse({ name: "A", headcount_band: "huge" }).success, false);
  assert.equal(createOrgBody(vocab).safeParse({ name: "A", sectors: ["air"], regions: ["EU"], headcount_band: "1-10" }).success, true);
  assert.equal(createOrgBody().safeParse({ name: "" }).success, false);
  assert.equal(createOrgBody().safeParse({ name: "x".repeat(201) }).success, false);

  scripted.service = () => fakeDb((c) => (c.op === "select" ? { data: { id: "u1" } } : undefined)).db;
  const input = createOrgBody().parse({ name: "Acme", sectors: ["air"], headcount_band: "1-10", job_title: "Ops", regions: ["EU"] });
  const client = fakeDb((c) => (c.table === "workspace_settings" && c.op === "update" ? { error: { message: "no" } } : c.table === "organizations" ? { data: { id: ORG, name: "Acme", slug: "acme" } } : undefined), { rpc: (name) => (name === "create_org_for_self" ? { data: ORG } : name === "patch_workspace_settings" ? { data: { org_size: { headcount_band: "1-10" } } } : undefined) });
  const made = await createOrgForSelf(client.db, { id: "u1", email: "a@b.test" }, input);
  assert.deepEqual(made, { orgId: ORG, slug: "acme", name: "Acme", settingsSaved: false, profileSaved: true });
  assert.deepEqual(client.rpcs, [
    { name: "create_org_for_self", args: { p_org_name: "Acme", p_org_slug: null } },
    { name: "patch_workspace_settings", args: { p_org_id: ORG, p_column: "profile", p_patch: { org_size: { headcount_band: "1-10" } } } },
  ]);
  assert.equal(client.calls.filter((c) => c.table === "workspace_settings" && c.op === "select").length, 0, "IMP-022: the size is merged by the database, never read-merged-written here");
  const profilePatch = wrote(client.calls, "profiles", "update")[0]?.payload as Record<string, unknown>;
  assert.deepEqual([profilePatch.job_title, profilePatch.region], ["Ops", ["EU"]]);
  assert.equal("is_platform_admin" in profilePatch, false);
  await assert.rejects(createOrgForSelf(fakeDb(undefined, { rpc: () => ({ error: { message: "slug taken" } }) }).db, { id: "u1", email: null }, input), (e: unknown) => (e as HttpError).status === 400);
});

test("updateOrg: only name and slug, a taken slug is a 409, an empty patch a 400", async () => {
  await assert.rejects(updateOrg(fakeDb().db, ORG, {}), (e: unknown) => (e as HttpError).status === 400);
  await assert.rejects(updateOrg(fakeDb(() => ({ error: { message: "dup", code: "23505" } })).db, ORG, { slug: "taken" }), (e: unknown) => (e as HttpError).status === 409);
  const ok = fakeDb(() => ({ data: { id: ORG, name: "New" } }));
  assert.equal((await updateOrg(ok.db, ORG, { name: "New" })).name, "New");
  const patch = wrote(ok.calls, "organizations", "update")[0]?.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(patch).sort(), ["name", "updated_at"]);
});
