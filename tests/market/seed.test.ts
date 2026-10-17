import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { loadSeriesItemMap, SERIES_ITEM_MAP } from "@/features/market/producers/published-price-statistics";

const MIGRATIONS = "supabase/migrations";
const file = (re: RegExp): string => readFileSync(`${MIGRATIONS}/${readdirSync(MIGRATIONS).find((f) => re.test(f)) as string}`, "utf8");

test("0030 seeds exactly the ratified entries of the series map the producers read (the table and the producers' map cannot drift)", () => {
  const sql = file(/^\d{4}_data_market_series_items\.sql$/);
  const seeded = [...sql.matchAll(/^\('([^']+)', '([0-9a-f-]{36})'\)[,;]$/gm)].map((m) => [m[1], m[2]]);
  const ratified = SERIES_ITEM_MAP.filter(([, e]) => e.status === "ratified" && e.item_id).map(([k, e]) => [k, e.item_id]);
  assert.deepEqual(seeded, ratified);
  assert.equal(seeded.length, 6);
  assert.match(sql, /ON CONFLICT \(series_key\) DO NOTHING/);
  assert.match(sql, /^-- rollback-test: scripts\/ci\/fixtures\/data-0030-items\.sql$/m);
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
