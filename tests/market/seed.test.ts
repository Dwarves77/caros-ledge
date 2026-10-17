import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { isRatified, loadSeriesItemMap, readSeriesItemMap } from "@/features/market/producers/market-series-items";

import { memoryDb } from "../_support/memory-db.ts";

import { SEEDED_SERIES, WEEKLY } from "./series-rows.ts";

const MIGRATIONS = "supabase/migrations";
const file = (re: RegExp): string => readFileSync(`${MIGRATIONS}/${readdirSync(MIGRATIONS).find((f) => re.test(f)) as string}`, "utf8");

test("the table is the one home (IMP-084): 0030 seeds the six ratified attachments, 0045 their weekly cadence, and the producers' reader returns exactly those entries, entry for entry (the retired code-file pin cannot come back: there is no second list to drift)", async () => {
  const sql = file(/^\d{4}_data_market_series_items\.sql$/);
  assert.equal(SEEDED_SERIES.length, 6);
  assert.match(sql, /ON CONFLICT \(series_key\) DO NOTHING/);
  assert.match(sql, /^-- rollback-test: scripts\/ci\/fixtures\/data-0030-items\.sql$/m);
  assert.deepEqual([...WEEKLY].sort(), SEEDED_SERIES.map((r) => r.series_key as string).sort(), "0045 sets the cadence of exactly the six series 0030 attaches");
  const map = await readSeriesItemMap(memoryDb({ market_series_items: SEEDED_SERIES }).db);
  assert.deepEqual(map.map(([k, e]) => [k, e.item_id, e.status, e.cadence_days]), [...SEEDED_SERIES].sort((a, b) => String(a.series_key).localeCompare(String(b.series_key))).map((r) => [r.series_key, r.item_id, "ratified", 7]));
  assert.ok(map.every(([, e]) => isRatified(e)));
  assert.equal(existsSync("src/features/market/producers/data/series-item-map.json"), false, "the code file is gone");
});

test("the reader's degraded states: the table absent names the migrations, a failed read says so, a bound reached is refused, an entry outside the shape is refused", async () => {
  await assert.rejects(() => readSeriesItemMap(memoryDb({}, { failures: [{ table: "market_series_items", op: "select", message: "relation does not exist", code: "PGRST205" }] }).db), /market_series_items is absent \(migrations 0029, 0030, 0044 and 0045 are not applied\)/);
  await assert.rejects(() => readSeriesItemMap(memoryDb({}, { failures: [{ table: "market_series_items", op: "select", message: "reset" }] }).db), /market_series_items read failed: reset/);
  await assert.rejects(() => readSeriesItemMap(memoryDb({ market_series_items: Array.from({ length: 200 }, (_, i) => ({ series_key: `a:s${i}`, item_id: null, status: "pending" })) }).db), /reached its 200-row bound/);
  await assert.rejects(() => readSeriesItemMap(memoryDb({ market_series_items: [{ series_key: "a:b", item_id: "x", status: "ratified", severity_tone: "urgent" }] }).db));
});

test("0029 declares what the reader relies on: a ratified row has its item, a deleted item takes its attachment, only the service role writes", () => {
  const sql = file(/^\d{4}_market_series_items\.sql$/);
  assert.match(sql, /CHECK \(series_key ~ '\^\[a-z0-9\]\+\(\?:\[:_-\]\[a-z0-9\]\+\)\*\$'\)/);
  assert.match(sql, /CHECK \(status <> 'ratified' OR item_id IS NOT NULL\)/);
  assert.match(sql, /REFERENCES public\.intelligence_items\(id\) ON DELETE CASCADE/);
  assert.match(sql, /GRANT SELECT ON TABLE public\.market_series_items TO authenticated;/);
  assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO (authenticated|anon)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
});

test("the map loader still refuses an entry outside the shape (a reader of the table and the producers share one vocabulary)", () => {
  assert.throws(() => loadSeriesItemMap({ "a:b": { item_id: "x", status: "ratified", surprise: 1 } }));
  assert.equal(loadSeriesItemMap({ "a:b": { item_id: null, status: "pending" } }).length, 1);
});
