// Read-only table export for the cutover window (P2-15): writes every row of one table, ordered by a key, to a JSON array, and prints the row count and the sha256 of the file. Two uses:
//   node scripts/cutover/export-table.mjs coverage_gap_census_findings            -> docs/archive/logs/<date>-coverage_gap_census_findings.json  (the export 0067 names before it drops the table)
//   node scripts/cutover/export-table.mjs sources --select id,name,url,source_role,source_type --out cutover-run/sources-export.json   (the input of the 0016 source backfill generator)
// Reads only. The credentials are the NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY of the environment; neither is ever printed. A file that already exists is not overwritten (--force says so); a read that
// fails stops the export, and a partial file is never written.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const PAGE = 1000;

/** Every row of `table` in key order, a page at a time. A failed page throws with the table named. */
export async function exportRows(db, table, { select = "*", order = "id" } = {}) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select(select).order(order, { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw new Error(`reading ${table} failed at row ${from}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) return rows;
  }
}

/** The file text for rows (stable, one trailing newline) and its sha256. */
export function renderExport(rows) {
  const text = `${JSON.stringify(rows, null, 2)}\n`;
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}

export async function runExport(db, argv, { today = new Date().toISOString().slice(0, 10), log = console.log } = {}) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { select: { type: "string" }, order: { type: "string" }, out: { type: "string" }, force: { type: "boolean" } } });
  const table = positionals[0];
  if (!table || !/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("usage: node scripts/cutover/export-table.mjs <table> [--select cols] [--order col] [--out file] [--force]");
  const out = values.out ?? `docs/archive/logs/${today}-${table}.json`;
  if (existsSync(out) && !values.force) throw new Error(`${out} exists: it is not overwritten (pass --force to replace it)`);
  const rows = await exportRows(db, table, { select: values.select ?? "*", order: values.order ?? "id" });
  const { text, sha256 } = renderExport(rows);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  log(`exported ${rows.length} row(s) of ${table} to ${out} sha256 ${sha256}`);
  return { rows: rows.length, out, sha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (read-only use)");
    process.exit(2);
  }
  const { createClient } = await import("@supabase/supabase-js");
  try {
    await runExport(createClient(url, key, { auth: { persistSession: false } }), process.argv.slice(2));
  } catch (e) {
    console.error(`export-table: ${e.message}`);
    process.exit(1);
  }
}
