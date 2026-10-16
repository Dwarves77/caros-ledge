import assert from "node:assert/strict";
import { test } from "node:test";

import { isIsoDate } from "@/core/shared/dates";
import { wireWorkspaceDeps } from "@/features/workspace/api/deps";
import { DELETE, GET, parseAssignInput, PATCH, POST } from "@/features/workspace/api/assignments";

import type { MemDb } from "./_memdb.ts";
import { call, E, ITEM_1, matrix, ORG_A, ORG_B, script as baseScript, seed, TEAMMATE, USER } from "./_world.ts";

const P = { id: "o3" };
const URL_ = "/api/workspace/items/o3/assignments";
// IMP-025: a notice is a notification_outbox row (the drain sends it); the writers never call a sender.
let current: MemDb | null = null;
const script = (db: MemDb): MemDb => (current = baseScript(db));
const sent = () => (current?.rows("notification_outbox") ?? []).map((r) => ({ userId: r.user_id as string, kind: r.kind as string, payload: r.payload as Record<string, unknown> }));
const wire = () => wireWorkspaceDeps({ itemHref: (item) => `/regulations/${item.id}` });
const assigned = (db: MemDb) => db.rows("item_assignments");
const withAssignment = (db: MemDb, over: Record<string, unknown> = {}) => {
  db.rows("item_assignments").push({ id: "ffffffff-0000-4000-8000-000000000001", org_id: ORG_A, item_id: ITEM_1, assignee_user_id: TEAMMATE, assigned_by: USER.admin, due_on: null, state: "open", created_at: "2026-03-01T00:00:00Z", ...over });
  return db;
};

test("persona matrix: assignments GET, POST, PATCH, DELETE", async () => {
  wire();
  await matrix("assignments GET", async (p) => (await call(GET, p, "GET", URL_, undefined, P)).status, E(401, 200, 200, 200, 200, 200, 403));
  // Org B's owner cannot name org A's teammate: one outsider refuses the whole request.
  await matrix("assignments POST", async (p) => (await call(POST, p, "POST", URL_, { assignees: [TEAMMATE] }, P)).status, E(401, 403, 201, 201, 201, 403, 403));
  // The assignment (teammate, assigned by the admin) is org A's: the teammate, the assigner or an admin may change it.
  await matrix("assignments PATCH", async (p, db) => (withAssignment(db), (await call(PATCH, p, "PATCH", URL_, { assignee: TEAMMATE, state: "done" }, P)).status), E(401, 403, 403, 200, 200, 404, 403));
  await matrix("assignments DELETE", async (p, db) => (withAssignment(db), (await call(DELETE, p, "DELETE", `${URL_}?assignee=${TEAMMATE}`, undefined, P)).status), E(401, 403, 403, 200, 200, 404, 403));
});

test("parseAssignInput and isIsoDate validate ids, count and the due date", () => {
  assert.equal(isIsoDate("2026-02-28"), true);
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(isIsoDate("26-02-28"), false);
  assert.equal(isIsoDate(20260228), false);
  assert.ok("error" in parseAssignInput({}));
  assert.ok("error" in parseAssignInput({ assignees: [] }));
  assert.ok("error" in parseAssignInput({ assignees: ["not-a-uuid"] }));
  assert.ok("error" in parseAssignInput({ assignees: Array.from({ length: 26 }, (_, i) => `bbbbbbbb-0000-4000-8000-${String(100 + i).padStart(12, "0")}`) }));
  assert.ok("error" in parseAssignInput({ assignees: [TEAMMATE], dueOn: "2026-13-01" }));
  assert.deepEqual(parseAssignInput({ assignees: [TEAMMATE, TEAMMATE], dueOn: "2026-12-01" }), { assignees: [TEAMMATE], dueOn: "2026-12-01" });
  assert.deepEqual(parseAssignInput({ assignees: [TEAMMATE], dueOn: "" }), { assignees: [TEAMMATE], dueOn: null });
});

test("an admin assigns two members with a due date; each is notified once with a link to the item", async () => {
  wire();
  const db = script(seed());
  const res = await call(POST, "admin", "POST", URL_, { assignees: [TEAMMATE, USER.member], dueOn: "2026-12-01" }, P);
  assert.equal(res.status, 201);
  assert.equal(assigned(db).length, 2);
  assert.deepEqual([res.body.queued, res.body.queue_failed], [2, 0]);
  assert.deepEqual(sent().map((n) => n.userId).sort(), [TEAMMATE, USER.member].sort());
  assert.equal(sent()[0]?.payload.link, "/regulations/o3");
  assert.match(String(sent()[0]?.payload.body), /due 2026-12-01/);
});

test("INV-167 ATTACK viewer assignee: a viewer is not assignable, alone or in a batch; nothing is written or sent", async () => {
  wire();
  const db = script(seed());
  const alone = await call(POST, "admin", "POST", URL_, { assignees: [USER.viewer] }, P);
  assert.deepEqual([alone.status, /viewer/i.test(String(alone.body.error))], [403, true]);
  const batch = await call(POST, "admin", "POST", URL_, { assignees: [TEAMMATE, USER.viewer] }, P);
  assert.deepEqual([batch.status, /viewer/i.test(String(batch.body.error))], [403, true]);
  assert.equal(assigned(db).length, 0);
  assert.equal(sent().length, 0);
});

test("INV-167 ATTACK assign outside the org: an id from another org refuses the whole request, nothing is written or sent", async () => {
  wire();
  const db = script(seed());
  const res = await call(POST, "admin", "POST", URL_, { assignees: [TEAMMATE, USER.otherOrgMember] }, P);
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /member of your workspace/);
  assert.equal(assigned(db).length, 0);
  assert.equal(sent().length, 0);
});

test("INV-167: an unverifiable roster fails closed with a 503 and nothing is written", async () => {
  wire();
  const db = script(seed());
  db.fail("org_memberships", "select", { message: "roster down" }, { when: (f) => !f.some(([, c]) => c === "user_id") });
  const res = await call(POST, "admin", "POST", URL_, { assignees: [TEAMMATE] }, P);
  assert.equal(res.status, 503);
  assert.equal(assigned(db).length, 0);
});

test("the picker roster lists only members who can be assigned (no viewers) and carries names and per-row can_change", async () => {
  wire();
  const db = script(withAssignment(seed()));
  const res = await call(GET, "admin", "GET", URL_, undefined, P);
  const members = res.body.members as { user_id: string }[];
  assert.ok(members.length >= 4);
  assert.ok(!members.some((m) => m.user_id === USER.viewer));
  assert.ok(!members.some((m) => m.user_id === USER.otherOrgMember));
  const row = (res.body.assignments as Record<string, unknown>[])[0] as Record<string, unknown>;
  assert.deepEqual([row.assignee_name, row.assigned_by_name, row.can_change], ["Name teammate", "Name admin", true]);
  void db;
});

test("assigning yourself notifies nobody; assigning someone already assigned reports it and does not duplicate or re-notify", async () => {
  wire();
  const db = script(seed());
  await call(POST, "member", "POST", URL_, { assignees: [USER.member] }, P);
  assert.equal(sent().length, 0);
  assert.equal(assigned(db).length, 1);
  const first = await call(POST, "admin", "POST", URL_, { assignees: [TEAMMATE] }, P);
  assert.equal(first.body.queued, 1);
  const again = await call(POST, "owner", "POST", URL_, { assignees: [TEAMMATE] }, P);
  assert.deepEqual([again.body.already_assigned, again.body.queued, (again.body.assignments as unknown[]).length], [[TEAMMATE], 0, 0]);
  assert.equal(assigned(db).length, 2);
});

test("IMP-025: a notice that cannot be queued never undoes the assignment and is reported, not counted as sent", async () => {
  wire();
  const db = script(seed());
  db.fail("notification_outbox", "insert", { message: "outbox down" }, { times: 1 });
  const failed = await call(POST, "admin", "POST", URL_, { assignees: [TEAMMATE] }, P);
  assert.equal(failed.status, 201);
  assert.deepEqual([failed.body.queued, failed.body.queue_failed, failed.body.queue_error], [0, 1, "outbox down"]);
  assert.equal(assigned(db).length, 1);
  assert.equal(sent().length, 0);
  const queued = await call(POST, "admin", "POST", URL_, { assignees: [USER.owner] }, P);
  assert.deepEqual([queued.status, queued.body.queued, queued.body.queue_failed], [201, 1, 0]);
  assert.deepEqual(sent().map((n) => [n.userId, n.kind]), [[USER.owner, "assignment"]]);
});

test("invalid assign input writes nothing", async () => {
  wire();
  const db = script(seed());
  for (const body of [{}, { assignees: [] }, { assignees: ["x"] }, { assignees: [TEAMMATE], dueOn: "2026-02-30" }]) {
    assert.equal((await call(POST, "admin", "POST", URL_, body, P)).status, 400);
  }
  assert.equal(assigned(db).length, 0);
});

test("INV-166 ATTACK: a body naming assigned_by, org_id or item_id never changes what is stamped", async () => {
  wire();
  const db = script(seed());
  const res = await call(POST, "admin", "POST", URL_, { assignees: [TEAMMATE], assigned_by: USER.owner, org_id: ORG_B, item_id: "aaaaaaaa-0000-4000-8000-000000000002", state: "done" }, P);
  assert.equal(res.status, 201);
  const row = assigned(db)[0] as Record<string, unknown>;
  assert.deepEqual([row.assigned_by, row.org_id, row.item_id], [USER.admin, ORG_A, ITEM_1]);
  assert.notEqual(row.state, "done");
});

test("state toggle: the assignee, the assigner and an admin may; a bystander member may not; a bad state is a 400", async () => {
  wire();
  const db = script(withAssignment(seed(), { assignee_user_id: USER.member, assigned_by: USER.owner }));
  assert.equal((await call(PATCH, "member", "PATCH", URL_, { assignee: USER.member, state: "done" }, P)).status, 200);
  assert.equal(assigned(db)[0]?.state, "done");
  assert.equal((await call(PATCH, "owner", "PATCH", URL_, { assignee: USER.member, state: "open" }, P)).status, 200);
  assert.equal((await call(PATCH, "admin", "PATCH", URL_, { assignee: USER.member, state: "done" }, P)).status, 200);
  assert.equal((await call(PATCH, "admin", "PATCH", URL_, { assignee: USER.member, state: "paused" }, P)).status, 400);
  assert.equal((await call(PATCH, "admin", "PATCH", URL_, { assignee: "x", state: "done" }, P)).status, 400);
  db.rows("item_assignments")[0]!.assignee_user_id = TEAMMATE;
  db.rows("item_assignments")[0]!.assigned_by = USER.owner;
  assert.equal((await call(PATCH, "member", "PATCH", URL_, { assignee: TEAMMATE, state: "done" }, P)).status, 403);
});

test("ATTACK cross-org: org B sees none of org A's assignments and cannot change or remove one", async () => {
  wire();
  const db = script(withAssignment(seed()));
  const list = await call(GET, "otherOrgMember", "GET", URL_, undefined, P);
  assert.deepEqual(list.body.assignments, []);
  assert.ok(!(list.body.members as { user_id: string }[]).some((m) => m.user_id === TEAMMATE));
  assert.equal((await call(PATCH, "otherOrgMember", "PATCH", URL_, { assignee: TEAMMATE, state: "done" }, P)).status, 404);
  assert.equal((await call(DELETE, "otherOrgMember", "DELETE", `${URL_}?assignee=${TEAMMATE}`, undefined, P)).status, 404);
  assert.equal(assigned(db).length, 1);
  assert.equal(assigned(db)[0]?.state, "open");
});

test("remove: the assigner and the assignee may, a bystander may not; the list then drops it", async () => {
  wire();
  const db = script(withAssignment(seed(), { assignee_user_id: USER.member, assigned_by: USER.owner }));
  assert.equal((await call(DELETE, "viewer", "DELETE", `${URL_}?assignee=${USER.member}`, undefined, P)).status, 403);
  db.rows("item_assignments")[0]!.assignee_user_id = TEAMMATE;
  assert.equal((await call(DELETE, "member", "DELETE", `${URL_}?assignee=${TEAMMATE}`, undefined, P)).status, 403);
  assert.equal((await call(DELETE, "owner", "DELETE", `${URL_}?assignee=${TEAMMATE}`, undefined, P)).status, 200);
  assert.deepEqual((await call(GET, "owner", "GET", URL_, undefined, P)).body.assignments, []);
  assert.equal((await call(DELETE, "owner", "DELETE", `${URL_}?assignee=${TEAMMATE}`, undefined, P)).status, 404);
});
