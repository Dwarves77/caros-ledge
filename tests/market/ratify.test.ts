// IMP-113: the ratification is a turn op that takes the mint artifact. The rule is ratifySeriesItemMap's (a series is attached only to the item whose mint reached minted_verified); the op adds the live-and-verified check on the
// item, the write to market_series_items, and the same-run call of the published-price-statistics producer (rule 17).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { FamilyCall } from "@/core/harness";
import { runOps } from "@/core/turn";
import { runResult } from "@/core/types/run-result";
import { ratifySeriesItems } from "@/features/market/producers/ratify-series";

import { fixture } from "../integration/world.ts";
import { memoryDb } from "../_support/memory-db.ts";

const ITEM = "4fae403a-ced5-4c8f-82b7-af0fd6127061";
const ITEM_2 = "5fae403a-ced5-4c8f-82b7-af0fd6127062";
const obs = (series_key: string) => ({ series_key, reference_period: "2026-10-12", label: "X", value_numeric: 1, unit: "EUR/t", currency: "EUR", as_at_date: "2026-10-12" });
const world = (extra: Record<string, Record<string, unknown>[]> = {}) =>
  memoryDb({
    market_series_items: [{ series_key: "a:held", item_id: null, status: "pending" }, { series_key: "a:done", item_id: ITEM_2, status: "ratified" }],
    market_series: [obs("a:held"), obs("a:fresh"), obs("a:done")],
    intelligence_items: [{ id: ITEM, provenance_status: "verified", is_archived: false }, { id: ITEM_2, provenance_status: "verified", is_archived: false }],
    ...extra,
  });
const calls: boolean[] = [];
const downstream = async (dry: boolean) => (calls.push(dry), runResult("ok", { parsed: 1 }, ["ran"]));
const art = (...per: Record<string, unknown>[]) => ({ per_item: per });

test("a minted_verified series is attached to its item and written ratified; the producer runs in the same firing; a series the table did not hold is attached when it has observations", async () => {
  calls.length = 0;
  const w = world();
  const r = await ratifySeriesItems({ sb: w.db, downstream }, { dry: false, artifact: art({ id: "a:held", outcome: "minted_verified", item_id: ITEM }, { id: "a:fresh", outcome: "minted_verified", item_id: ITEM_2 }) });
  assert.deepEqual([r.outcome, r.counts.ratified, r.counts.downstream_parsed, calls], ["ok", 2, 1, [false]]);
  assert.deepEqual(w.tables.market_series_items?.map((x) => [x.series_key, x.item_id, x.status]).sort(), [["a:done", ITEM_2, "ratified"], ["a:fresh", ITEM_2, "ratified"], ["a:held", ITEM, "ratified"]]);
});

test("nothing is ratified that should not be: an outcome other than minted_verified, an item that is not live and verified, a series with no observations, one already ratified, a missing item id; each is named and written nowhere", async () => {
  const w = world({ intelligence_items: [{ id: ITEM, provenance_status: "quarantined", is_archived: false }, { id: ITEM_2, provenance_status: "verified", is_archived: true }] });
  const r = await ratifySeriesItems({ sb: w.db, downstream }, { dry: false, artifact: art({ id: "a:held", outcome: "minted_unverified", item_id: ITEM }, { id: "a:fresh", outcome: "minted_verified", item_id: ITEM }, { id: "a:nothing", outcome: "minted_verified", item_id: ITEM }, { id: "a:done", outcome: "minted_verified", item_id: ITEM }, { id: "a:held", outcome: "minted_verified" }) });
  assert.equal(r.counts.ratified, 0);
  assert.equal(w.wrote("market_series_items").length, 0);
  const notes = r.notes.join("|");
  for (const re of [/a:held: skipped \((outcome_not_verified|already_ratified)\)/, /a:fresh: skipped \(item_not_live_verified\)/, /a:nothing: skipped \(no_observations_in_market_series\)/, /a:done: skipped \(already_ratified\)/]) assert.match(notes, re);
  const archived = world({ intelligence_items: [{ id: ITEM, provenance_status: "verified", is_archived: true }] });
  const r2 = await ratifySeriesItems({ sb: archived.db, downstream }, { dry: false, artifact: art({ id: "a:held", outcome: "minted_verified", item_id: ITEM }) });
  assert.match(r2.notes.join("|"), /a:held: skipped \(item_not_live_verified\)/, "an archived item is not live");
});

test("a dry run plans and writes nothing; a failed write is a partial run naming the series; the table absent or a malformed artifact is a failed run that writes nothing", async () => {
  const dry = world();
  const plan = await ratifySeriesItems({ sb: dry.db, downstream }, { dry: true, artifact: art({ id: "a:held", outcome: "minted_verified", item_id: ITEM }) });
  assert.deepEqual([plan.outcome, plan.counts.ratified, plan.counts.would_ratify, dry.wrote("market_series_items").length], ["ok", 0, 1, 0]);
  const down = world();
  down.mem.fail("market_series_items", "upsert", "write refused");
  const part = await ratifySeriesItems({ sb: down.db, downstream }, { dry: false, artifact: art({ id: "a:held", outcome: "minted_verified", item_id: ITEM }) });
  assert.deepEqual([part.outcome, part.counts.write_failures], ["partial", 1]);
  assert.match(part.notes.join("|"), /write failed: a:held: write refused/);
  const absent = memoryDb({}, { failures: [{ table: "market_series_items", op: "select", message: "relation does not exist", code: "PGRST205" }] });
  const none = await ratifySeriesItems({ sb: absent.db, downstream }, { dry: false, artifact: art({ id: "a:held", outcome: "minted_verified", item_id: ITEM }) });
  assert.equal(none.outcome, "failed");
  assert.match(none.notes.join("|"), /market_series_items is absent/);
  for (const bad of [undefined, {}, { per_item: [] }, art({ id: "Not A Key" })]) assert.equal((await ratifySeriesItems({ sb: world().db, downstream }, { dry: false, artifact: bad })).outcome, "failed");
});

test("the op is dispatched by name with the turn's deps: it ratifies from args.artifact and runs the published-price-statistics producer in the same firing; a missing artifact is refused", async () => {
  const f = fixture();
  f.db.seed("market_series_items", [{ series_key: "a:held", item_id: null, status: "pending" }]);
  f.db.seed("market_series", [obs("a:held")]);
  f.db.seed("intelligence_items", [{ id: ITEM, provenance_status: "verified", is_archived: false }]);
  const call: FamilyCall = { mode: "dry", dry: true, input: { ops: { op: "ratify-series-items", args: { artifact: art({ id: "a:held", outcome: "minted_verified", item_id: ITEM }) } } }, runId: "r0000000-0000-4000-8000-000000000001", rootRunId: "r0000000-0000-4000-8000-000000000001", upstream: null };
  const r = await runOps(call, f.d);
  assert.equal(r.notes[0], "op=ratify-series-items");
  assert.equal(r.counts.would_ratify, 1);
  assert.ok("downstream_parsed" in r.counts || r.notes.some((n) => n.startsWith("[published-price-statistics]")), "the producer ran in the same firing");
  assert.equal(f.db.rows("market_series_items")[0]?.status, "pending", "a dry run wrote nothing");
  const refused = await runOps({ ...call, input: { ops: { op: "ratify-series-items" } } }, f.d);
  assert.equal(refused.outcome, "failed");
});
