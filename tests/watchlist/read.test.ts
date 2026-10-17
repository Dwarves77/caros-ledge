import assert from "node:assert/strict";
import { test } from "node:test";

import { loadMembership, membershipOf, resetMembership, setWatch, useWatchMembership } from "@/features/watchlist/membership";
import { readNotices } from "@/features/watchlist/read/notices";
import { byNextDate, readWatchlist, UNAVAILABLE_TITLE } from "@/features/watchlist/read/watchlist";

import { MemDb } from "../_support/memdb.ts";
import { clientFor, ORG_A, seed, TEAMMATE, USER } from "../workspace/_world.ts";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const UUID = "aaaaaaaa-0000-4000-8000-0000000000a1";
const SOURCE = "a1000000-0000-4000-8000-000000000001";
const SERIES = "5e000000-0000-4000-8000-000000000001";

function world(): MemDb {
  const db = seed() as unknown as MemDb;
  db.rows("user_watchlist").length = 0;
  db.seed("sources", [{ id: SOURCE, name: "EUR-Lex", base_tier: 1, tier_override: null, effective_tier: null }, { id: "a1000000-0000-4000-8000-000000000009", name: "Watched Source", base_tier: 3, tier_override: null, effective_tier: null }]);
  db.seed("market_series", [{ id: SERIES, series_key: "k", label: "EUR/USD" }]);
  db.rows("intelligence_items").forEach((i) => ((i.source_id = SOURCE), (i.compliance_deadline = i.legacy_id === "o3" ? "2026-11-01" : null)));
  db.seed("intelligence_items", [{ id: UUID, legacy_id: null, title: "By uuid", item_type: "market_signal", domain: 2, provenance_status: "verified", is_archived: false, priority: "LOW", origin_class: null, source_id: SOURCE }]);
  db.seed("user_watchlist", [
    { id: "p1", user_id: USER.member, item_type: "reg", item_id: "o3", created_at: "2026-10-01T00:00:00Z" },
    { id: "p2", user_id: USER.member, item_type: "signal", item_id: UUID, created_at: "2026-10-03T00:00:00Z" },
    { id: "p3", user_id: USER.member, item_type: "reg", item_id: "gone", created_at: "2026-10-04T00:00:00Z" },
    { id: "p4", user_id: USER.member, item_type: "source", item_id: "a1000000-0000-4000-8000-000000000009", created_at: "2026-10-02T00:00:00Z" },
  ]);
  db.seed("org_watchlist", [
    { id: "t1", org_id: ORG_A, item_type: "reg", item_id: "o3", added_by_user_id: TEAMMATE, note: "dup of a personal watch", created_at: "2026-10-05T00:00:00Z" },
    { id: "t2", org_id: ORG_A, item_type: "market_series", item_id: SERIES, added_by_user_id: TEAMMATE, note: "watch the rate", created_at: "2026-10-06T00:00:00Z" },
    { id: "t3", org_id: ORG_A, item_type: "reg", item_id: "o4", added_by_user_id: "bbbbbbbb-0000-4000-8000-0000000000ff", note: null, created_at: "2026-10-07T00:00:00Z" },
  ]);
  return db;
}
const read = (db: MemDb, limit = 250) => readWatchlist(clientFor(db as never, "member"), { userId: USER.member, orgId: ORG_A }, limit, NOW);

test("the watchlist read: personal and team merged newest first, a duplicate resolves to the personal watch, each type labelled by its own table, and a row the read gate hides is said to be unavailable (never titled with its raw id)", async () => {
  const w = await read(world());
  assert.deepEqual(w.items.map((i) => [i.scope, i.type, i.title]), [
    ["team", "reg", "ReFuelEU Aviation"],
    ["team", "market_series", "EUR/USD"],
    ["personal", "reg", UNAVAILABLE_TITLE],
    ["personal", "signal", "By uuid"],
    ["personal", "source", "Watched Source"],
    ["personal", "reg", "FuelEU Maritime"],
  ]);
  assert.equal(w.items.filter((i) => i.id === "o3").length, 1, "the personal and the team watch of o3 are one row");
  assert.equal(w.items.find((i) => i.id === "o3")?.scope, "personal");
  assert.equal(w.items.some((i) => i.title === "gone" || i.title === "o4"), false, "no raw identifier is a title");
});

test("an item-backed row carries the list-row fields the lists draw (surface link, tier, deadline); a source and a series are unlinked", async () => {
  const w = await read(world());
  const fuel = w.items.find((i) => i.id === "o3");
  assert.equal(fuel?.fields?.href, "/regulations/o3");
  assert.equal(fuel?.fields?.tier, 1, "the source's rating");
  assert.deepEqual(fuel?.fields?.due, { label: "Nov 1, 2026", days: "17 days" });
  assert.equal(fuel?.dueDays, 17);
  assert.equal(w.items.find((i) => i.id === UUID)?.fields?.href, `/market/${UUID}`, "a market signal opens on Market, by the one routing rule");
  assert.equal(w.items.find((i) => i.type === "source")?.fields, null);
  assert.equal(w.items.find((i) => i.type === "market_series")?.fields, null);
});

test("team rows carry the note and who added them, from the workspace roster; an unknown adder is simply unnamed", async () => {
  const w = await read(world());
  const series = w.items.find((i) => i.type === "market_series");
  assert.deepEqual([series?.note, series?.addedBy], ["watch the rate", "Name teammate"]);
  assert.equal(w.items.find((i) => i.id === "o4")?.addedBy, null);
});

test("the cap: a scope that returned as many rows as asked for says older watches exist", async () => {
  const db = world();
  assert.equal((await read(db, 250)).capped, false);
  assert.equal((await read(db, 4)).capped, true, "personal has four rows");
});

test("INV-263: every read checks its error, and the whole read rejects (never an empty watchlist)", async () => {
  for (const [table, op] of [["user_watchlist", "select"], ["org_watchlist", "select"], ["intelligence_items", "select"], ["sources", "select"], ["market_series", "select"]] as const) {
    const db = world();
    db.fail(table, op, "down");
    await assert.rejects(read(db), new RegExp(`${table} read failed: down|${table}`), table);
  }
  const noOrg = await readWatchlist(clientFor(world() as never, "member"), { userId: USER.member, orgId: null }, 250, NOW);
  assert.equal(noOrg.items.every((i) => i.scope === "personal"), true, "a reader with no workspace has no team rows");
});

test("a failed source-rating read is reported on the read, and the rows carry no tier", async () => {
  const db = world();
  db.fail("source_bias_tags", "select", "down");
  const w = await read(db);
  assert.equal(w.ratingsFailed, true);
  assert.equal(w.items.find((i) => i.id === "o3")?.fields?.tier ?? null, null);
});

test("the Watched card is sorted by next date: dated first, soonest first, undated after, the newest watch breaking a tie", async () => {
  const w = await read(world());
  const order = [...w.items].sort(byNextDate).map((i) => i.id);
  assert.equal(order[0], "o3", "the only dated row is first");
  assert.deepEqual(order.slice(1), w.items.filter((i) => i.id !== "o3").map((i) => i.id), "the rest keep the newest-watch order");
});

test("recalculation notices: the old and new derived values of the entities the workspace watches, labelled; none in the window is a real empty; a failure rejects", async () => {
  const db = world();
  const ENT = "cl:instrument:1d5859158d0dfc49";
  db.rows("intelligence_items").find((i) => i.legacy_id === "o3")!.instrument_entity_id = ENT;
  db.seed("entities", [{ entity_id: ENT, kind: "instrument", canonical_name: "FuelEU Maritime", display_name: null, status: "active" }]);
  db.seed("derived_values", [
    { value_id: "v1", entity_id: ENT, method_id: "m", method_version: "1", value: 10, unit: "EUR", currency: null, supersedes: null, computed_at: "2026-09-01T00:00:00Z", invalidated_by_event: 7 },
    { value_id: "v2", entity_id: ENT, method_id: "m", method_version: "2", value: 12.5, unit: "EUR", currency: null, supersedes: "v1", computed_at: "2026-10-10T00:00:00Z", invalidated_by_event: null },
  ]);
  db.views.recalculation_events = () => [{ event_id: 7, occurred_at: "2026-10-10T00:00:00Z", table_name: "market_series", row_pk: "x", change_kind: "update" }];
  const client = clientFor(db as never, "member");
  const n = await readNotices(client, ORG_A, NOW);
  assert.equal(n.since, "2026-09-15T12:00:00.000Z", "a fixed 30-day window from the request's one instant");
  assert.deepEqual(n.notices.map((x) => [x.entityLabel, x.oldValue, x.newValue]), [["FuelEU Maritime", 10, 12.5]]);
  db.rows("derived_values").forEach((v) => (v.computed_at = "2026-01-01T00:00:00Z"));
  assert.deepEqual((await readNotices(client, ORG_A, NOW)).notices, []);
  db.fail("org_watchlist", "select", "down");
  await assert.rejects(readNotices(client, ORG_A, NOW), /org_watchlist read failed: down/);
});

const reply = (body: unknown, ok = true) => (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 503 })) as never;

test("the membership store keeps only a SUCCESSFUL read: a failed one leaves the control disabled and is read again by the next toggle (the old cache pinned 'unwatched')", async () => {
  resetMembership();
  await loadMembership("reg", reply({}, false));
  assert.equal(membershipOf("reg")?.status, "failed");
  await loadMembership("reg", reply({ watchedIds: ["o3"], teamWatchedIds: [], teamAvailable: true }));
  assert.deepEqual([membershipOf("reg")?.status, membershipOf("reg")?.watched, membershipOf("reg")?.teamAvailable], ["ready", ["o3"], true]);
  let calls = 0;
  await loadMembership("reg", (async () => (calls += 1, new Response("{}")) ) as never);
  assert.equal(calls, 0, "a loaded type is not read again");
  assert.equal(typeof useWatchMembership, "function");
});

test("setWatch flips optimistically and REVERTS when the route refuses; a network failure reverts too", async () => {
  resetMembership();
  await loadMembership("reg", reply({ watchedIds: [], teamWatchedIds: [], teamAvailable: true }));
  const seen: string[] = [];
  const ok = (async (url: string, init?: RequestInit) => (seen.push(`${init?.method} ${url}`), new Response("{}"))) as never;
  assert.equal(await setWatch("reg", "o4", "personal", true, ok), true);
  assert.deepEqual(membershipOf("reg")?.watched, ["o4"]);
  assert.equal(await setWatch("reg", "o4", "personal", false, ok), true);
  assert.deepEqual(membershipOf("reg")?.watched, []);
  assert.deepEqual(seen, ["POST /api/watchlist", "DELETE /api/watchlist?item_type=reg&item_id=o4&scope=personal"]);
  assert.equal(await setWatch("reg", "o5", "team", true, reply({}, false)), false);
  assert.deepEqual(membershipOf("reg")?.team, [], "the refused team watch was put back");
  assert.equal(await setWatch("reg", "o5", "personal", true, (async () => { throw new Error("offline"); }) as never), false);
  assert.deepEqual(membershipOf("reg")?.watched, []);
});
