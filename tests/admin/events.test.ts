// R2e M2: the admin console shows the admin_events record. The log is the table's rows newest first, an actor is a display name never an address, a deleted account reads as one, and a failed read is a stated failure, never an empty log.
import assert from "node:assert/strict";
import { test } from "node:test";

import { GET } from "@/features/admin/api/runtime";

import { fakeDb, type Call, type Reply } from "../_support/fake-db.ts";
import { as, ctx, script } from "../_support/personas.ts";

const ACTOR = "55555555-5555-4555-8555-555555555555";
const ORG = "66666666-6666-4666-8666-666666666666";
const EVENTS = [
  { id: "e2", created_at: "2026-10-02T00:00:00Z", actor_id: ACTOR, org_id: ORG, action: "set_member_role", target_kind: "membership", target_id: "m1", reason: "promoted for the audit" },
  { id: "e1", created_at: "2026-10-01T00:00:00Z", actor_id: null, org_id: null, action: "account_deleted", target_kind: "account", target_id: "self", reason: null },
];

function run(persona: "anon" | "member" | "platformAdmin", handler: (c: Call) => Reply | undefined) {
  const service = script(fakeDb(handler));
  return GET(as(persona, "/api/admin/runtime?view=events"), ctx({}) as never).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown>, calls: service.calls }));
}
const world = (c: Call): Reply | undefined =>
  c.table === "admin_events" ? { data: EVENTS } : c.table === "profiles" ? { data: [{ id: ACTOR, full_name: "Olga Owner", display_name: null, email: "olga@example.test" }] } : c.table === "organizations" ? { data: [{ id: ORG, name: "Acme Freight" }] } : undefined;

test("the event log: platform admins only, newest first as the table gives them, names not addresses, a deleted account as such", async () => {
  assert.equal((await run("anon", world)).status, 401);
  assert.equal((await run("member", world)).status, 403);
  const ok = await run("platformAdmin", world);
  assert.equal(ok.status, 200);
  const events = ok.body.events as Record<string, unknown>[];
  assert.deepEqual(events.map((e) => e.id), ["e2", "e1"]);
  assert.equal(events[0]?.actor, "Olga Owner");
  assert.equal(events[0]?.org, "Acme Freight");
  assert.equal(events[0]?.reason, "promoted for the audit");
  assert.equal(events[1]?.actor, "a deleted account");
  assert.doesNotMatch(JSON.stringify(ok.body), /example\.test/, "no e-mail address reaches the log");
  const read = ok.calls.find((c) => c.table === "admin_events");
  assert.ok(read && read.op === "select", "the log is read from admin_events");
  assert.equal(ok.calls.filter((c) => c.table === "admin_events" && c.op !== "select").length, 0, "the console only reads the record");
});

test("a failed read of the log is a stated failure, never an empty list", async () => {
  const res = await run("platformAdmin", (c) => (c.table === "admin_events" ? { error: { message: "connection reset", code: "08006" } } : world(c)));
  assert.equal(res.status, 503);
  assert.equal("events" in res.body, false);
});
