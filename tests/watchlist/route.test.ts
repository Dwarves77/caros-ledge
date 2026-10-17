import assert from "node:assert/strict";
import { test } from "node:test";

import { DELETE, GET, POST } from "@/features/watchlist/api/watch";
import { isTeamOnlyScopeViolation, WATCH_TYPES } from "@/features/watchlist/links";

import type { MemDb, Row } from "../workspace/_memdb.ts";
import { call, E, ITEM_1, matrix, ORG_A, ORG_B, script, seed, USER } from "../workspace/_world.ts";

const W = "/api/watchlist";
const rows = (db: MemDb, table: string) => db.rows(table) as Row[];
/** The workspace world with its watchlist rows typed (the shared seed predates the type column). */
const world = (): MemDb => {
  const db = script(seed());
  for (const r of rows(db, "user_watchlist")) r.item_type ??= "reg";
  return db;
};

test("the vocabulary: six types, a series is team-only, and nothing else is", () => {
  assert.deepEqual([...WATCH_TYPES], ["source", "reg", "signal", "research", "operations", "market_series"]);
  assert.deepEqual(WATCH_TYPES.filter((t) => isTeamOnlyScopeViolation(t, "personal")), ["market_series"]);
  assert.equal(isTeamOnlyScopeViolation("market_series", "team"), false);
});

test("persona matrix: GET list (everyone signed in reads), POST and DELETE at personal scope (every signed-in user, a viewer included)", async () => {
  await matrix("watchlist GET", async (p) => (script(seed()), (await call(GET, p, "GET", `${W}?item_type=reg`)).status), E(401, 200, 200, 200, 200, 200, 200));
  await matrix("watchlist POST personal", async (p) => (script(seed()), (await call(POST, p, "POST", W, { itemType: "reg", itemId: "o4" })).status), E(401, 200, 200, 200, 200, 200, 200));
  await matrix("watchlist DELETE personal", async (p) => (script(seed()), (await call(DELETE, p, "DELETE", `${W}?item_type=reg&item_id=o3&scope=personal`)).status), E(401, 200, 200, 200, 200, 200, 200));
});

test("persona matrix: the TEAM scope is written by owner, admin and member; a viewer is 403 (SEC-3b); a user with no workspace is 403; another org's member writes only their own org", async () => {
  await matrix("watchlist POST team", async (p) => (script(seed()), (await call(POST, p, "POST", W, { itemType: "reg", itemId: "o4", scope: "team" })).status), E(401, 403, 200, 200, 200, 200, 403));
  await matrix("watchlist DELETE team", async (p) => (script(seed()), (await call(DELETE, p, "DELETE", `${W}?item_type=reg&item_id=o4&scope=team`)).status), E(401, 403, 200, 200, 200, 200, 403));
});

test("GET list: both scopes' ids of the type, and teamAvailable only for a reader who may write the team list (a viewer reads it and is told the toggle is not theirs)", async () => {
  const db = world();
  rows(db, "org_watchlist").push({ id: "t1", org_id: ORG_A, item_type: "reg", item_id: "o3", added_by_user_id: USER.owner, note: null }, { id: "t2", org_id: ORG_B, item_type: "reg", item_id: "other-org", added_by_user_id: USER.otherOrgMember, note: null });
  const member = await call(GET, "member", "GET", `${W}?item_type=reg`);
  assert.deepEqual(member.body, { watchedIds: ["o3"], teamWatchedIds: ["o3"], teamAvailable: true });
  const viewer = await call(GET, "viewer", "GET", `${W}?item_type=reg`);
  assert.deepEqual([viewer.body.watchedIds, viewer.body.teamWatchedIds, viewer.body.teamAvailable], [[], ["o3"], false]);
  const other = await call(GET, "otherOrgMember", "GET", `${W}?item_type=reg`);
  assert.deepEqual([other.body.teamWatchedIds, other.body.watchedIds], [["other-org"], [ITEM_1]], "another workspace's team list is theirs alone, and the personal list is their own");
  const one = await call(GET, "member", "GET", `${W}?item_type=reg&item_id=o3`);
  assert.deepEqual(one.body, { watched: true, personal: true, team: true, teamAvailable: true });
});

test("POST: the first team adder is kept (the Bloomberg pattern), the org is the caller's own whatever the body says, and a personal watch is idempotent", async () => {
  const db = script(seed());
  assert.equal((await call(POST, "member", "POST", W, { itemType: "reg", itemId: "o4", scope: "team", note: "  Check with ops  " })).status, 200);
  assert.equal((await call(POST, "owner", "POST", W, { itemType: "reg", itemId: "o4", scope: "team", org_id: ORG_B })).status, 200);
  assert.deepEqual(rows(db, "org_watchlist").map((r) => [r.org_id, r.item_id, r.added_by_user_id, r.note]), [[ORG_A, "o4", USER.member, "Check with ops"]], "one row, the first adder, the note trimmed, no row for the forged org");
  await call(POST, "member", "POST", W, { itemType: "reg", itemId: "o4" });
  await call(POST, "member", "POST", W, { itemType: "reg", itemId: "o4" });
  assert.equal(rows(db, "user_watchlist").filter((r) => r.user_id === USER.member && r.item_id === "o4").length, 1);
});

test("DELETE removes only the caller's own personal row and only the caller's own workspace's team row", async () => {
  const db = world();
  rows(db, "org_watchlist").push({ id: "t1", org_id: ORG_A, item_type: "reg", item_id: "o3", added_by_user_id: USER.owner, note: null }, { id: "t2", org_id: ORG_B, item_type: "reg", item_id: "o3", added_by_user_id: USER.otherOrgMember, note: null });
  await call(DELETE, "member", "DELETE", `${W}?item_type=reg&item_id=o3&scope=personal`);
  assert.equal(rows(db, "user_watchlist").some((r) => r.user_id === USER.member && r.item_id === "o3"), false);
  assert.equal(rows(db, "user_watchlist").some((r) => r.user_id === USER.otherOrgMember), true, "another user's watch stays");
  await call(DELETE, "admin", "DELETE", `${W}?item_type=reg&item_id=o3&scope=team`);
  assert.deepEqual(rows(db, "org_watchlist").map((r) => r.org_id), [ORG_B], "only org A's team row went");
});

test("the vocabulary is enforced: a series is refused at personal scope with the reason, an unknown type or scope or a missing id is a 400, a note over 280 characters is a 400", async () => {
  script(seed());
  const series = await call(POST, "member", "POST", W, { itemType: "market_series", itemId: "s1" });
  assert.equal(series.status, 400);
  assert.match(String(series.body.error), /only watchable at scope=team/);
  assert.equal((await call(POST, "member", "POST", W, { itemType: "market_series", itemId: "s1", scope: "team" })).status, 200);
  for (const bad of [{ itemType: "nope", itemId: "x" }, { itemType: "reg", itemId: "  " }, { itemType: "reg", itemId: "x", scope: "everyone" }, { itemType: "reg", itemId: "x", note: "n".repeat(281) }]) assert.equal((await call(POST, "member", "POST", W, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.equal((await call(GET, "member", "GET", `${W}?item_type=bogus`)).status, 400);
  assert.equal((await call(DELETE, "member", "DELETE", `${W}?item_type=market_series&item_id=s1`)).status, 400, "deleting a series at the default personal scope is the same refusal");
});

test("a failed read is a 503 with Retry-After and a failed write is its own status; neither reads as 'not watched'", async () => {
  const db = world();
  db.fail("user_watchlist", "select", "down");
  const read = await call(GET, "member", "GET", `${W}?item_type=reg`);
  assert.deepEqual([read.status, read.headers.get("retry-after")], [503, "1"]);
  const write = world();
  write.fail("org_watchlist", "upsert", { message: "denied", code: "42501" });
  assert.equal((await call(POST, "member", "POST", W, { itemType: "reg", itemId: "o4", scope: "team" })).status, 403);
});
