import assert from "node:assert/strict";
import { test } from "node:test";

import { GET as correctionsGet } from "@/features/corrections/api";
import { GET as assignmentsGet } from "@/features/workspace/api/assignments";
import { GET as bootstrapGet } from "@/features/workspace/api/bootstrap";
import { wireWorkspaceDeps } from "@/features/workspace/api/deps";
import { GET as notesGet } from "@/features/workspace/api/notes";
import { POST as overridesPost } from "@/features/workspace/api/overrides";
import { GET as personalGet, POST as personalPost } from "@/features/workspace/api/personal-state";
import { GET as portfoliosGet } from "@/features/workspace/api/portfolios";
import { GET as tagsGet, POST as tagsPost } from "@/features/workspace/api/tags";

import { scripted } from "../_support/fake-clients.ts";

import type { Row } from "./_memdb.ts";
import { call, ITEM_1, ORG_A, script, seed, TEAMMATE, USER } from "./_world.ts";

// A member's pages render under RLS alone: the parity runner has no service key, so every read and write below runs on the caller's own client.
// The service factory is unset (it throws the real "not configured" error), so a route that reaches for it fails these tests.
const world = () => {
  const db = script(seed());
  scripted.service = null;
  wireWorkspaceDeps({ navCounts: async () => ({ regulations: 1 }), adminAttention: async () => ({ total: 0 }) });
  db.rows("user_item_state").push({ id: "s1", user_id: USER.member, item_id: ITEM_1, is_archived: true, archive_note: null, archived_at: "2026-10-01T00:00:00Z" });
  db.rows("workspace_item_overrides").push({ org_id: ORG_A, item_id: ITEM_1, priority_override: "HIGH", is_archived: false, owner_user_id: TEAMMATE });
  return db;
};
const item = { id: "o3" };

test("no service key: a member's bootstrap, personal state, roster, overrides, tags, portfolios, notes and assignments answer 200", async () => {
  world();
  const boot = await call(bootstrapGet, "member", "GET", "/api/workspace/bootstrap");
  assert.equal(boot.status, 200);
  assert.deepEqual(boot.body.degraded, [], "no field degraded for want of a service client");
  assert.equal((boot.body.members as Row[]).length, 5, "the roster is the org's members");
  assert.deepEqual((boot.body.overrides as Row[]).map((o) => [o.itemId, o.ownerName]), [["o3", "Name teammate"]]);
  assert.deepEqual((boot.body.personalState as Row[]).map((p) => p.legacyId), ["o3"]);
  for (const [name, handler, path, params] of [
    ["personal state", personalGet, "/api/workspace/personal-state", {}],
    ["tags", tagsGet, "/api/workspace/tags", {}],
    ["portfolios", portfoliosGet, "/api/workspace/portfolios", {}],
    ["notes", notesGet, "/api/workspace/items/o3/notes", item],
    ["assignments", assignmentsGet, "/api/workspace/items/o3/assignments", item],
  ] as const) assert.equal((await call(handler, "member", "GET", path, undefined, params)).status, 200, name);
});

test("no service key: the member's own writes (personal archive, override, tag) answer 200 on the caller's client", async () => {
  const db = world();
  assert.equal((await call(personalPost, "member", "POST", "/api/workspace/personal-state", { itemId: "o3", isArchived: false })).status, 200);
  assert.equal((await call(overridesPost, "member", "POST", "/api/workspace/overrides", { itemId: "o3", dismiss: true })).status, 200);
  assert.ok(db.rows("workspace_item_overrides").find((o) => o.org_id === ORG_A)?.dismissed_at);
  assert.equal((await call(overridesPost, "member", "POST", "/api/workspace/overrides", { itemId: "o3", priorityOverride: "LOW", reason: "r" })).status, 403, "a workspace priority is an owner or admin act");
  assert.equal((await call(tagsPost, "member", "POST", "/api/workspace/tags", { name: "Fresh" })).status, 200);
});

test("another org's member gets only their own org from the same routes", async () => {
  world();
  const boot = await call(bootstrapGet, "otherOrgMember", "GET", "/api/workspace/bootstrap");
  assert.equal(boot.status, 200);
  assert.deepEqual((boot.body.members as Row[]).map((m) => m.user_id), [USER.otherOrgMember]);
  assert.deepEqual(boot.body.overrides, []);
});

test("no service key: the admin console answers 503 with the stated reason, not an unhandled 500", async () => {
  world();
  const res = await call(correctionsGet, "platformAdmin", "GET", "/api/admin/items/o3/corrections", undefined, { id: "o3" });
  assert.equal(res.status, 503);
  assert.match(String(res.body.error), /service key is not configured/);
});
