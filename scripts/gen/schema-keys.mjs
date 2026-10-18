// Generates src/core/db/schema-keys.json (primary-key columns per table) from supabase/schema.sql, then the forward migrations in
// name order (a migration that adds a primary key overrides the baseline's; one that drops a table takes its key with it). scripts/ci/schema-apply.mjs checks the file against the live catalog,
// and tests/core/db.test.ts checks it against schemaKeys() below, the one definition.
// Run once after the schema changes: node scripts/gen/schema-keys.mjs
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { writeJsonData } from "./json-data.mjs";

/** The primary-key columns per table, sorted by table name. */
export function schemaKeys() {
  const keys = {};
  const read = (text, re) => {
    for (const [, table, cols] of text.matchAll(re)) keys[table] = cols.split(",").map((c) => c.trim().replace(/"/g, ""));
  };
  read(readFileSync("supabase/schema.sql", "utf8"), /ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT \w+ PRIMARY KEY \(([^)]+)\);/g);
  for (const f of readdirSync("supabase/migrations").filter((x) => /^\d{4}_.+\.sql$/.test(x) && !x.includes("_data_")).sort()) {
    const text = readFileSync(`supabase/migrations/${f}`, "utf8");
    read(text, /ALTER TABLE (?:ONLY )?public\.(\w+)[^;]*?ADD CONSTRAINT \w+ PRIMARY KEY \(([^)]+)\)/g);
    for (const [, table] of text.matchAll(/^DROP TABLE public\.(\w+);/gm)) delete keys[table];
  }
  return Object.fromEntries(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sorted = schemaKeys();
  writeJsonData("src/core/db/schema-keys.json", sorted);
  console.log(`${Object.keys(sorted).length} tables with a primary key`);
}
