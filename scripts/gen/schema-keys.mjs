// Generates src/core/db/schema-keys.json (primary-key columns per table) from supabase/schema.sql.
// Run once after the schema changes: node scripts/gen/schema-keys.mjs
import { readFileSync, writeFileSync } from "node:fs";

const sql = readFileSync("supabase/schema.sql", "utf8");
const keys = {};
const re = /ALTER TABLE ONLY public\.(\w+)\s+ADD CONSTRAINT \w+ PRIMARY KEY \(([^)]+)\);/g;
for (const [, table, cols] of sql.matchAll(re)) keys[table] = cols.split(",").map((c) => c.trim().replace(/"/g, ""));
const sorted = Object.fromEntries(Object.entries(keys).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync("src/core/db/schema-keys.json", `${JSON.stringify(sorted, null, 1)}\n`);
console.log(`${Object.keys(sorted).length} tables with a primary key`);
