// INV-CN2-7 (CONNECT-2): no detector runs over a table nothing feeds. Every table the detectors join (a fact spec) has a producer in the turn that fills it: a producer of the registry that the propagate stage runs, or code outside this slice that
// inserts or upserts into it from a runtime a turn stage calls (the connection check, `npm run connections`, fails an uncalled runtime). A table with neither fails here, naming it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";

import { FACT_SPECS } from "@/core/flywheel/patterns/config";

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const outside = files("src").map((f) => f.split(sep).join("/")).filter((f) => /\.tsx?$/.test(f) && !/^src\/core\/(coupling|flywheel\/patterns)\//.test(f));
const registry = new Set((JSON.parse(readFileSync("src/core/producers/data/registry.json", "utf8")) as { domain_table: string }[]).map((e) => e.domain_table));
const writes = (table: string): string[] => outside.filter((f) => new RegExp(`from\\("${table}"\\)[\\s\\S]{0,500}?\\.(insert|upsert)\\(`).test(readFileSync(f, "utf8")));

test("INV-CN2-7: every table a detector joins has a producer in the turn", () => {
  const tables = Object.entries(FACT_SPECS).map(([t, s]) => s.edge ?? t).filter((t) => t !== "derived_values");
  assert.ok(tables.length >= 9);
  const unfed = tables.filter((t) => !registry.has(t) && writes(t).length === 0);
  assert.deepEqual(unfed, []);
  // the one derived table the detectors read is fed by the propagation methods and the register function
  assert.ok(writes("derived_values").length + outside.filter((f) => /registerDerivedValue|authorDerivedValue/.test(readFileSync(f, "utf8"))).length > 0);
  // and a table with no producer is found: a planted name
  assert.equal(writes("no_such_table_feeds_this").length + (registry.has("no_such_table_feeds_this") ? 1 : 0), 0);
});
