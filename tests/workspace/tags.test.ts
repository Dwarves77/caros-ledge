import assert from "node:assert/strict";
import { test } from "node:test";

import { DELETE as tagsDelete, GET as tagsGet, POST as tagsPost } from "@/features/workspace/api/tags";
import { groupApplicationsByItem, loadAuthorNames, normalizeTagName } from "@/features/workspace/api/tag-attribution";
import { attributionText } from "@/features/workspace/attribution-text";
import { DELETE as itemsDelete, PUT as itemsPut } from "@/features/workspace/api/tag-items";

import { memoryDb } from "../_support/memory-db.ts";

import type { MemDb, Row } from "./_memdb.ts";
import { call, E, ITEM_1, ITEM_2, matrix, ORG_A, ORG_B, script, seed, USER } from "./_world.ts";

const T = "/api/workspace/tags";
const TAG = "99999999-0000-4000-8000-000000000001";
const TAG_B = "99999999-0000-4000-8000-000000000002";
const link = (db: MemDb, over: Row = {}) => db.rows("item_workspace_tags").push({ tag_id: TAG, intelligence_item_id: ITEM_1, org_id: ORG_A, created_by: USER.member, created_at: "2026-09-03T10:00:00Z", ...over });
const world = () => {
  const db = script(seed());
  db.rows("workspace_tags").push({ id: TAG, org_id: ORG_A, name: "Priority", name_key: "priority", created_by: USER.owner, created_at: "2026-09-01T00:00:00Z" }, { id: TAG_B, org_id: ORG_B, name: "Other org", name_key: "other org", created_by: USER.otherOrgMember, created_at: "2026-09-01T00:00:00Z" });
  return db;
};
const tagParams = { id: TAG };

test("persona matrix: tags GET, POST, DELETE and the tag-items PUT, DELETE", async () => {
  await matrix("tags GET", async (p) => (await call(tagsGet, p, "GET", T)).status, E(401, 200, 200, 200, 200, 200, 403));
  await matrix("tags POST", async (p) => (await call(tagsPost, p, "POST", T, { name: "Fresh" })).status, E(401, 403, 200, 200, 200, 200, 403));
  await matrix("tags DELETE", async (p, db) => (db.rows("workspace_tags").push({ id: TAG, org_id: ORG_A, name: "Priority" }), (await call(tagsDelete, p, "DELETE", T, { tagId: TAG })).status), E(401, 403, 200, 200, 200, 404, 403));
  // The tag belongs to org A: org B's member gets a 404, never an apply through a guessed id.
  await matrix("tag items PUT", async (p, db) => (db.rows("workspace_tags").push({ id: TAG, org_id: ORG_A, name: "Priority" }), (await call(itemsPut, p, "PUT", `${T}/${TAG}/items`, { itemId: "o3" }, tagParams)).status), E(401, 403, 200, 200, 200, 404, 403));
  await matrix("tag items DELETE", async (p) => (await call(itemsDelete, p, "DELETE", `${T}/${TAG}/items`, { itemId: "o3" }, tagParams)).status, E(401, 403, 200, 200, 200, 200, 403));
});

test("GET lists tags with live counts, the item's applied tags with who applied them, and the item-to-tags map", async () => {
  const db = world();
  link(db);
  link(db, { intelligence_item_id: ITEM_2, created_by: null });
  link(db, { tag_id: TAG_B, org_id: ORG_B });
  const res = await call(tagsGet, "viewer", "GET", `${T}?itemId=o3&withItemTags=1`);
  assert.equal(res.status, 200);
  assert.deepEqual((res.body.tags as Record<string, unknown>[]).map((t) => [t.name, t.itemCount]), [["Priority", 2]]);
  assert.deepEqual(res.body.appliedTagIds, [TAG]);
  assert.deepEqual((res.body.applications as Record<string, unknown>[])[0], { tagId: TAG, appliedBy: USER.member, appliedByName: "Name member", appliedAt: "2026-09-03T10:00:00Z" });
  assert.deepEqual(Object.keys(res.body.itemTags as object).sort(), [ITEM_1, ITEM_2].sort());
  assert.equal(((res.body.itemTagApplications as Record<string, { appliedByName: string | null }[]>)[ITEM_2] as { appliedByName: string | null }[])[0]?.appliedByName, null);
});

test("GET without an item id carries no applied tags; an unknown item id carries none either", async () => {
  const db = world();
  link(db);
  const plain = await call(tagsGet, "viewer", "GET", T);
  assert.ok(!("appliedTagIds" in plain.body) && !("itemTags" in plain.body));
  assert.ok(!("appliedTagIds" in (await call(tagsGet, "viewer", "GET", `${T}?itemId=nope`)).body));
});

test("B-0043: a failed tag or link read is a 503, never an empty list; unreadable author names only drop the names, and say so", async () => {
  const db = world();
  link(db);
  db.fail("workspace_tags", "select");
  assert.equal((await call(tagsGet, "viewer", "GET", T)).status, 503);
  db.failures.length = 0;
  db.fail("workspace_tag_counts", "select");
  assert.equal((await call(tagsGet, "viewer", "GET", T)).status, 503, "a failed count read is not a list of zeros");
  db.failures.length = 0;
  db.fail("item_workspace_tags", "select");
  assert.equal((await call(tagsGet, "viewer", "GET", `${T}?itemId=o3`)).status, 503);
  assert.equal((await call(tagsGet, "viewer", "GET", T)).status, 200, "the plain list never reads the join table");
  db.failures.length = 0;
  db.fail("profiles", "select", { message: "names down" });
  const degraded = await call(tagsGet, "viewer", "GET", `${T}?itemId=o3`);
  assert.equal(degraded.status, 200);
  assert.equal(degraded.body.namesUnavailable, true);
  assert.equal(((degraded.body.applications as Record<string, unknown>[])[0] as Record<string, unknown>).appliedByName, null);
});

test("a workspace past 500 tags or 5000 applications is an error, never a silently short list", async () => {
  const db = world();
  for (let i = 0; i < 500; i += 1) db.rows("workspace_tags").push({ id: `88888888-0000-4000-8000-${String(i).padStart(12, "0")}`, org_id: ORG_A, name: `t${i}`, name_key: `t${i}` });
  assert.equal((await call(tagsGet, "viewer", "GET", T)).status, 503);
});

test("POST creates a tag stamped with the session user; a duplicate name in any case returns the existing tag; a blank or long name is a 400", async () => {
  const db = world();
  const made = await call(tagsPost, "member", "POST", T, { name: "  Needs   review " });
  assert.equal(made.status, 200);
  assert.deepEqual([(made.body.tag as Record<string, unknown>).name, (made.body.tag as Record<string, unknown>).itemCount], ["Needs review", 0]);
  assert.equal(db.rows("workspace_tags").find((r) => r.name === "Needs review")?.created_by, USER.member);
  const dup = await call(tagsPost, "admin", "POST", T, { name: "PRIORITY" });
  assert.deepEqual([dup.status, dup.body.existed, (dup.body.tag as Record<string, unknown>).id], [200, true, TAG]);
  assert.equal(db.rows("workspace_tags").filter((r) => r.org_id === ORG_A).length, 2);
  assert.equal((await call(tagsPost, "member", "POST", T, { name: "   " })).status, 400);
  assert.equal((await call(tagsPost, "member", "POST", T, { name: "x".repeat(61) })).status, 400);
  assert.equal((await call(tagsPost, "member", "POST", T, {})).status, 400);
});

test("INV-166 ATTACK: a forged created_by on tag create is ignored; the applier is stamped from the session", async () => {
  const db = world();
  await call(tagsPost, "member", "POST", T, { name: "Forged", created_by: USER.owner, org_id: ORG_B });
  const row = db.rows("workspace_tags").find((r) => r.name === "Forged") as Row;
  assert.deepEqual([row.created_by, row.org_id], [USER.member, ORG_A]);
  const res = await call(itemsPut, "member", "PUT", `${T}/${TAG}/items`, { itemId: "o3", created_by: USER.owner, createdBy: USER.owner, applied_by: USER.owner, appliedBy: USER.owner, appliedAt: "1999-01-01", created_at: "1999-01-01", org_id: ORG_B }, tagParams);
  assert.equal(res.status, 200);
  const applied = db.rows("item_workspace_tags")[0] as Row;
  assert.deepEqual([applied.created_by, applied.org_id, applied.tag_id, applied.intelligence_item_id], [USER.member, ORG_A, TAG, ITEM_1]);
  assert.notEqual(applied.created_at, "1999-01-01");
});

test("INV-166: a repeat apply keeps the first applier and date; removing then applying again is a new application", async () => {
  const db = world();
  await call(itemsPut, "member", "PUT", `${T}/${TAG}/items`, { itemId: "o3" }, tagParams);
  const first = { ...(db.rows("item_workspace_tags")[0] as Row) };
  await call(itemsPut, "admin", "PUT", `${T}/${TAG}/items`, { itemId: "o3" }, tagParams);
  assert.equal(db.rows("item_workspace_tags").length, 1);
  assert.deepEqual([db.rows("item_workspace_tags")[0]?.created_by, db.rows("item_workspace_tags")[0]?.created_at], [first.created_by, first.created_at]);
  await call(itemsDelete, "owner", "DELETE", `${T}/${TAG}/items`, { itemId: "o3" }, tagParams);
  assert.equal(db.rows("item_workspace_tags").length, 0);
  await call(itemsPut, "admin", "PUT", `${T}/${TAG}/items`, { itemId: "o3" }, tagParams);
  assert.equal(db.rows("item_workspace_tags")[0]?.created_by, USER.admin);
});

test("an unauthenticated request writes nothing", async () => {
  const db = world();
  assert.equal((await call(itemsPut, "anon", "PUT", `${T}/${TAG}/items`, { itemId: "o3" }, tagParams)).status, 401);
  assert.equal((await call(tagsPost, "anon", "POST", T, { name: "x" })).status, 401);
  assert.equal(db.writes().length, 0);
});

test("INV-149 ATTACK: org B cannot apply, remove or delete org A's tag through a guessed id; org A's links stay", async () => {
  const db = world();
  link(db);
  assert.equal((await call(itemsPut, "otherOrgMember", "PUT", `${T}/${TAG}/items`, { itemId: "o4" }, tagParams)).status, 404);
  await call(itemsDelete, "otherOrgMember", "DELETE", `${T}/${TAG}/items`, { itemId: "o3" }, tagParams);
  assert.equal((await call(tagsDelete, "otherOrgMember", "DELETE", T, { tagId: TAG })).status, 404, "nothing was deleted, so the answer is not a success");
  assert.equal(db.rows("item_workspace_tags").length, 1);
  assert.ok(db.rows("workspace_tags").some((r) => r.id === TAG));
  assert.equal(db.writes("item_workspace_tags").length, 1, "only the (no-op) org-filtered delete reached the table");
});

test("DELETE answers 404 when nothing was deleted (a guessed id, another org's tag, the delete policy's silent refusal looks the same), 200 and the row gone when something was", async () => {
  const db = world();
  const miss = await call(tagsDelete, "member", "DELETE", T, { tagId: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
  assert.deepEqual([miss.status, typeof miss.body.error], [404, "string"]);
  assert.equal((await call(tagsDelete, "member", "DELETE", T, { tagId: TAG_B })).status, 404, "another org's tag by its real id");
  assert.deepEqual(db.rows("workspace_tags").map((r) => r.id).sort(), [TAG, TAG_B].sort());
  assert.equal((await call(tagsDelete, "member", "DELETE", T, { tagId: TAG })).status, 200);
  assert.deepEqual(db.rows("workspace_tags").map((r) => r.id), [TAG_B]);
  assert.equal((await call(tagsDelete, "member", "DELETE", T, { tagId: TAG })).status, 404, "the same delete a second time deleted nothing");
});

test("deleting a tag is org-scoped; an unknown item is a 404; a failed item read is a 503", async () => {
  const db = world();
  assert.equal((await call(itemsPut, "member", "PUT", `${T}/${TAG}/items`, { itemId: "nope" }, tagParams)).status, 404);
  db.fail("intelligence_items", "select");
  assert.equal((await call(itemsPut, "member", "PUT", `${T}/${TAG}/items`, { itemId: "o3" }, tagParams)).status, 503);
  db.failures.length = 0;
  db.fail("workspace_tags", "select");
  assert.equal((await call(itemsPut, "member", "PUT", `${T}/${TAG}/items`, { itemId: "o3" }, tagParams)).status, 503);
});

test("attribution wording: a name, a former member, a member with no name; dates in UTC; an email is never used", async () => {
  const base = { tagId: "t", appliedBy: "u", appliedByName: "Ada Lovelace", appliedAt: "2026-09-03T23:30:00Z" };
  assert.equal(attributionText(base), "applied by Ada Lovelace on 3 Sep 2026");
  assert.equal(attributionText({ ...base, appliedByName: null }), "applied by a workspace member on 3 Sep 2026");
  assert.equal(attributionText({ ...base, appliedBy: null, appliedByName: null, appliedAt: null }), "applied by a former member");
  assert.equal(attributionText(null), null);
  assert.equal(attributionText({ ...base, appliedAt: "not a date" }), "applied by Ada Lovelace", "an unreadable date is left out");
  const names = await loadAuthorNames(memoryDb({ profiles: [{ id: "p1", full_name: " ", display_name: "Ada", email: "ada@example.test" }, { id: "p2", full_name: null, display_name: null, email: "x@example.test" }] }).db, ["p1", "p2"]);
  assert.deepEqual([names.get("p1"), names.get("p2")], ["Ada", null], "the display name when the full name is blank; an email is never a name");
  assert.deepEqual(Object.keys(groupApplicationsByItem([{ tag_id: "t", intelligence_item_id: "i1", created_by: null, created_at: null }], new Map())), ["i1"]);
  assert.equal(normalizeTagName("  a   b "), "a b");
  assert.equal(normalizeTagName(5), null);
});
