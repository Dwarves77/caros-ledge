import assert from "node:assert/strict";
import { test } from "node:test";

import { wireWorkspaceDeps } from "@/features/workspace/api/deps";
import { GET as detailGet, PATCH as detailPatch, DELETE as detailDelete } from "@/features/workspace/api/portfolio-detail";
import { DELETE as membersDelete, POST as membersPost } from "@/features/workspace/api/portfolio-members";
import { GET as listGet, POST as listPost } from "@/features/workspace/api/portfolios";
import { computeRollup } from "@/features/workspace/portfolio/core";
import type { HeldRow } from "@/features/workspace/portfolio/types";

import type { MemDb, Row } from "./_memdb.ts";
import { call, E, ITEM_1, ITEM_2, ITEM_ARCHIVED, matrix, ORG_A, ORG_B, script, seed } from "./_world.ts";

const L = "/api/workspace/portfolios";
const PF = "77777777-0000-4000-8000-000000000001";
const PF_B = "77777777-0000-4000-8000-000000000002";
const p = { id: PF };
const weakest = (classes: string[]) => (classes.includes("community") ? "community" : (classes[0] ?? null));
const held = (over: Partial<HeldRow> & { uiId: string }): HeldRow => ({ title: over.uiId, priority: "HIGH", surface: "regulations", dueDays: null, fields: {}, ...over });

function world(extra?: (db: MemDb) => void) {
  const db = script(seed());
  db.rows("portfolios").push({ id: PF, org_id: ORG_A, name: "Core book", name_key: "core book", created_at: "2026-10-01T00:00:00Z" }, { id: PF_B, org_id: ORG_B, name: "Theirs", name_key: "theirs", created_at: "2026-10-01T00:00:00Z" });
  db.rows("entities").push(
    { entity_id: "cl:corridor:nlrtm-sgsin", kind: "corridor", status: "active", merged_into: null, canonical_name: "corridor:nlrtm:sgsin", display_name: null },
    { entity_id: "cl:jurisdiction:eu", kind: "jurisdiction", status: "active", merged_into: null, canonical_name: "European Union", display_name: "EU" },
    { entity_id: "cl:jurisdiction:old", kind: "jurisdiction", status: "merged", merged_into: "cl:jurisdiction:eu", canonical_name: "EU old", display_name: null },
    { entity_id: "cl:jurisdiction:gone", kind: "jurisdiction", status: "retired", merged_into: null, canonical_name: "Gone", display_name: null },
  );
  extra?.(db);
  wireWorkspaceDeps({ portfolio: { heldItems: async () => [], corridorLabel: (name) => (name.startsWith("corridor:") ? "Rotterdam to Singapore" : null), weakestOriginClass: weakest } });
  return db;
}

test("persona matrix: portfolios GET, POST, detail GET, PATCH, DELETE and members POST, DELETE", async () => {
  await matrix("list GET", async (who) => (world(), (await call(listGet, who, "GET", L)).status), E(401, 200, 200, 200, 200, 200, 403));
  await matrix("list POST", async (who) => (world(), (await call(listPost, who, "POST", L, { name: "New book" })).status), E(401, 403, 201, 201, 201, 201, 403));
  // The portfolio belongs to org A: org B's member gets a 404, exactly as for a missing id.
  await matrix("detail GET", async (who) => (world(), (await call(detailGet, who, "GET", `${L}/${PF}`, undefined, p)).status), E(401, 200, 200, 200, 200, 404, 403));
  await matrix("detail PATCH", async (who) => (world(), (await call(detailPatch, who, "PATCH", `${L}/${PF}`, { name: "Renamed" }, p)).status), E(401, 403, 200, 200, 200, 404, 403));
  await matrix("detail DELETE", async (who) => (world(), (await call(detailDelete, who, "DELETE", `${L}/${PF}`, undefined, p)).status), E(401, 403, 200, 200, 200, 404, 403));
  await matrix("members POST", async (who) => (world(), (await call(membersPost, who, "POST", `${L}/${PF}/members`, { itemId: "o3" }, p)).status), E(401, 403, 201, 201, 201, 404, 403));
  await matrix("members DELETE", async (who) => (world(), (await call(membersDelete, who, "DELETE", `${L}/${PF}/members`, { itemId: "o3" }, p)).status), E(401, 403, 200, 200, 200, 404, 403));
});

test("the list shows this org's portfolios with member counts; another org's are never listed", async () => {
  const db = world();
  db.rows("portfolio_members").push({ id: "m1", portfolio_id: PF, org_id: ORG_A, member_kind: "item", item_id: ITEM_1 }, { id: "m2", portfolio_id: PF, org_id: ORG_A, member_kind: "item", item_id: ITEM_2 }, { id: "m3", portfolio_id: PF_B, org_id: ORG_B, member_kind: "item", item_id: ITEM_1 });
  const res = await call(listGet, "viewer", "GET", L);
  assert.deepEqual((res.body.portfolios as Row[]).map((r) => [r.name, r.memberCount]), [["Core book", 2]]);
});

test("create: a case-insensitive duplicate name returns the existing portfolio; a blank or long name is a 400; the 100 cap is a 409", async () => {
  const db = world();
  const dup = await call(listPost, "member", "POST", L, { name: "  CORE   book " });
  assert.deepEqual([dup.status, dup.body.existed, (dup.body.portfolio as Row).id], [200, true, PF]);
  assert.equal(db.rows("portfolios").filter((r) => r.org_id === ORG_A).length, 1);
  assert.equal((await call(listPost, "member", "POST", L, { name: " " })).status, 400);
  assert.equal((await call(listPost, "member", "POST", L, { name: "x".repeat(81) })).status, 400);
  assert.equal((await call(listPost, "member", "POST", L, {})).status, 400);
  db.fail("portfolios", "insert", { message: "portfolio_cap_reached" });
  assert.equal((await call(listPost, "member", "POST", L, { name: "one more" })).status, 409);
});

test("rename: a name another portfolio already has is a 409; an unknown id is a 404; delete removes it", async () => {
  const db = world();
  db.rows("portfolios").push({ id: "77777777-0000-4000-8000-000000000009", org_id: ORG_A, name: "Second", name_key: "second" });
  assert.equal((await call(detailPatch, "member", "PATCH", `${L}/${PF}`, { name: "second" }, p)).status, 409);
  assert.equal((await call(detailPatch, "member", "PATCH", `${L}/${PF}`, { name: "" }, p)).status, 400);
  assert.equal((await call(detailPatch, "member", "PATCH", `${L}/nope`, { name: "x" }, { id: "nope" })).status, 404);
  assert.equal((await call(detailDelete, "member", "DELETE", `${L}/${PF}`, undefined, p)).status, 200);
  assert.ok(!db.rows("portfolios").some((r) => r.id === PF));
});

test("add: a held item (by legacy id or uuid) is added once and a repeat answers existed; an archived or unknown item is refused", async () => {
  const db = world();
  const first = await call(membersPost, "member", "POST", `${L}/${PF}/members`, { itemId: "o3" }, p);
  assert.deepEqual([first.status, (first.body.member as Row).itemId, first.body.existed], [201, ITEM_1, false]);
  const again = await call(membersPost, "admin", "POST", `${L}/${PF}/members`, { itemId: ITEM_1.toUpperCase() }, p);
  assert.deepEqual([again.status, again.body.existed], [200, true]);
  assert.equal(db.rows("portfolio_members").length, 1);
  assert.equal(db.rows("portfolio_members")[0]?.added_by, "bbbbbbbb-0000-4000-8000-000000000002");
  assert.equal((await call(membersPost, "member", "POST", `${L}/${PF}/members`, { itemId: ITEM_ARCHIVED }, p)).status, 404);
  assert.equal((await call(membersPost, "member", "POST", `${L}/${PF}/members`, { itemId: "nope" }, p)).status, 404);
  assert.equal(db.rows("portfolio_members").length, 1);
});

test("add: an entity is followed through a merge to its survivor, a retired or unknown one is refused, a bad shape is a 400", async () => {
  const db = world();
  const merged = await call(membersPost, "member", "POST", `${L}/${PF}/members`, { entityId: "cl:jurisdiction:old" }, p);
  assert.deepEqual([merged.status, (merged.body.member as Row).entityId, (merged.body.member as Row).kind], [201, "cl:jurisdiction:eu", "entity"]);
  const corridor = await call(membersPost, "member", "POST", `${L}/${PF}/members`, { entityId: "cl:corridor:nlrtm-sgsin" }, p);
  assert.equal((corridor.body.member as Row).kind, "corridor");
  assert.equal((await call(membersPost, "member", "POST", `${L}/${PF}/members`, { entityId: "cl:jurisdiction:gone" }, p)).status, 409);
  assert.equal((await call(membersPost, "member", "POST", `${L}/${PF}/members`, { entityId: "cl:jurisdiction:missing" }, p)).status, 404);
  assert.equal((await call(membersPost, "member", "POST", `${L}/${PF}/members`, { entityId: "garbage" }, p)).status, 400);
  assert.equal((await call(membersPost, "member", "POST", `${L}/${PF}/members`, { itemId: ITEM_1, entityId: "cl:jurisdiction:eu" }, p)).status, 400);
  assert.equal((await call(membersPost, "member", "POST", `${L}/${PF}/members`, {}, p)).status, 400);
  assert.equal(db.rows("portfolio_members").length, 2);
});

test("remove: a member goes; removing what is absent is not an error; another org's portfolio is untouched", async () => {
  const db = world();
  db.rows("portfolio_members").push({ id: "m1", portfolio_id: PF, org_id: ORG_A, member_kind: "item", item_id: ITEM_1 });
  assert.equal((await call(membersDelete, "otherOrgMember", "DELETE", `${L}/${PF}/members`, { itemId: "o3" }, p)).status, 404);
  assert.equal(db.rows("portfolio_members").length, 1);
  assert.equal((await call(membersDelete, "member", "DELETE", `${L}/${PF}/members`, { itemId: "o3" }, p)).status, 200);
  assert.equal(db.rows("portfolio_members").length, 0);
  assert.equal((await call(membersDelete, "member", "DELETE", `${L}/${PF}/members`, { itemId: "o3" }, p)).status, 200);
});

test("detail: members hydrated by surface with roll-ups carrying their denominators; a member the read layer does not return is named, not counted", async () => {
  const db = world((d) => {
    d.rows("portfolio_members").push(
      { id: "m1", portfolio_id: PF, org_id: ORG_A, member_kind: "item", item_id: ITEM_1, added_at: "2026-10-02T00:00:00Z" },
      { id: "m2", portfolio_id: PF, org_id: ORG_A, member_kind: "item", item_id: ITEM_2, added_at: "2026-10-03T00:00:00Z" },
      { id: "m3", portfolio_id: PF, org_id: ORG_A, member_kind: "corridor", entity_id: "cl:corridor:nlrtm-sgsin", added_at: "2026-10-04T00:00:00Z" },
      { id: "m4", portfolio_id: PF, org_id: ORG_A, member_kind: "entity", entity_id: "cl:jurisdiction:eu", added_at: "2026-10-05T00:00:00Z" },
      { id: "m5", portfolio_id: PF, org_id: ORG_A, member_kind: "entity", entity_id: "cl:jurisdiction:unread", added_at: "2026-10-06T00:00:00Z" },
    );
  });
  wireWorkspaceDeps({
    portfolio: {
      heldItems: async (orgId, ids) => (assert.equal(orgId, ORG_A), ids.includes(ITEM_1) ? [held({ uiId: "o3", title: "FuelEU", dueDays: 40 })] : []),
      corridorLabel: () => "Rotterdam to Singapore",
      weakestOriginClass: weakest,
    },
  });
  const res = await call(detailGet, "viewer", "GET", `${L}/${PF}`, undefined, p);
  assert.equal(res.status, 200);
  const rollup = res.body.rollup as Record<string, Record<string, unknown>>;
  assert.deepEqual(rollup.items, { members: 2, held: 1, notHeld: [ITEM_2] });
  assert.deepEqual(rollup.entities, { corridors: 1, other: 2 });
  assert.deepEqual(rollup.nextDue, { itemId: ITEM_1, days: 40 });
  assert.deepEqual(rollup.origin, { weakest: "official", classified: 1, unclassified: 0 });
  assert.equal(res.body.entitiesUnread, 1);
  assert.deepEqual((res.body.entityRows as Row[]).map((e) => e.label), ["Rotterdam to Singapore", "EU"]);
  assert.deepEqual(((res.body.groups as Row[])[0] as Row).surface, "regulations");
  void db;
});

test("detail: a read layer that is not wired, or a failed member read, is a 503 and never an empty portfolio", async () => {
  world();
  wireWorkspaceDeps({ portfolio: undefined as never });
  assert.equal((await call(detailGet, "viewer", "GET", `${L}/${PF}`, undefined, p)).status, 503);
  const db = world();
  db.fail("portfolio_members", "select");
  assert.equal((await call(detailGet, "viewer", "GET", `${L}/${PF}`, undefined, p)).status, 503);
  assert.equal((await call(listGet, "viewer", "GET", L)).status, 503);
});

test("names, entity kinds and one-of member input are the requests' rules: a name is collapsed and must be text, an entity id names its kind, an item id must be an id and one of item or entity is required; and roll-ups carry every denominator", async () => {
  const db = world();
  const create = async (name: unknown) => call(listPost, "member", "POST", L, { name });
  assert.equal(((await create("  a   b ")).body.portfolio as Row).name, "a b", "inner whitespace is collapsed");
  assert.equal((await create(7)).status, 400, "a name that is not text is refused");
  const add = async (body: unknown) => call(membersPost, "member", "POST", `${L}/${PF}/members`, body, p);
  assert.equal((await add({ entityId: "cl:corridor:nlrtm-sgsin" })).status, 201);
  assert.equal((await add({ entityId: "cl:jurisdiction:eu" })).status, 201);
  assert.deepEqual(db.rows("portfolio_members").filter((r) => r.portfolio_id === PF).map((r) => r.member_kind).sort(), ["corridor", "entity"], "the kind comes from the entity id");
  assert.equal((await add({ entityId: "x" })).status, 400, "an id that names no kind is refused");
  assert.equal((await add({ itemId: "not-a-uuid" })).status, 404, "an item id that is no uuid is read as a legacy id and finds nothing");
  assert.equal((await add({})).status, 400);
  const rollup = computeRollup(
    {
      members: [{ kind: "item", itemId: "a", entityId: null }, { kind: "item", itemId: "b", entityId: null }, { kind: "corridor", itemId: null, entityId: "cl:corridor:x" }],
      heldItems: [{ id: "a", surface: "market", priority: null, dueDays: 3, originClass: null }, { id: "z", surface: "weird", priority: "LOW", dueDays: -1, originClass: "community" }],
    },
    weakest,
  );
  assert.deepEqual([rollup.total, rollup.items.notHeld, rollup.bySurface.market, rollup.otherSurface, rollup.byPriority.unscored, rollup.byPriority.LOW, rollup.nextDue, rollup.origin], [3, ["b"], 1, 1, 1, 1, { itemId: "a", days: 3 }, { weakest: "community", classified: 1, unclassified: 1 }]);
});
