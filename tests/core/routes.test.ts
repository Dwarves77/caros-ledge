import assert from "node:assert/strict";
import { test } from "node:test";

import { GET as callbackGet } from "@/features/auth/api/callback";
import { GET as identityGet } from "@/features/auth/api/identity";
import { GET as invitationsGet, POST as invitationsPost } from "@/features/auth/api/invitations";
import { DELETE as revoke } from "@/features/auth/api/invitation-revoke";
import { accept, decline, GET as tokenGet } from "@/features/auth/api/invitation-token";
import { GET as mineGet } from "@/features/auth/api/invitations-mine";
import { DELETE as membersDelete, GET as membersGet, PATCH as membersPatch, POST as membersPost, PUT as membersPut } from "@/features/auth/api/members";
import { GET as orgGet, PATCH as orgPatch } from "@/features/auth/api/org";
import { POST as orgsPost } from "@/features/auth/api/orgs-create";

import { scripted } from "../_support/fake-clients.ts";
import { fakeDb, filterValue, wrote, type Call, type Reply } from "../_support/fake-db.ts";
import { as, ctx, json, MEMBERSHIP_ID, ORG_A, ORG_B, OTHER_MEMBERSHIP_ID, PERSONAS, personaOf, script, userDbFor, type Persona } from "../_support/personas.ts";

const TOKEN = "b".repeat(64);
const INVITE_A = "55555555-5555-4555-8555-555555555555";
const INVITE_B = "66666666-6666-4666-8666-666666666666";

/** The service-role side of the world: a roster, an org, two memberships in two orgs, one invitation per org. */
function world(over?: (c: Call) => Reply | undefined, rpcOver?: (name: string, args: unknown) => Reply | undefined) {
  return fakeDb(
    (c) => {
      const custom = over?.(c);
      if (custom) return custom;
      const eq = (k: string) => filterValue(c, `eq:${k}`);
      if (c.table === "org_memberships" && c.op === "select") {
        if (c.head) return { count: 2 };
        if (eq("id")) return { data: { id: eq("id"), user_id: eq("id") === MEMBERSHIP_ID ? "t1" : "t9", role: "member", org_id: eq("id") === MEMBERSHIP_ID ? ORG_A : ORG_B } };
        if (eq("role") === "owner") return { data: { user_id: "u-owner", created_at: "2026-01-01", user: { full_name: "Olga Owner" } } };
        if (eq("user_id")) return { data: null };
        return { data: [{ id: MEMBERSHIP_ID, user_id: "u-member", role: "member", created_at: "2026-01-02", user: { full_name: "Mia Member", email: "m@example.test" } }] };
      }
      if (c.table === "org_memberships" && c.op === "update") return { data: { id: MEMBERSHIP_ID, role: "admin" } };
      if (c.table === "org_memberships" && c.op === "insert") return { data: { id: "new", user_id: "t2", role: "member" } };
      if (c.table === "profiles" && c.columns === "is_platform_admin") return { data: { is_platform_admin: eq("id") === "u-admin" } };
      if (c.table === "profiles" && c.op === "select") return { data: { id: "t2" } };
      if (c.table === "organizations" && c.op === "select") return { data: { id: ORG_A, name: "Org A", slug: "org-a", plan: "pro", created_at: "2026-01-01" } };
      if (c.table === "organizations" && c.op === "update") return { data: { id: ORG_A, name: "Renamed" } };
      return undefined;
    },
    { users: { "u-member": { email: "member@example.test" } }, rpc: (name, args) => rpcOver?.(name, args) ?? (name === "profiles_by_email" ? { data: (args as { p_email: string }).p_email.startsWith("unknown") ? [] : [{ id: "t2" }] } : undefined) },
  );
}

const call = async (handler: (r: Request, c: never) => Promise<Response>, persona: Persona, url: string, init: RequestInit, params: Record<string, string> = {}) => {
  const res = await handler(as(persona, url, init), ctx(params) as never);
  return res.status;
};

/** A persona matrix: the expected status for each of anon, viewer, other-org member, member, owner, platform admin. */
async function matrix(name: string, run: (persona: Persona) => Promise<number>, expected: Record<Persona, number>) {
  for (const persona of PERSONAS) assert.equal(await run(persona), expected[persona], `${name} as ${persona}`);
}
const E = (anon: number, viewer: number, otherOrgMember: number, member: number, owner: number, platformAdmin: number): Record<Persona, number> => ({ anon, viewer, otherOrgMember, member, owner, platformAdmin });

test("persona matrix: org GET and PATCH (the rename is rename_org on the caller's own client: org_can decides in the database, and the route never reads who the caller is)", async () => {
  let who: Persona = "anon";
  script(world(), undefined, (name) => (name === "rename_org" ? (who === "owner" || who === "platformAdmin" ? { data: { id: ORG_A, name: "Renamed", slug: "org-a" } } : { error: { message: "only an owner may rename the organisation", code: "42501" } }) : undefined));
  const orgParams = { org_id: ORG_A };
  await matrix("org GET", (p) => call(orgGet, p, `/api/orgs/${ORG_A}`, {}, orgParams), E(401, 200, 403, 200, 200, 200)); // IMP-012: a platform admin reads any organization's record
  await matrix("org PATCH", (p) => ((who = p), call(orgPatch, p, `/api/orgs/${ORG_A}`, { method: "PATCH", body: json({ name: "Renamed" }) }, orgParams)), E(401, 403, 403, 403, 200, 200));
  const owner = await orgGet(as("owner", `/api/orgs/${ORG_A}`), ctx(orgParams));
  const body = await owner.json();
  assert.deepEqual([body.org.slug, body.caller_role, body.member_count, body.owner.display_name], ["org-a", "owner", 2, "Olga Owner"]);
  assert.equal((await (await orgGet(as("platformAdmin", `/api/orgs/${ORG_A}`), ctx(orgParams))).json()).caller_role, "platform_admin", "the admin is named as one, not as a member");
});

test("persona matrix: invitations (RLS decides who may issue), revoke, token routes, mine, orgs, identity", async () => {
  const invite = { id: INVITE_A, token_last4: "aaaa", invited_email: "x@y.test", proposed_role: "member", expires_at: "2099-01-01", status: "pending", created_at: "2026-01-01" };
  // invitations are written and read on the caller's own RLS client; the service client only serves "mine"
  script(
    world(),
    (c) => (c.table === "org_invitations" && c.op === "insert" ? { data: invite } : c.table === "org_invitations" && c.columns?.includes("org_id") ? { data: { id: filterValue(c, "eq:id"), org_id: filterValue(c, "eq:id") === INVITE_A ? ORG_A : ORG_B, status: "pending" } } : c.table === "org_invitations" ? { data: [] } : undefined),
    (name) => (name === "create_org_for_self" ? { data: ORG_A } : name === "invite_member" ? { data: invite } : undefined), // who may invite is org_can in the database (migration 0101 proves it), so the fake accepts every signed-in caller
  );
  const orgParams = { org_id: ORG_A };
  await matrix("invitations GET", (p) => call(invitationsGet, p, `/api/orgs/${ORG_A}/invitations`, {}, orgParams), E(401, 200, 200, 200, 200, 200));
  await matrix("invitations POST", (p) => call(invitationsPost, p, `/api/orgs/${ORG_A}/invitations`, { method: "POST", body: json({ email: "x@y.test", role: "member" }) }, orgParams), E(401, 201, 201, 201, 201, 201));
  await matrix("revoke own org's invitation", (p) => call(revoke, p, `/api/orgs/${ORG_A}/invitations/${INVITE_A}`, { method: "DELETE" }, { org_id: ORG_A, id: INVITE_A }), E(401, 200, 200, 200, 200, 200));
  assert.equal(await call(revoke, "owner", `/api/orgs/${ORG_A}/invitations/${INVITE_B}`, { method: "DELETE" }, { org_id: ORG_A, id: INVITE_B }), 404, "another org's invitation");
  assert.equal(await call(revoke, "owner", "/x", { method: "DELETE" }, { org_id: "nope", id: INVITE_A }), 400);
  await matrix("token GET", (p) => call(tokenGet, p, `/api/invitations/${TOKEN}`, {}, { token: TOKEN }), E(401, 404, 404, 404, 404, 404));
  assert.equal(await call(tokenGet, "member", "/x", {}, { token: "short" }), 400);
  assert.equal(await call(accept, "anon", "/x", { method: "POST" }, { token: TOKEN }), 401);
  assert.equal(await call(decline, "anon", "/x", { method: "POST" }, { token: TOKEN }), 401);
  assert.equal(await call(accept, "member", "/x", { method: "POST" }, { token: "short" }), 400);
  await matrix("mine GET", (p) => call(mineGet, p, "/api/invitations/mine", {}), E(401, 200, 200, 200, 200, 200));
  await matrix("orgs POST", (p) => call(orgsPost, p, "/api/orgs", { method: "POST", body: json({ name: "Acme" }) }), E(401, 201, 201, 201, 201, 201));
  assert.equal(await call(orgsPost, "member", "/api/orgs", { method: "POST", body: json({ name: "" }) }), 400);
  assert.equal(await call(orgsPost, "member", "/api/orgs", { method: "POST", body: "{" }), 400);
});

test("invitation rpc routes answer through the one map", async () => {
  const withRpc = (error?: { message: string; code: string }) =>
    script(world(), undefined, (name) => (name === "lookup_invitation" ? { data: [{ id: INVITE_A, org_name: "Org A" }] } : error ? { error } : { data: ORG_A }));
  withRpc();
  assert.equal((await (await tokenGet(as("member", "/x"), ctx({ token: TOKEN }))).json()).invitation.org_name, "Org A");
  assert.deepEqual(await (await accept(as("member", "/x", { method: "POST" }), ctx({ token: TOKEN }))).json(), { ok: true, org_id: ORG_A });
  assert.deepEqual(await (await decline(as("member", "/x", { method: "POST" }), ctx({ token: TOKEN }))).json(), { ok: true, status: "declined" });
  for (const [code, status] of [["42501", 403], ["P0002", 404], ["22023", 409], ["XX000", 500]] as const) {
    withRpc({ message: "raw", code });
    assert.equal(await call(accept, "member", "/x", { method: "POST" }, { token: TOKEN }), status, code);
    assert.equal(await call(decline, "member", "/x", { method: "POST" }, { token: TOKEN }), status, code);
  }
});

test("identity route: anonymous is an empty identity, a lookup failure is a 503 and is counted, never 'no workspace'", async () => {
  const service = script(world());
  const anon = await identityGet(as("anon", "/api/auth/identity"), undefined);
  assert.equal(anon.status, 200);
  assert.equal((await anon.json()).user, null);
  assert.equal(anon.headers.get("Cache-Control"), "private, no-store");
  const owner = await (await identityGet(as("owner", "/api/auth/identity"), undefined)).json();
  assert.deepEqual([owner.orgId, owner.role, owner.orgName], [ORG_A, "owner", "Org A"]);
  scripted.user = () => userDbFor("owner", (c) => (c.table === "org_memberships" ? { error: { message: "down" } } : undefined)).db;
  const failed = await identityGet(as("owner", "/api/auth/identity"), undefined);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("Retry-After"), "1");
  assert.deepEqual(await failed.json(), { error: "identity_lookup_failed" });
  assert.equal(wrote(service.calls, "error_events", "insert").length, 1);
});

test("auth callback: creates the profile and nothing else, sends the visitor to a same-origin path", async () => {
  const service = script(world((c) => (c.table === "profiles" && c.op === "select" ? { data: null } : undefined)));
  const exchanging = (error: unknown) => ({ auth: { exchangeCodeForSession: async () => ({ data: { user: { id: "u-new", email: "n@e.test" } }, error }) } }) as never;
  scripted.user = () => exchanging(null);
  const good = await callbackGet(new Request("https://app.example.test/auth/callback?code=c1&next=/onboarding", { headers: { "x-forwarded-for": "9.9.9.1" } }));
  assert.equal(good.status, 307);
  assert.equal(good.headers.get("location"), "https://app.example.test/onboarding");
  assert.deepEqual(service.calls.map((c) => `${c.table}.${c.op}`), ["profiles.select", "profiles.insert"], "a profile row and no membership, org or settings write");
  const evil = await callbackGet(new Request("https://app.example.test/auth/callback?code=c1&next=//evil.test", { headers: { "x-forwarded-for": "9.9.9.2" } }));
  assert.equal(evil.headers.get("location"), "https://app.example.test/");
  scripted.user = () => exchanging({ message: "bad code" });
  const bad = await callbackGet(new Request("https://app.example.test/auth/callback?code=c1", { headers: { "x-forwarded-for": "9.9.9.3" } }));
  assert.equal(bad.headers.get("location"), "https://app.example.test/login?error=auth_failed");
  const none = await callbackGet(new Request("https://app.example.test/auth/callback", { headers: { "x-forwarded-for": "9.9.9.4" } }));
  assert.equal(none.headers.get("location"), "https://app.example.test/login?error=auth_failed");
});

test("identity limiter: anonymous requests are never limited and touch no table; a session is limited per user, not per address", async () => {
  script(world());
  const anonCalls: Call[][] = [];
  scripted.user = (request) => {
    const made = userDbFor(personaOf(request));
    if (personaOf(request) === "anon") anonCalls.push(made.calls);
    return made.db;
  };
  const ip = { "x-forwarded-for": "203.0.113.9" };
  const get = (persona: Persona) => identityGet(as(persona, "/api/auth/identity", { headers: ip }), undefined);
  for (let i = 0; i < 100; i += 1) assert.equal((await get("anon")).status, 200, `anonymous request ${i + 1}`);
  assert.equal(anonCalls.flat().length, 0, "no database call for an anonymous request");
  let last = 200;
  for (let i = 0; i < 61; i += 1) last = (await get("viewer")).status;
  assert.equal(last, 429, "the 61st request of one user in the window is limited");
  const limited = await get("viewer");
  assert.ok(Number(limited.headers.get("Retry-After")) >= 1);
  assert.equal((await get("member")).status, 200, "another user behind the same address has an independent window");
  assert.equal((await get("anon")).status, 200, "and anonymous requests from that address still pass");
});
