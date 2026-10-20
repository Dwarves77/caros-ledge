import assert from "node:assert/strict";
import { test } from "node:test";

import { GET } from "@/features/workspace/api/bootstrap";
import { wireWorkspaceDeps } from "@/features/workspace/api/deps";

import type { MemDb, Row } from "./_memdb.ts";
import { call, E, ITEM_1, matrix, ORG_A, script, seed, TEAMMATE, USER } from "./_world.ts";

const B = "/api/workspace/bootstrap";
const phases: string[] = [];
const wire = (over: Parameters<typeof wireWorkspaceDeps>[0] = {}) => {
  phases.length = 0;
  wireWorkspaceDeps({
    navCounts: async () => ({ regulations: 12 }),
    adminAttention: async (userId) => ({ forAdmin: userId }),
    timePhase: async (name, run) => (phases.push(name), run()),
    withServerTiming: (res) => (res.headers.set("Server-Timing", "bootstrap;dur=1"), res),
    ...over,
  });
};
const fill = (db: MemDb) => {
  db.rows("user_item_state").push({ id: "s1", user_id: USER.admin, item_id: ITEM_1, is_archived: true, archive_note: "later", archived_at: "2026-10-01T00:00:00Z" });
  db.rows("workspace_item_overrides").push({ org_id: ORG_A, item_id: ITEM_1, priority_override: "CRITICAL", is_archived: true, archive_reason: "dup", archive_note: null, archived_at: "2026-10-02T00:00:00Z", dismissed_at: null, owner_user_id: TEAMMATE });
  return db;
};
const get = (persona: Parameters<typeof call>[1]) => call(GET, persona, "GET", B);

test("persona matrix: bootstrap GET", async () => {
  wire();
  await matrix("bootstrap GET", async (p) => (await get(p)).status, E(401, 200, 200, 200, 200, 200, 200));
});

test("the bundle: personal state, members, overrides mapped to UI ids with owner names and the stored archive date, nav counts, no-store", async () => {
  wire();
  script(fill(seed()));
  const res = await get("admin");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("server-timing"), "bootstrap;dur=1");
  assert.deepEqual((res.body.personalState as Row[]).map((r) => [r.legacyId, r.title, r.archiveNote]), [["o3", "FuelEU Maritime", "later"]]);
  assert.deepEqual((res.body.members as Row[]).map((m) => m.role).sort(), ["admin", "member", "member", "owner", "viewer"]);
  assert.deepEqual(res.body.overrides, [{ itemId: "o3", priorityOverride: "CRITICAL", isArchived: true, archiveReason: "dup", archiveNote: null, archivedAt: "2026-10-02T00:00:00Z", dismissedAt: null, ownerUserId: TEAMMATE, ownerName: "Name teammate" }]);
  assert.deepEqual([res.body.navCounts, res.body.assistantEnabled, res.body.adminAttention, res.body.degraded], [{ regulations: 12 }, true, null, []]);
  assert.deepEqual(phases, ["auth", "personal_state", "members", "admin_attention", "overrides", "nav_counts"]);
});

test("a departed owner reads as unassigned; the Assistant is on unless the flag is exactly \"false\"", async () => {
  wire();
  const db = script(fill(seed()));
  db.rows("workspace_item_overrides")[0]!.owner_user_id = "bbbbbbbb-0000-4000-8000-0000000000aa";
  const on = await get("member");
  process.env.ASSISTANT_ENABLED = "no";
  const widened = await get("member");
  process.env.ASSISTANT_ENABLED = "false";
  const off = await get("member");
  delete process.env.ASSISTANT_ENABLED;
  assert.equal((on.body.overrides as Row[])[0]?.ownerName, null);
  assert.deepEqual([on.body.assistantEnabled, widened.body.assistantEnabled, off.body.assistantEnabled], [true, true, false]);
});

test("a platform admin gets the attention counts through the wired dependency; a non-admin gets null and it is not a degradation", async () => {
  wire();
  script(seed());
  const admin = await get("platformAdmin");
  assert.deepEqual([admin.body.adminAttention, admin.body.members, admin.body.overrides, admin.body.degraded], [{ forAdmin: USER.platformAdmin }, null, [], []]);
  assert.equal((await get("owner")).body.adminAttention, null);
});

test("each field degrades on its own: a failed read is null and named in `degraded`, never an empty list; the rest of the bundle arrives", async () => {
  wire({ navCounts: async () => Promise.reject(new Error("counts down")) });
  const db = script(fill(seed()));
  db.fail("user_item_state", "select");
  const res = await get("admin");
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.personalState, res.body.navCounts], [null, null]);
  assert.deepEqual((res.body.degraded as string[]).sort(), ["nav_counts", "personal_state"]);
  assert.equal((res.body.members as unknown[]).length, 5);
  assert.equal((res.body.overrides as unknown[]).length, 1);
});

test("an unreadable roster degrades members and overrides together, since overrides need it for owner names", async () => {
  wire();
  const db = script(fill(seed()));
  db.fail("org_memberships", "select", { message: "roster down" }, { when: (call) => !call.filters.some(([, c]) => c === "user_id") });
  const res = await get("admin");
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.members, res.body.overrides], [null, null]);
  assert.deepEqual((res.body.degraded as string[]).sort(), ["members", "overrides"]);
  assert.equal((res.body.personalState as unknown[]).length, 1);
});

test("dependencies that are not wired are reported as degraded, never faked", async () => {
  wire({ navCounts: undefined as never, adminAttention: undefined as never, timePhase: undefined as never, withServerTiming: undefined as never });
  script(seed());
  const res = await get("platformAdmin");
  assert.equal(res.status, 200);
  assert.deepEqual((res.body.degraded as string[]).sort(), ["admin_attention", "nav_counts"]);
  assert.equal(res.headers.get("server-timing"), null);
});
