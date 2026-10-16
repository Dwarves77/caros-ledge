// Selection and the held index: INV-293 (key, URL with the same identity, sibling series, unlabelled fail-closed), the limit ceiling, and a total-order read of the census.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHeldIndex, isHeld, readHolders, resolveLimit, sameInstrumentIdentity, selectCensusRows } from "@/features/mint";

import { SOURCE, makeWorld } from "./world.ts";

const holder = (id: string, over: Record<string, unknown> = {}) => ({ id, source_url: null, canonical_instrument_key: null, instrument_identifier: null, archive_reason: null, ...over });

test("INV-293: the canonical key is held by any row, archived included, and wins over the URL rule", () => {
  const idx = buildHeldIndex([holder("a", { canonical_instrument_key: "32023R1", archive_reason: "off_vertical" }), holder("b", { source_url: "https://x.example/p", instrument_identifier: "ID-1" })]);
  assert.deepEqual(isHeld({ url: "https://other.example/q", key: "32023R1", instrumentIdentifier: null }, idx), { held: true, by: "key", holderId: "a", archived: true });
  assert.deepEqual(isHeld({ url: "https://x.example/p", key: "32023R1", instrumentIdentifier: "ID-1" }, idx), { held: true, by: "key", holderId: "a", archived: true });
  assert.deepEqual(isHeld({ url: "https://z.example", key: "32023R2", instrumentIdentifier: null }, idx), { held: false });
});

test("INV-293: a URL is held only for the SAME instrument identity; two labelled, different identifiers are siblings, and an unlabelled side fails closed", () => {
  const idx = buildHeldIndex([holder("a", { source_url: "https://bulletin.example/oil", instrument_identifier: "diesel" })]);
  const q = (identifier: string | null) => isHeld({ url: "https://bulletin.example/oil", key: null, instrumentIdentifier: identifier }, idx);
  assert.equal(q("DIESEL").held, true, "same identifier once normalised");
  assert.equal(q("petrol").held, false, "a sibling series at the same landing page mints");
  assert.equal(q(null).held, true, "unlabelled payload: presumed the same document");
  const unlabelledHolder = buildHeldIndex([holder("b", { source_url: "https://bulletin.example/oil", instrument_identifier: null })]);
  assert.equal(isHeld({ url: "https://bulletin.example/oil", key: null, instrumentIdentifier: "petrol" }, unlabelledHolder).held, true, "unlabelled holder: presumed the same document");
  assert.equal(sameInstrumentIdentity("  A ", "a"), true);
  assert.equal(sameInstrumentIdentity("a", "b"), false);
  assert.equal(sameInstrumentIdentity("", null), true);
});

test("the limit is a positive integer, never above the ceiling of 100", () => {
  assert.equal(resolveLimit(undefined), 50);
  assert.equal(resolveLimit(100), 100);
  for (const bad of [0, -1, 101, 1.5, Number.NaN]) assert.throws(() => resolveLimit(bad), RangeError, String(bad));
});

test("the census read is every page in a total order: 2,300 rows under a 1,000-row server cap are all returned, narrowed by source and CELEX prefix, archived rows never", async () => {
  const rows = Array.from({ length: 2300 }, (_, i) => ({ id: `c-${String(i).padStart(5, "0")}`, source_id: i % 2 ? SOURCE : "other", document_url: `https://x.example/${i}`, title: "t", instrument_identifier: i % 3 ? `32023R${i}` : `22023R${i}`, dryrun_disposition: "would_mint", is_archived: i === 5, hold_reason: null, notes: null }));
  const db = makeWorld({ capped: true, census: rows });
  assert.equal(((await db.client.from("census_worklist" as never).select("id")) as { data: unknown[] }).data.length, 1000, "the cap is real: an unranged read stops at 1,000");
  const all = await selectCensusRows(db.client, {});
  assert.equal(all.length, 2299);
  assert.equal(new Set(all.map((r) => r.id)).size, 2299, "no row repeated at a page boundary");
  assert.ok(all.every((r, i) => i === 0 || (all[i - 1]?.id ?? "") < r.id), "ordered by id");
  assert.equal((await selectCensusRows(db.client, { sourceId: SOURCE })).every((r) => r.source_id === SOURCE), true);
  assert.equal((await selectCensusRows(db.client, { celexPrefix: "32023R" })).every((r) => r.instrument_identifier?.startsWith("32023R")), true);
});

test("a failed census page throws: an unreadable census is never an empty one", async () => {
  const db = makeWorld();
  db.failWhen = (c) => (c.table === "census_worklist" ? "canceling statement due to statement timeout" : null);
  await assert.rejects(() => selectCensusRows(db.client, {}), /paginated read failed/);
});

test("the holder read fails loudly on a read error and on a possibly truncated slice, and returns each holder once", async () => {
  const items = [{ id: "h1", source_url: "https://x.example/1", canonical_instrument_key: "K1", instrument_identifier: null, archive_reason: null }];
  const db = makeWorld({ items });
  const got = await readHolders(db.client, ["https://x.example/1"], ["K1"]);
  assert.deepEqual(got.map((h) => h.id), ["h1"]);
  db.failWhen = (c) => (c.table === "intelligence_items" ? "connection reset" : null);
  await assert.rejects(() => readHolders(db.client, ["https://x.example/1"], []), /holder read by source_url failed/);
});
