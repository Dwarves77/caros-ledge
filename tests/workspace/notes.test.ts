import assert from "node:assert/strict";
import { test } from "node:test";

import { NOTE_MAX_LENGTH } from "@/core/workspace/roster";
import { DELETE, GET, PATCH, parseNoteBody, POST } from "@/features/workspace/api/notes";

import type { MemDb } from "./_memdb.ts";
import { call, E, ITEM_1, matrix, ORG_A, ORG_B, script, seed, USER } from "./_world.ts";

const NOTE = "eeeeeeee-0000-4000-8000-000000000001";
const P = { id: "o3" };
const URL_ = "/api/workspace/items/o3/notes";

/** One live note in org A by the member, on item 1. */
function withNote(db: MemDb, over: Record<string, unknown> = {}) {
  db.rows("item_notes").push({ id: NOTE, org_id: ORG_A, item_id: ITEM_1, author_user_id: USER.member, body: "first note", created_at: "2026-03-01T00:00:00Z", edited_at: null, deleted_at: null, ...over });
  return db;
}

test("persona matrix: notes GET, POST, PATCH, DELETE", async () => {
  await matrix("notes GET", async (p) => (await call(GET, p, "GET", URL_, undefined, P)).status, E(401, 200, 200, 200, 200, 200, 403));
  await matrix("notes POST", async (p) => (await call(POST, p, "POST", URL_, { body: "hello" }, P)).status, E(401, 403, 201, 201, 201, 201, 403));
  // The note belongs to org A and was written by the member: only the author edits it; org B cannot see it at all.
  await matrix("notes PATCH", async (p, db) => (withNote(db), (await call(PATCH, p, "PATCH", URL_, { noteId: NOTE, body: "edited" }, P)).status), E(401, 403, 200, 403, 403, 404, 403));
  await matrix("notes DELETE", async (p, db) => (withNote(db), (await call(DELETE, p, "DELETE", `${URL_}?noteId=${NOTE}`, undefined, P)).status), E(401, 403, 200, 200, 200, 404, 403));
});

test("parseNoteBody trims, refuses blank and over-length with a plain message", () => {
  assert.deepEqual(parseNoteBody("  hi  "), { body: "hi" });
  assert.ok("error" in parseNoteBody("   "));
  assert.ok("error" in parseNoteBody(42));
  assert.match((parseNoteBody("x".repeat(NOTE_MAX_LENGTH + 1)) as { error: string }).error, /limited to 4000/);
});

test("a member adds a note; the list shows it with the author's name and the caller's rights", async () => {
  const db = script(seed());
  const added = await call(POST, "member", "POST", URL_, { body: "  Watch the Q3 date  " }, P);
  assert.equal(added.status, 201);
  const note = added.body.note as Record<string, unknown>;
  assert.deepEqual([note.body, note.author_name, note.mine, note.can_edit, note.can_delete], ["Watch the Q3 date", "Name member", true, true, true]);
  const list = await call(GET, "admin", "GET", URL_, undefined, P);
  const row = (list.body.notes as Record<string, unknown>[])[0] as Record<string, unknown>;
  assert.deepEqual([row.mine, row.can_edit, row.can_delete, (list.body.viewer as Record<string, unknown>).can_write], [false, false, true, true]);
  assert.equal(db.rows("item_notes").length, 1);
});

test("a blank or over-length note writes nothing; a viewer reads but cannot add or edit", async () => {
  const db = script(withNote(seed()));
  assert.equal((await call(POST, "member", "POST", URL_, { body: "   " }, P)).status, 400);
  assert.equal((await call(POST, "member", "POST", URL_, { body: "x".repeat(NOTE_MAX_LENGTH + 1) }, P)).status, 400);
  assert.equal((await call(PATCH, "member", "PATCH", URL_, { noteId: NOTE, body: "" }, P)).status, 400);
  assert.equal((await call(POST, "viewer", "POST", URL_, { body: "hi" }, P)).status, 403);
  assert.equal((await call(PATCH, "viewer", "PATCH", URL_, { noteId: NOTE, body: "x" }, P)).status, 403);
  assert.equal(db.writes("item_notes").length, 0);
  assert.equal(db.rows("item_notes")[0]?.body, "first note");
});

test("ATTACK cross-org read: another org's member sees none of org A's notes", async () => {
  script(withNote(seed()));
  const res = await call(GET, "otherOrgMember", "GET", URL_, undefined, P);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.notes, []);
});

test("ATTACK cross-org write: org B cannot edit or delete org A's note by id, and the note is untouched", async () => {
  const db = script(withNote(seed()));
  assert.equal((await call(PATCH, "otherOrgMember", "PATCH", URL_, { noteId: NOTE, body: "hijack" }, P)).status, 404);
  assert.equal((await call(DELETE, "otherOrgMember", "DELETE", `${URL_}?noteId=${NOTE}`, undefined, P)).status, 404);
  assert.deepEqual([db.rows("item_notes")[0]?.body, db.rows("item_notes")[0]?.deleted_at], ["first note", null]);
});

test("ATTACK item scoping: a note is not reachable through a different item", async () => {
  script(withNote(seed()));
  assert.equal((await call(PATCH, "member", "PATCH", "/api/workspace/items/o4/notes", { noteId: NOTE, body: "x" }, { id: "o4" })).status, 404);
  assert.equal((await call(DELETE, "member", "DELETE", `/api/workspace/items/o4/notes?noteId=${NOTE}`, undefined, { id: "o4" })).status, 404);
});

test("an unknown or unverified item is a 404; a note id that is missing is a 400", async () => {
  const db = script(seed());
  db.rows("intelligence_items").push({ id: "aaaaaaaa-0000-4000-8000-0000000000ff", legacy_id: "u1", title: "Unverified", provenance_status: "pending" });
  assert.equal((await call(GET, "member", "GET", "/api/workspace/items/nope/notes", undefined, { id: "nope" })).status, 404);
  assert.equal((await call(GET, "member", "GET", "/api/workspace/items/u1/notes", undefined, { id: "u1" })).status, 404);
  assert.equal((await call(DELETE, "member", "DELETE", URL_, undefined, P)).status, 400);
});

test("the author edits and the note is marked edited; delete is soft and an edit then 404s", async () => {
  const db = script(withNote(seed()));
  const edited = await call(PATCH, "member", "PATCH", URL_, { noteId: NOTE, body: "revised" }, P);
  assert.equal(edited.status, 200);
  assert.ok((edited.body.note as Record<string, unknown>).edited_at);
  assert.equal((await call(DELETE, "admin", "DELETE", `${URL_}?noteId=${NOTE}`, undefined, P)).status, 200);
  assert.equal(db.rows("item_notes").length, 1);
  assert.ok(db.rows("item_notes")[0]?.deleted_at);
  assert.deepEqual((await call(GET, "member", "GET", URL_, undefined, P)).body.notes, []);
  assert.equal((await call(PATCH, "member", "PATCH", URL_, { noteId: NOTE, body: "again" }, P)).status, 404);
});

test("the author deletes their own note; another member cannot delete an admin's note", async () => {
  const db = script(withNote(seed(), { author_user_id: USER.admin }));
  assert.equal((await call(DELETE, "member", "DELETE", `${URL_}?noteId=${NOTE}`, undefined, P)).status, 403);
  assert.equal(db.rows("item_notes")[0]?.deleted_at, null);
  assert.equal((await call(DELETE, "admin", "DELETE", `${URL_}?noteId=${NOTE}`, undefined, P)).status, 200);
});

test("a moved legacy note has no author: nobody edits it, an admin deletes it", async () => {
  const db = script(withNote(seed(), { author_user_id: null }));
  assert.equal((await call(PATCH, "owner", "PATCH", URL_, { noteId: NOTE, body: "x" }, P)).status, 403);
  assert.equal((await call(PATCH, "member", "PATCH", URL_, { noteId: NOTE, body: "x" }, P)).status, 403);
  assert.equal((await call(DELETE, "admin", "DELETE", `${URL_}?noteId=${NOTE}`, undefined, P)).status, 200);
  assert.ok(db.rows("item_notes")[0]?.deleted_at);
});

test("INV-166 ATTACK: a body naming author_user_id, org_id or item_id never changes what is stamped", async () => {
  const db = script(seed());
  const res = await call(POST, "member", "POST", URL_, { body: "forged", author_user_id: USER.owner, org_id: ORG_B, item_id: "aaaaaaaa-0000-4000-8000-000000000002", created_at: "1999-01-01" }, P);
  assert.equal(res.status, 201);
  const row = db.rows("item_notes")[0] as Record<string, unknown>;
  assert.deepEqual([row.author_user_id, row.org_id, row.item_id], [USER.member, ORG_A, ITEM_1]);
  assert.notEqual(row.created_at, "1999-01-01");
});

const rosterRead = ({ filters }: { filters: [string, string, unknown][] }) => !filters.some(([, col]) => col === "user_id");

test("a roster that cannot be read fails the list with a 503 and never shows an empty roster; after a write it only drops names", async () => {
  const db = script(withNote(seed()));
  db.fail("org_memberships", "select", { message: "roster down" }, { when: rosterRead });
  const list = await call(GET, "admin", "GET", URL_, undefined, P);
  assert.equal(list.status, 503);
  assert.equal(list.headers.get("retry-after"), "1");
  const added = await call(POST, "member", "POST", URL_, { body: "written anyway" }, P);
  assert.equal(added.status, 201);
  assert.equal((added.body.note as Record<string, unknown>).author_name, null);
  assert.equal(db.rows("item_notes").length, 2);
});

test("a failed note read is a 503, never an empty list", async () => {
  const db = script(seed());
  db.fail("item_notes", "select");
  assert.equal((await call(GET, "member", "GET", URL_, undefined, P)).status, 503);
  assert.equal((await call(PATCH, "member", "PATCH", URL_, { noteId: NOTE, body: "x" }, P)).status, 503);
});

test("B-0084: on the notes and assignments routes the org is resolved before the item is read", async () => {
  const db = script(seed());
  await call(GET, "member", "GET", URL_, undefined, P);
  const order = db.log.filter((l) => l.op === "select").map((l) => l.table);
  assert.ok(order.indexOf("org_memberships") >= 0 && order.indexOf("org_memberships") < order.indexOf("intelligence_items"), order.join(","));
});
