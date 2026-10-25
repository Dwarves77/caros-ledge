// entity_refs.ref_table is a closed list in the database (CHECK entity_refs_ref_table_allowed). A producer that writes a table the list does not name dies at its first apply,
// on production, after its other writes have landed (arm-2 state-cost-facts, 2026-10-25). This reads every ref_table the code under src writes and asserts the CURRENT list
// (the last definition in the baseline and the migrations, in order) holds it, so the next producer that writes a new table fails CI instead.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(`${dir}/${n}`).isDirectory() ? walk(`${dir}/${n}`) : /\.tsx?$/.test(n) ? [`${dir}/${n}`] : []));

/** The tables the CHECK allows: the quoted names of the last definition, baseline first, then each migration in name order. */
function allowedRefTables(): string[] {
  const files = ["supabase/schema.sql", ...readdirSync("supabase/migrations").filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort().map((n) => `supabase/migrations/${n}`)];
  let list: string[] | null = null;
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/entity_refs_ref_table_allowed\s+CHECK\s*\(\s*\(?\s*ref_table\s*(?:=\s*ANY\s*\(\s*(?:ARRAY)?\s*\[|IN\s*\()([^\])]*)/g)) list = [...(m[1] as string).matchAll(/'([a-z_]+)'/g)].map((q) => q[1] as string);
  }
  assert.ok(list?.length, "no definition of entity_refs_ref_table_allowed found");
  return list;
}

/** Every literal table the code writes as a ref: planJurisdictionRefs("<table>", ...) and { ref_table: "<table>" }. */
function writtenRefTables(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of walk("src")) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/planJurisdictionRefs\(\s*"([a-z_]+)"|ref_table:\s*"([a-z_]+)"/g)) out.set((m[1] ?? m[2]) as string, f);
  }
  return out;
}

test("every table the code writes into entity_refs is on the database's allowed list", () => {
  const allowed = allowedRefTables();
  const written = writtenRefTables();
  assert.ok(written.size >= 3, "the scan found the known writers (intelligence_items, regions, state_cost_facts)");
  for (const [table, file] of written) assert.ok(allowed.includes(table), `${file} writes ref_table "${table}", which entity_refs_ref_table_allowed (${allowed.join(", ")}) refuses`);
});
