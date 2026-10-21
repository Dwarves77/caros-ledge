// COMM-1: Community is a social place, never a ledger surface. The rooms index draws no ledger item count (not on a tile, not in the masthead), a room tile's number is its discussion count (0 is "0", a failed read is
// said), and the ledger is read once, through the shared listing, for the two things it still feeds into Community: each room's topic words and the items a post can cite.
import assert from "node:assert/strict";
import { test } from "node:test";

import { RoomsPage } from "@/features/community/pages/Rooms";

import { renderApp, textOf } from "../_support/render.ts";
import { scripted } from "../_support/fake-clients.ts";

import { asClient, world, type World } from "./_world.ts";

const LEDGER_ITEMS = 38;
const seedLedger = (db: World) =>
  db.seed("intelligence_items", Array.from({ length: LEDGER_ITEMS - 1 }, (_, i) => ({ id: `aaaaaaaa-0000-4000-8000-${String(i + 100).padStart(12, "0")}`, title: `EU ledger item ${i}`, provenance_status: "verified", is_archived: false, jurisdiction_iso: ["EU"] })));
async function draw(db: World): Promise<{ html: string; text: string; tiles: string[] }> {
  scripted.user = () => asClient(db, "member");
  const html = renderApp((await RoomsPage()) as never, { path: "/community" });
  const tiles = [...html.matchAll(/<button\b[^>]*aria-pressed[^>]*>([\s\S]*?)<\/button>/g)].map((m) => textOf(m[1] ?? ""));
  return { html, text: textOf(html), tiles };
}

test("INV-COMM-1: the rooms index draws no ledger item count, with 38 ledger items in one room", async () => {
  const db = world();
  seedLedger(db);
  const { text, tiles } = await draw(db);
  assert.equal(db.rows("intelligence_items").filter((i) => i.provenance_status === "verified").length, LEDGER_ITEMS, "the fixture holds 38 verified ledger items, all in the EU room");
  assert.doesNotMatch(text, /\b38\b/, "the 38 ledger items are on no tile and in no sentence");
  assert.doesNotMatch(text, /active items?/i, "the masthead no longer sums the ledger");
  assert.match(text, /7 regional rooms · you are in 1 · peer signal is unverified until a verifier signs off/);
  assert.equal(tiles.length, 7);
});

test("INV-COMM-2: a room with no discussions draws 0, never a dash; its number is its discussion count", async () => {
  const { tiles } = await draw(world());
  const eu = tiles.find((t) => t.startsWith("EU room")) ?? "";
  const global = tiles.find((t) => t.startsWith("Global room")) ?? "";
  assert.match(eu, /^EU room 1 /, "the EU room holds one discussion in the world");
  assert.match(global, /^Global room 0 /, "no discussions is 0");
  assert.match(global, /no discussions yet/);
});

test("INV-COMM-2: a refused discussions read is said on the tile, never 0 and never 'no discussions yet'", async () => {
  const db = world();
  db.fail("community_posts", "select", "down");
  const { tiles } = await draw(db);
  const eu = tiles.find((t) => t.startsWith("EU room")) ?? "";
  assert.match(eu, /discussions could not be loaded/);
  assert.doesNotMatch(eu, /^EU room 0 |no discussions yet/);
});

test("INV-COMM-3: the rooms index reads the ledger once, through the shared listing, for topic words and citable items", async () => {
  const db = world();
  seedLedger(db);
  await draw(db);
  const listings = db.rpcLog.filter((r) => r.startsWith("get_workspace_intelligence_listings"));
  assert.equal(listings.length, 1, `one listing read, got ${listings.join(", ")}`);
  const itemReads = db.reads().filter((c) => c.table === "intelligence_items");
  assert.equal(itemReads.length, 1, "one intelligence_items read: the listing's own, none for counts and no legacy-id lookup");
  assert.ok(itemReads[0]?.filters.some((f) => f[0] === "in" && f[1] === "id"), "and it is the listing's read of the rows it returned");
});
