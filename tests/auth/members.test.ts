// R2e M1: membership and authority through the routes. The rules themselves (who may, the last owner, the audit row in the same transaction) are proven by the attacks in migrations 0100 and 0101 on the real database; this file
// proves what the ROUTES do: they decide nothing about roles, they call the one database function on the caller's own client, they map its refusals through the one table, and the invitation answers identically for every address.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DELETE, GET, PATCH, POST, PUT } from "@/features/auth/api/members";

import { fakeDb, type Reply } from "../_support/fake-db.ts";
import { as, ctx, json, MEMBERSHIP_ID, ORG_A, PERSONAS, script, type Persona } from "../_support/personas.ts";

const params = { org_id: ORG_A };
const URL_M = `/api/orgs/${ORG_A}/members`;
const ROSTER = [
  { id: "m1", user_id: "u-owner", role: "owner", joined_at: "2026-01-01", display_name: "Olga Owner", avatar_url: null, email: "olga@example.test" },
  { id: "m2", user_id: "u-member", role: "member", joined_at: "2026-01-02", display_name: null, avatar_url: null, email: null },
];

/** The caller's client answers rpcs by name; the service client is a recorder that must stay untouched. */
function world(rpc: (name: string, args: Record<string, unknown>, persona: Persona) => Reply | undefined) {
  let who: Persona = "anon";
  const service = fakeDb();
  script(service, undefined, (name, args) => rpc(name, args as Record<string, unknown>, who));
  const run = async (handler: (r: Request, c: never) => Promise<Response>, persona: Persona, init: RequestInit = {}, url = URL_M) => {
    who = persona;
    const res = await handler(as(persona, url, init), ctx(params) as never);
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  return { service, run };
}
const body = (r: { text: string }) => JSON.parse(r.text) as Record<string, unknown>;

test("GET: the roster is org_roster on the caller's client: an e-mail only where the database gave one, never an address for a name, the capability list from org_actions, the service client untouched", async () => {
  const { service, run } = world((name) => (name === "org_roster" ? { data: ROSTER } : name === "org_actions" ? { data: ["read_roster"] } : undefined));
  for (const persona of PERSONAS) {
    const res = await run(GET, persona);
    if (persona === "anon") assert.equal(res.status, 401);
    else if (persona === "otherOrgMember") assert.equal(res.status, 200, "the database decides who may read: the route passes the caller through");
    else assert.equal(res.status, 200, persona);
  }
  const res = body(await run(GET, "member"));
  const members = res.members as Record<string, unknown>[];
  assert.equal(members[0]?.email, "olga@example.test");
  assert.equal("email" in (members[1] ?? {}), false, "a roster row with no e-mail carries no e-mail key");
  assert.equal(members[1]?.display_name, "Member", "a member with no name is 'Member', never an address or an id");
  assert.deepEqual(res.actions, ["read_roster"]);
  assert.equal(res.caller_role, "member");
  assert.equal(service.calls.length + service.rpcs.length, 0, "SEC-3b: the service client is not used by the roster read");
});

test("GET: a refused read is 403 only when the function said not-a-member; a failed read is a 503 with a sentence, never 'no members'; an absent function is a stated 503", async () => {
  const w1 = world((name) => (name === "org_roster" ? { error: { message: "you are not a member of this organisation", code: "42501" } } : { data: [] }));
  assert.equal((await w1.run(GET, "otherOrgMember")).status, 403);
  const w2 = world((name) => (name === "org_roster" ? { error: { message: "relation public.profiles is down: password=hunter2", code: "XX000" } } : { data: [] }));
  const failed = await w2.run(GET, "member");
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("Retry-After"), "1");
  assert.doesNotMatch(failed.text, /hunter2|relation|profiles/, "the driver text stays in the log");
  const w3 = world((name) => (name === "org_roster" ? { error: { message: "function public.org_roster does not exist", code: "42883" } } : { data: [] }));
  assert.equal((await w3.run(GET, "member")).status, 503, "before the migration is applied the page says it could not be read, it does not throw");
});

test("PATCH, POST (ban) and DELETE are the three database functions, called with the session's client, the org of the URL and the operator's reason; the body names a membership, a role and a reason and nothing else", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const { service, run } = world((name, args) => {
    calls.push({ name, args });
    return { data: { id: MEMBERSHIP_ID, role: "admin" } };
  });
  const patch = await run(PATCH, "owner", { method: "PATCH", body: json({ membership_id: MEMBERSHIP_ID, role: "admin", reason: "promoted for the audit", is_platform_admin: true, org_id: "x" }) });
  assert.equal(patch.status, 200);
  assert.deepEqual(body(patch).membership, { id: MEMBERSHIP_ID, role: "admin" });
  assert.deepEqual(calls[0], { name: "set_member_role", args: { p_org_id: ORG_A, p_membership_id: MEMBERSHIP_ID, p_role: "admin", p_reason: "promoted for the audit" } });
  assert.equal((await run(POST, "owner", { method: "POST", body: json({ membership_id: MEMBERSHIP_ID, reason: "abuse" }) })).status, 200);
  assert.deepEqual(calls[1], { name: "ban_member", args: { p_org_id: ORG_A, p_membership_id: MEMBERSHIP_ID, p_reason: "abuse" } });
  assert.equal((await run(DELETE, "owner", { method: "DELETE" }, `${URL_M}?membership_id=${MEMBERSHIP_ID}`)).status, 200);
  assert.deepEqual(calls[2], { name: "remove_member", args: { p_org_id: ORG_A, p_membership_id: MEMBERSHIP_ID, p_reason: null } });
  assert.equal((await run(PATCH, "owner", { method: "PATCH", body: json({ membership_id: MEMBERSHIP_ID, role: "superuser" }) })).status, 400);
  assert.equal((await run(PATCH, "owner", { method: "PATCH", body: json({ membership_id: "nope", role: "admin" }) })).status, 400);
  assert.equal((await run(DELETE, "owner", { method: "DELETE" }, `${URL_M}?membership_id=nope`)).status, 400);
  assert.equal(calls.length, 3, "a malformed request reached no function");
  assert.equal(service.calls.length + service.rpcs.length, 0, "SEC-3b: no member change runs on the service client");
  assert.equal((await run(PATCH, "anon", { method: "PATCH", body: json({ membership_id: MEMBERSHIP_ID, role: "admin" }) })).status, 401);
});

test("the function's refusals map through the one table: not allowed 403 with its own sentence, not found 404, a rule it keeps 409 (the only owner), anything else a 503 that never carries the driver text", async () => {
  for (const [code, message, status] of [["42501", "only an owner may grant the owner role", 403], ["P0002", "membership not found in this organisation", 404], ["22023", "Cannot demote the only owner. Promote another member to owner first.", 409]] as const) {
    const { run } = world(() => ({ error: { message, code } }));
    for (const [handler, init, url] of [[PATCH, { method: "PATCH", body: json({ membership_id: MEMBERSHIP_ID, role: "member" }) }, URL_M], [POST, { method: "POST", body: json({ membership_id: MEMBERSHIP_ID }) }, URL_M], [DELETE, { method: "DELETE" }, `${URL_M}?membership_id=${MEMBERSHIP_ID}`]] as const) {
      const res = await run(handler, "owner", init, url);
      assert.equal(res.status, status, `${code} on ${init.method}`);
      assert.equal(body(res).error, message, "the function's sentence is the customer's");
    }
  }
  const odd = await world(() => ({ error: { message: 'duplicate key value violates unique constraint "org_memberships_pkey"', code: "23505" } })).run(PATCH, "owner", { method: "PATCH", body: json({ membership_id: MEMBERSHIP_ID, role: "member" }) });
  assert.equal(odd.status, 503);
  assert.doesNotMatch(odd.text, /duplicate key|org_memberships_pkey/);
});

// ── INV-R2e-1: the invitation answers the same for a registered and an unregistered address ───────────────────────────────

test("INV-R2e-1: PUT is an invitation the invitee accepts: the response is byte-identical for a registered and an unregistered address, and no account is looked up or joined", async () => {
  const invite = { id: "i1", token_last4: "beef", invited_email: "x@example.test", proposed_role: "member", expires_at: "2099-01-01", status: "pending", created_at: "2026-01-01" };
  const asked: string[] = [];
  const one = (registered: boolean) => {
    const w = world((name, args) => {
      asked.push(name);
      if (name === "profiles_by_email") return { data: registered ? [{ id: "u-registered" }] : [] };
      return name === "invite_member" ? { data: { ...invite, invited_email: (args as { p_email: string }).p_email } } : undefined;
    });
    return w;
  };
  const registered = one(true);
  const stranger = one(false);
  const a = await registered.run(PUT, "owner", { method: "PUT", body: json({ email: "registered@example.test", role: "member" }) });
  const b = await stranger.run(PUT, "owner", { method: "PUT", body: json({ email: "nobody@example.test", role: "member" }) });
  assert.equal(a.status, 202);
  assert.equal(a.status, b.status);
  assert.equal(a.text, b.text, "byte-identical bodies");
  assert.equal(a.headers.get("content-type"), b.headers.get("content-type"));
  assert.deepEqual(body(a), { status: "invited" });
  assert.deepEqual([...new Set(asked)], ["invite_member"], "the only function called is the invitation: no account lookup, no membership insert");
  for (const w of [registered, stranger]) assert.equal(w.service.calls.length + w.service.rpcs.length, 0, "the service client (the old oracle's tool) is never touched");
  // a duplicate pending invitation is the same 409 for both kinds of address; a refusal by the function is the same for both
  const dup = (registeredFlag: boolean) => world((name) => (name === "profiles_by_email" ? { data: registeredFlag ? [{ id: "u" }] : [] } : { error: { message: "dup", code: "23505" } })).run(PUT, "owner", { method: "PUT", body: json({ email: "x@example.test" }) });
  assert.deepEqual([(await dup(true)).status, (await dup(true)).text], [(await dup(false)).status, (await dup(false)).text]);
  assert.equal((await dup(true)).status, 409);
  assert.equal((await world(() => ({ error: { message: "only org admins can invite members", code: "42501" } })).run(PUT, "member", { method: "PUT", body: json({ email: "x@example.test" }) })).status, 403);
  assert.equal((await registered.run(PUT, "owner", { method: "PUT", body: json({ email: "a@b.test", role: "owner" }) })).status, 400, "an invitation never proposes the owner role");
  assert.equal((await registered.run(PUT, "owner", { method: "PUT", body: json({ email: "not-an-email" }) })).status, 400);
  assert.equal((await registered.run(PUT, "anon", { method: "PUT", body: json({ email: "a@b.test" }) })).status, 401);
});
