// Generates tests/_support/schema.json (every public table and view with its columns, the columns the database fills with a uuid default, and single-column foreign keys) from the LIVE catalog of the database the schema job builds, so the in-memory
// test client refuses a table or column the database does not have (IMP-031). scripts/ci/schema-apply.mjs fails when the committed file differs from the live catalog.
// Run after the schema changes, against a database that has had schema-apply run on it: DATABASE_URL=... node scripts/gen/test-schema.mjs
import { spawnSync } from "node:child_process";

import { writeJsonData } from "./json-data.mjs";

export const COLUMNS_SQL = "select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position";
export const UUID_DEFAULTS_SQL = "select table_name, column_name from information_schema.columns where table_schema = 'public' and (column_default ilike '%gen_random_uuid%' or column_default ilike '%uuid_generate%') order by table_name, ordinal_position";
export const DEFAULTS_SQL = "select table_name, column_name, column_default from information_schema.columns where table_schema = 'public' and column_default is not null and column_default not ilike '%uuid%' order by table_name, ordinal_position";
export const FKS_SQL = `select (select relname from pg_class where oid = c.conrelid), a.attname, (select relname from pg_class where oid = c.confrelid), af.attname
  from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1] join pg_attribute af on af.attrelid = c.confrelid and af.attnum = c.confkey[1]
  where c.contype = 'f' and array_length(c.conkey, 1) = 1 and c.connamespace = 'public'::regnamespace order by 1, 2, 3`;

/** A column default as a plain value, or undefined when it is an expression the test client does not model. now() and CURRENT_DATE are the tokens __now and __today. */
export function literalDefault(text) {
  if (text === "now()") return "__now";
  if (text === "CURRENT_DATE") return "__today";
  if (text === "true" || text === "false") return text === "true";
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (/^'\{\}'::(text|uuid)\[\]$/.test(text) || text === "'[]'::jsonb") return [];
  if (text === "'{}'::jsonb") return {};
  const m = /^'((?:[^']|'')*)'::(?:text|character varying)$/.exec(text);
  return m ? m[1].replace(/''/g, "'") : undefined;
}

function rows(url, sql) {
  const r = spawnSync("psql", [url, "-X", "-q", "-At", "-c", sql], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`psql failed: ${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => l.split("|"));
}

/** The schema document from a live database. */
export function readSchema(url) {
  const tables = {};
  for (const [t, c] of rows(url, COLUMNS_SQL)) (tables[t] ??= { columns: [], uuid: [], defaults: {}, fks: [] }).columns.push(c);
  for (const [t, c] of rows(url, UUID_DEFAULTS_SQL)) tables[t]?.uuid.push(c);
  for (const [t, c, text] of rows(url, DEFAULTS_SQL)) {
    const v = literalDefault(text);
    if (v !== undefined && tables[t]) tables[t].defaults[c] = v;
  }
  for (const [t, column, table, ref] of rows(url, FKS_SQL)) tables[t]?.fks.push({ column, table, ref });
  return { tables: Object.fromEntries(Object.entries(tables).sort(([a], [b]) => a.localeCompare(b))) };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("test-schema.mjs")) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  const doc = readSchema(process.env.DATABASE_URL);
  writeJsonData("tests/_support/schema.json", doc);
  console.log(`${Object.keys(doc.tables).length} tables and views`);
}
