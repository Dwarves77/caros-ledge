// Generates tests/_support/schema.json (every public table and view with its columns, and single-column foreign keys) from the LIVE catalog of the database the schema job builds, so the in-memory
// test client refuses a table or column the database does not have (IMP-031). scripts/ci/schema-apply.mjs fails when the committed file differs from the live catalog.
// Run after the schema changes, against a database that has had schema-apply run on it: DATABASE_URL=... node scripts/gen/test-schema.mjs
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export const COLUMNS_SQL = "select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position";
export const FKS_SQL = `select (select relname from pg_class where oid = c.conrelid), a.attname, (select relname from pg_class where oid = c.confrelid), af.attname
  from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1] join pg_attribute af on af.attrelid = c.confrelid and af.attnum = c.confkey[1]
  where c.contype = 'f' and array_length(c.conkey, 1) = 1 and c.connamespace = 'public'::regnamespace order by 1, 2, 3`;

function rows(url, sql) {
  const r = spawnSync("psql", [url, "-X", "-q", "-At", "-c", sql], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => l.split("|"));
}

/** The schema document from a live database. */
export function readSchema(url) {
  const tables = {};
  for (const [t, c] of rows(url, COLUMNS_SQL)) (tables[t] ??= { columns: [], fks: [] }).columns.push(c);
  for (const [t, column, table, ref] of rows(url, FKS_SQL)) tables[t]?.fks.push({ column, table, ref });
  return { tables: Object.fromEntries(Object.entries(tables).sort(([a], [b]) => a.localeCompare(b))) };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("test-schema.mjs")) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const doc = readSchema(process.env.DATABASE_URL);
  writeFileSync("tests/_support/schema.json", `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`${Object.keys(doc.tables).length} tables and views`);
}
