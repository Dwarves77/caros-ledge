import assert from "node:assert/strict";
import { test } from "node:test";

import { accept, decline } from "@/features/auth/api/invitations-mine";
import { POST as orgsPost } from "@/features/auth/api/orgs-create";

import { fakeDb } from "../_support/fake-db.ts";
import { as, ctx, json, ORG_A, PERSONAS, script, type Persona } from "../_support/personas.ts";

const ID = "77777777-7777-4777-8777-777777777777";
const call = async (handler: (r: Request, c: never) => Promise<Response>, persona: Persona, url: string, init: RequestInit, params: Record<string, string> = {}) => {
  const res = await handler(as(persona, url, init), ctx(params) as never);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

// The persona matrix. The route does not decide WHO may act (the rpc matches the caller's auth e-mail to the invitation, proven by attack in migration 0028);
// it refuses a visitor with no session, a malformed id, and maps the rpc's refusals through the one map.
test("persona matrix: in-app Accept and Decline act on the invitation id; only a signed-in caller reaches the rpc", async () => {
  const rpcs: { name: string; args: unknown }[] = [];
  script(fakeDb(), undefined, (name, args) => {
    rpcs.push({ name, args });
    return name === "accept_invitation_by_id" ? { data: ORG_A } : {};
  });
  for (const persona of PERSONAS) {
    const want = persona === "anon" ? 401 : 200;
    assert.equal((await call(accept, persona, `/api/invitations/mine/${ID}/accept`, { method: "POST" }, { id: ID })).status, want, `accept as ${persona}`);
    assert.equal((await call(decline, persona, `/api/invitations/mine/${ID}/decline`, { method: "POST" }, { id: ID })).status, want, `decline as ${persona}`);
  }
  assert.deepEqual(rpcs.filter((r) => r.name === "accept_invitation_by_id")[0]?.args, { p_invitation_id: ID });
  assert.deepEqual(rpcs.filter((r) => r.name === "decline_invitation_by_id")[0]?.args, { p_invitation_id: ID });
  assert.equal(rpcs.filter((r) => r.name === "accept_invitation" || r.name === "decline_invitation").length, 0, "the by-id route never touches the token rpc");
  assert.equal((await call(accept, "member", "/x", { method: "POST" }, { id: "not-a-uuid" })).status, 400);
  assert.equal(rpcs.length, (PERSONAS.length - 1) * 2, "a malformed id reached no rpc: accept and decline for every persona but anon");
});

test("the rpc's refusals map through the one table: a different e-mail or a ban is 403, an unknown invitation 404, an answered or expired one 409", async () => {
  for (const [code, status] of [["42501", 403], ["P0002", 404], ["22023", 409], ["XX000", 500]] as const) {
    script(fakeDb(), undefined, () => ({ error: { message: "raw database words", code } }));
    const a = await call(accept, "member", "/x", { method: "POST" }, { id: ID });
    const d = await call(decline, "member", "/x", { method: "POST" }, { id: ID });
    assert.deepEqual([a.status, d.status], [status, status], code);
    if (status === 403 || status === 404) assert.doesNotMatch(String(a.body.error), /raw database words/, "a forbidden or not-found answer is the route's own sentence, not the database's");
  }
});

test("organisation create: a sector, region or size outside the workspace vocabulary is a 400 and nothing is created; a known one is a 201", async () => {
  const rpcs: string[] = [];
  script(fakeDb(), undefined, (name) => {
    rpcs.push(name);
    return name === "create_org_for_self" ? { data: ORG_A } : undefined;
  });
  const post = (body: unknown) => call(orgsPost, "member", "/api/orgs", { method: "POST", body: json(body) });
  assert.equal((await post({ name: "Acme", sectors: ["not-a-sector"] })).status, 400);
  assert.equal((await post({ name: "Acme", regions: ["MARS"] })).status, 400);
  assert.equal((await post({ name: "Acme", headcount_band: "huge" })).status, 400);
  assert.equal(rpcs.length, 0, "a refused body creates nothing");
  assert.equal((await post({ name: "Acme", sectors: ["fine-art", "pharma"], regions: ["EU"], headcount_band: "small" })).status, 201);
  assert.equal(rpcs[0], "create_org_for_self");
});
