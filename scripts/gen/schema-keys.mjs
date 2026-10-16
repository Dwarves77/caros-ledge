// Generates src/core/db/schema-keys.json (primary-key columns per table) from supabase/schema.sql, then the forward migrations in
// name order (a migration that adds a primary key overrides the baseline's). scripts/ci/schema-apply.mjs checks the file against the live catalog.
// Run once after the schema changes: node scripts/gen/schema-keys.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const keys = {};
const read = (text, re) => {
  for (const [, table, cols] of text.matchAll(re)) keys[table] = cols.split(",").map((c) => c.trim().replace(/"/g, ""));
};
read(readFileSync("supabase/schema.sql", "utf8"), /ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT \w+ PRIMARY KEY \(([^)]+)\);/g);
for (const f of readdirSync("supabase/migrations").filter((x) => /^\d{4}_.+\.sql$/.test(x) && !x.includes("_data_")).sort()) {
  read(readFileSync(`supabase/migrations/${f}`, "utf8"), /ALTER TABLE (?:ONLY )?public\.(\w+)[^;]*?ADD CONSTRAINT \w+ PRIMARY KEY \(([^)]+)\)/g);
}
const sorted = Object.fromEntries(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync("src/core/db/schema-keys.json", `${JSON.stringify(sorted, null, 1)}\n`);
console.log(`${Object.keys(sorted).length} tables with a primary key`);
