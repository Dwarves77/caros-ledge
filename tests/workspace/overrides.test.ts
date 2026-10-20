import assert from "node:assert/strict";
import { test } from "node:test";

import { GET as impactGet } from "@/features/workspace/api/archive-impact";
import { wireWorkspaceDeps } from "@/features/workspace/api/deps";
import { DELETE as overridesDelete, POST as overridesPost } from "@/features/workspace/api/overrides";
import { DELETE as personalDelete, GET as personalGet, POST as personalPost } from "@/features/workspace/api/personal-state";

import type { MemDb, Row } from "./_memdb.ts";
import { call, clientFor, E, ITEM_1, matrix, ORG_A, ORG_B, script as baseScript, seed, TEAMMATE, USER } from "./_world.ts";

const O = "/api/workspace/overrides";
// IMP-025: a notice is a notification_outbox row (the drain sends it); the writers never call a sender.
let current: MemDb | null = null;
const script = (db: MemDb): MemDb => (current = baseScript(db));
const sent = () => (current?.rows("notification_outbox") ?? []).map((r) => ({ userId: r.user_id as string, kind: r.kind as string, payload: r.payload as Record<string, unknown> }));
const wire = () => wireWorkspaceDeps({ revalidateWorkspaceData: () => undefined });
const overrides = (db: MemDb) => db.rows("workspace_item_overrides");
const archive = { itemId: "o3", isArchived: true, archiveReason: "superseded by the 2027 text" };
const withOverride = (db: MemDb, over: Row = {}) => (db.rows("workspace_item_overrides").push({ org_id: ORG_A, item_id: ITEM_1, ...over }), db);

test("persona matrix: overrides POST (priority), POST (team archive), DELETE", async () => {
  wire();
  await matrix("overrides POST priority", async (p) => (await call(overridesPost, p, "POST", O, { itemId: "o3", priorityOverride: "HIGH" })).status, E(401, 403, 200, 200, 200, 200, 403));
  // INV-165: only an owner or admin archives for the team; org B's owner archives inside org B.
  await matrix("overrides POST team archive", async (p) => (await call(overridesPost, p, "POST", O, archive)).status, E(401, 403, 403, 200, 200, 200, 403));
  await matrix("overrides DELETE", async (p, db) => (withOverride(db), (await call(overridesDelete, p, "DELETE", O, { itemId: "o3" })).status), E(401, 403, 200, 200, 200, 200, 403));
});

test("INV-165: a member's team archive is refused and nothing is written; a missing or blank reason is a 400", async () => {
  wire();
  const db = script(seed());
  const refused = await call(overridesPost, "member", "POST", O, archive);
  assert.equal(refused.status, 403);
  assert.match(String(refused.body.error), /archive it just for yourself/, "the route states the rule in its own words before the writer is reached");
  assert.equal(db.writes("workspace_item_overrides").length, 0);
  assert.equal((await call(overridesPost, "admin", "POST", O, { itemId: "o3", isArchived: true })).status, 400);
  assert.equal((await call(overridesPost, "admin", "POST", O, { itemId: "o3", isArchived: true, archiveReason: "   " })).status, 400);
  assert.equal(db.writes("workspace_item_overrides").length, 0);
  assert.equal(sent().length, 0);
});

test("INV-165: an admin's team archive is stamped, dated and fans out to this org's watchers and owner only, never the archiver, never another org", async () => {
  wire();
  const db = script(seed());
  db.rows("user_watchlist").push({ id: "w3", user_id: USER.admin, item_id: ITEM_1 });
  withOverride(db, { owner_user_id: TEAMMATE });
  const res = await call(overridesPost, "admin", "POST", O, archive);
  assert.equal(res.status, 200);
  const row = overrides(db)[0] as Row;
  assert.deepEqual([row.is_archived, row.archived_by, row.archive_reason, typeof row.archived_at], [true, USER.admin, archive.archiveReason, "string"]);
  assert.deepEqual(sent().map((n) => n.userId).sort(), [TEAMMATE, USER.member].sort());
  assert.ok(!sent().some((n) => n.userId === USER.otherOrgMember), "a watcher in another org must not be told");
  assert.ok(!sent().some((n) => n.userId === USER.admin), "the archiver is not told");
  assert.match(String(sent()[0]?.payload.body), /superseded by the 2027 text/);
  assert.equal(res.body.queued, 2);
});

test("IMP-065: a notice that cannot be queued rolls the archive back (one transaction): an error status, no override row, no half-queued notice", async () => {
  wire();
  const db = script(seed());
  db.fail("notification_outbox", "insert", { message: "outbox down" }, { times: 1 });
  const failed = await call(overridesPost, "admin", "POST", O, archive);
  assert.equal(failed.status, 500);
  assert.equal(overrides(db).length, 0, "the override must not survive its failed notice");
  assert.equal(sent().length, 0);
  assert.equal(db.writes("workspace_item_overrides").length, 0);
  const again = await call(overridesPost, "admin", "POST", O, archive);
  assert.equal(again.status, 200);
  assert.deepEqual([overrides(db)[0]?.is_archived, sent().length], [true, 1]);
});

test("IMP-065 degraded: the writer absent (production before the cutover) is a 503 with Retry-After, and the write is not attempted a second way", async () => {
  wire();
  const db = script(seed());
  delete db.rpcs.archive_item_for_team;
  delete db.rpcs.assign_item;
  for (const input of [archive, { itemId: "o3", ownerUserId: TEAMMATE }]) {
    const res = await call(overridesPost, "admin", "POST", O, input);
    assert.deepEqual([res.status, res.headers.get("retry-after")], [503, "30"]);
  }
  assert.equal(db.writes("workspace_item_overrides").length, 0);
  assert.equal((await call(overridesPost, "admin", "POST", O, { itemId: "o3", priorityOverride: "LOW" })).status, 200, "a plain upsert needs no writer");
});

test("INV-165, INV-166 at the writer: the rpc itself refuses a member, a viewer, a stranger and a blank reason with nothing written, and stamps the actor from the session whatever it is told", async () => {
  wire();
  const db = script(seed());
  const rpc = (who: "member" | "viewer" | "otherOrgMember" | "admin", args: Record<string, unknown>) => (clientFor(db, who) as unknown as { rpc(n: string, a: unknown): Promise<{ data: unknown; error: { code?: string } | null }> }).rpc("archive_item_for_team", { p_org_id: ORG_A, p_item_id: ITEM_1, p_reason: "r", p_note: null, p_notice: { title: "t" }, ...args });
  for (const who of ["member", "viewer", "otherOrgMember"] as const) assert.equal((await rpc(who, {})).error?.code, "42501", who);
  assert.equal((await rpc("admin", { p_reason: "  " })).error?.code, "22023");
  assert.equal(db.writes("workspace_item_overrides").length, 0);
  assert.equal((await rpc("admin", { p_archived_by: USER.owner })).error, null);
  assert.equal(overrides(db)[0]?.archived_by, USER.admin);
});

test("restore is ungated: a member un-archives a team archive and archived_by is cleared", async () => {
  wire();
  const db = script(withOverride(seed(), { is_archived: true, archived_by: USER.admin, archive_reason: "x", archived_at: "2026-01-01T00:00:00Z" }));
  const res = await call(overridesPost, "member", "POST", O, { itemId: "o3", isArchived: false, archiveReason: null, archiveNote: null });
  assert.equal(res.status, 200);
  const row = overrides(db)[0] as Row;
  assert.deepEqual([row.is_archived, row.archived_by, row.archived_at, row.archive_reason], [false, null, null, null]);
});

test("INV-166 ATTACK: a body naming archived_by, owner_assigned_by, org_id or item_id never changes what is stamped", async () => {
  wire();
  const db = script(seed());
  const res = await call(overridesPost, "admin", "POST", O, { ...archive, ownerUserId: TEAMMATE, archived_by: USER.owner, owner_assigned_by: USER.owner, org_id: ORG_B, item_id: "aaaaaaaa-0000-4000-8000-000000000002" });
  assert.equal(res.status, 200);
  assert.equal(overrides(db).length, 1);
  const row = overrides(db)[0] as Row;
  assert.deepEqual([row.org_id, row.item_id, row.archived_by, row.owner_assigned_by], [ORG_A, ITEM_1, USER.admin, USER.admin]);
});

test("INV-167: an owner outside the org or a viewer is refused with nothing written; an unverifiable lookup fails closed; null clears", async () => {
  wire();
  const db = script(seed());
  const ownerLookup = ({ filters: f }: { filters: [string, string, unknown][] }) => f.some(([, c]) => c === "user_id") && f.some(([, c]) => c === "org_id");
  assert.equal((await call(overridesPost, "member", "POST", O, { itemId: "o3", ownerUserId: USER.otherOrgMember })).status, 403);
  assert.equal((await call(overridesPost, "member", "POST", O, { itemId: "o3", ownerUserId: USER.viewer })).status, 403);
  assert.equal((await call(overridesPost, "member", "POST", O, { itemId: "o3", ownerUserId: "not-a-uuid" })).status, 400);
  db.fail("org_memberships", "select", { message: "down" }, { when: ownerLookup });
  assert.equal((await call(overridesPost, "member", "POST", O, { itemId: "o3", ownerUserId: TEAMMATE })).status, 503);
  assert.equal(db.writes("workspace_item_overrides").length, 0);
  db.failures.length = 0;
  assert.equal((await call(overridesPost, "member", "POST", O, { itemId: "o3", ownerUserId: TEAMMATE })).status, 200);
  assert.deepEqual([overrides(db)[0]?.owner_user_id, overrides(db)[0]?.owner_assigned_by], [TEAMMATE, USER.member]);
  assert.deepEqual(sent().map((n) => [n.userId, n.kind]), [[TEAMMATE, "assignment"]], "the new owner is told, in the same transaction as the assignment");
  assert.equal((await call(overridesPost, "member", "POST", O, { itemId: "o3", ownerUserId: null })).status, 200);
  assert.deepEqual([overrides(db)[0]?.owner_user_id, overrides(db)[0]?.owner_assigned_by, overrides(db)[0]?.owner_assigned_at], [null, null, null]);
});

test("dismissal and priority: dismiss stamps dismissed_at, restore clears it; notes are refused; bad input and unknown items are refused", async () => {
  wire();
  const db = script(seed());
  await call(overridesPost, "member", "POST", O, { itemId: "o3", dismiss: true, priorityOverride: null });
  assert.ok(overrides(db)[0]?.dismissed_at);
  await call(overridesPost, "member", "POST", O, { itemId: "o3", dismissedAt: null });
  assert.equal(overrides(db)[0]?.dismissed_at, null);
  assert.equal((await call(overridesPost, "member", "POST", O, { itemId: "o3", notes: "moved" })).status, 400);
  assert.equal((await call(overridesPost, "member", "POST", O, {})).status, 400);
  assert.equal((await call(overridesPost, "member", "POST", O, { itemId: "nope" })).status, 404);
  assert.equal(overrides(db).length, 1);
});

test("a failed item read is a 503, never a 404; a failed upsert is an error status, never a success", async () => {
  wire();
  const db = script(seed());
  db.fail("intelligence_items", "select", { message: "down" });
  assert.equal((await call(overridesPost, "member", "POST", O, { itemId: "o3", priorityOverride: "LOW" })).status, 503);
  db.failures.length = 0;
  db.fail("workspace_item_overrides", "upsert", { message: "write refused", code: "42501" });
  assert.equal((await call(overridesPost, "member", "POST", O, { itemId: "o3", priorityOverride: "LOW" })).status, 403);
});

// ── personal state ───────────────────────────────────────────────────────────────────────────────────

const P = "/api/workspace/personal-state";

test("persona matrix: personal-state GET, POST, DELETE (a personal archive is ungated: every signed-in user, any role)", async () => {
  wire();
  await matrix("personal GET", async (p) => (await call(personalGet, p, "GET", P)).status, E(401, 200, 200, 200, 200, 200, 200));
  await matrix("personal POST", async (p) => (await call(personalPost, p, "POST", P, { itemId: "o3", isArchived: true, archiveNote: "not mine" })).status, E(401, 200, 200, 200, 200, 200, 200));
  await matrix("personal DELETE", async (p) => (await call(personalDelete, p, "DELETE", P, { itemId: "o3" })).status, E(401, 200, 200, 200, 200, 200, 200));
});

test("INV-165: a personal archive hides for that user alone, notifies nobody and writes no team override", async () => {
  wire();
  const db = script(seed());
  await call(personalPost, "viewer", "POST", P, { itemId: "o3", isArchived: true, archiveNote: "noise" });
  assert.equal(sent().length, 0);
  assert.equal(db.writes("workspace_item_overrides").length, 0);
  assert.deepEqual(db.rows("user_item_state").map((r) => [r.user_id, r.is_archived, r.archive_note]), [[USER.viewer, true, "noise"]]);
  assert.deepEqual((await call(personalGet, "member", "GET", P)).body.items, []);
  const mine = (await call(personalGet, "viewer", "GET", P)).body.items as Record<string, unknown>[];
  assert.deepEqual([mine.length, mine[0]?.legacyId, mine[0]?.title, mine[0]?.archiveNote], [1, "o3", "FuelEU Maritime", "noise"]);
});

test("INV-166 ATTACK: a body naming user_id or org_id writes the session user's own row, in the session user's own org", async () => {
  wire();
  const db = script(seed());
  const res = await call(personalPost, "member", "POST", P, { itemId: "o3", isArchived: true, user_id: USER.owner, org_id: ORG_B, archived_at: "1999-01-01" });
  assert.equal(res.status, 200);
  const row = db.rows("user_item_state")[0] as Row;
  assert.deepEqual([db.rows("user_item_state").length, row.user_id, row.org_id], [1, USER.member, ORG_A]);
  assert.notEqual(row.archived_at, "1999-01-01");
  // Deleting names an item, never a user: another user's row stays.
  db.rows("user_item_state").push({ id: "z", user_id: USER.owner, org_id: ORG_A, item_id: ITEM_1, is_archived: true });
  await call(personalDelete, "member", "DELETE", P, { itemId: "o3", user_id: USER.owner });
  assert.deepEqual(db.rows("user_item_state").map((r) => r.user_id), [USER.owner]);
});

test("restore clears the note; a re-archive without a note keeps the stored one; an unresolved org never blocks the write", async () => {
  wire();
  const db = script(seed());
  await call(personalPost, "member", "POST", P, { itemId: "o3", isArchived: true, archiveNote: "keep me" });
  await call(personalPost, "member", "POST", P, { itemId: "o3", isArchived: true });
  assert.equal(db.rows("user_item_state")[0]?.archive_note, "keep me");
  await call(personalPost, "member", "POST", P, { itemId: "o3", isArchived: false });
  assert.deepEqual([db.rows("user_item_state")[0]?.is_archived, db.rows("user_item_state")[0]?.archive_note, db.rows("user_item_state")[0]?.archived_at], [false, null, null]);
  db.rows("user_item_state").length = 0;
  db.fail("org_memberships", "select");
  const res = await call(personalPost, "member", "POST", P, { itemId: "o3", isArchived: true });
  assert.equal(res.status, 200);
  assert.equal(db.rows("user_item_state")[0]?.org_id, null);
});

test("a failed personal-state read is a 503, never an empty list; bad input is a 400; an unknown item is a 404", async () => {
  wire();
  const db = script(seed());
  db.fail("user_item_state", "select", { message: "down" });
  const res = await call(personalGet, "member", "GET", P);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "1");
  db.failures.length = 0;
  assert.equal((await call(personalPost, "member", "POST", P, { itemId: "o3" })).status, 400);
  assert.equal((await call(personalPost, "member", "POST", P, { isArchived: true })).status, 400);
  assert.equal((await call(personalPost, "member", "POST", P, { itemId: "nope", isArchived: true })).status, 404);
});

// ── archive impact ───────────────────────────────────────────────────────────────────────────────────

const I = "/api/workspace/archive-impact?itemId=o3";

test("persona matrix: archive-impact GET", async () => {
  await matrix("impact GET", async (p) => (await call(impactGet, p, "GET", I)).status, E(401, 200, 200, 200, 200, 200, 200));
});

test("archive-impact tells the truth: role, watchers by name excluding the caller, owner, CRITICAL from the override, already archived", async () => {
  const db = script(seed());
  db.rows("user_watchlist").push({ id: "w3", user_id: USER.admin, item_id: ITEM_1 });
  withOverride(db, { owner_user_id: TEAMMATE, is_archived: true, priority_override: "CRITICAL" });
  const admin = await call(impactGet, "admin", "GET", I);
  assert.deepEqual(
    [admin.body.role, admin.body.canArchiveWorkspace, admin.body.watcherCount, admin.body.watcherNames, admin.body.ownerName, admin.body.isCritical, admin.body.alreadyWorkspaceArchived, admin.body.alreadyPersonallyArchived, admin.body.onTeamWatchlist],
    ["admin", true, 1, ["Name member"], "Name teammate", true, true, false, false],
  );
  const member = await call(impactGet, "member", "GET", I);
  assert.deepEqual([member.body.role, member.body.canArchiveWorkspace, member.body.watcherCount], ["member", false, 1]);
  assert.equal((await call(impactGet, "viewer", "GET", I)).body.canArchiveWorkspace, false);
});

test("INV-149 ATTACK: another org's watchers are neither counted nor named, and another org's team watchlist is not this org's", async () => {
  const db = script(seed());
  db.rows("org_watchlist").push({ id: "t1", org_id: ORG_B, item_id: "o3" });
  const res = await call(impactGet, "admin", "GET", I);
  assert.equal(res.body.watcherCount, 1);
  assert.ok(!JSON.stringify(res.body).includes("otherOrgMember"));
  assert.equal(res.body.onTeamWatchlist, false);
  db.rows("org_watchlist").push({ id: "t2", org_id: ORG_A, item_id: "o3" });
  assert.equal((await call(impactGet, "admin", "GET", I)).body.onTeamWatchlist, true);
});

test("B-0084: the org is resolved before the item is read, on archive-impact", async () => {
  const db = script(seed());
  await call(impactGet, "admin", "GET", I);
  const order = db.log.filter((l) => l.op === "select").map((l) => l.table);
  assert.ok(order.indexOf("org_memberships") >= 0 && order.indexOf("org_memberships") < order.indexOf("intelligence_items"), order.join(","));
});

test("archive-impact: a missing itemId is a 400, an unknown item a 404, and a failed read a 503 (B-0043)", async () => {
  const db = script(seed());
  assert.equal((await call(impactGet, "admin", "GET", "/api/workspace/archive-impact")).status, 400);
  assert.equal((await call(impactGet, "admin", "GET", "/api/workspace/archive-impact?itemId=nope")).status, 404);
  db.fail("intelligence_items", "select");
  assert.equal((await call(impactGet, "admin", "GET", I)).status, 503);
  db.failures.length = 0;
  db.fail("org_memberships", "select", { message: "down" });
  assert.equal((await call(impactGet, "admin", "GET", I)).status, 503);
});
