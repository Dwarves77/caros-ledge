// MemDb conformance (G11, K:83): the one in-memory database every test runs over (tests/_support/memdb.ts) must answer a filter the way the applied database does. A double that returns more than the real one hid
// 0040 (a read that returned a member nothing) and every read past the server's 1000-row cut. Each case below runs one filter on the same rows in MemDb and as the SQL the filter becomes, on the schema job's database,
// and the two answers must be equal; the cut is checked against `LIMIT 1000` (Supabase's default max_rows), ranged reads included. Two filters MemDb refuses outright, because PostgREST turns them into a comparison
// with the text "null": `.eq(c, null)` and `.neq(c, null)`.
// Run by scripts/ci/schema-apply.mjs after the migrations (through tests/_support/register.mjs, which resolves "@/" and loads the .ts double). Exit 1 on a difference or a missing DATABASE_URL where the event could
// carry one; exit 2 only where nothing was promised (src/core/harness/exit.ts).
import { psql } from "../psql.mjs";

const url = process.env.DATABASE_URL;
const { skipVerdict } = await import("@/core/harness/exit");
const verdict = skipVerdict(process.env, url ? [] : ["DATABASE_URL"]);
if (verdict.message) {
  console.error(`memdb-conformance: ${verdict.message}`);
  process.exit(verdict.exit);
}
const { MemDb } = await import("../../../tests/_support/memdb.ts");

const ROWS = [
  { id: 1, v: "a", n: 1 },
  { id: 2, v: "b", n: 2 },
  { id: 3, v: null, n: null },
  { id: 4, v: "A", n: 3 },
  { id: 5, v: "ab", n: 2 },
];
const SQL_ROWS = `(VALUES (1, 'a', 1), (2, 'b', 2), (3, NULL, NULL), (4, 'A', 3), (5, 'ab', 2)) AS t(id, v, n)`;

/** [name, the filter applied to a MemDb query, the SQL condition the filter becomes]. */
const CASES = [
  ["eq", (q) => q.eq("v", "a"), "v = 'a'"],
  ["neq leaves out the NULL row", (q) => q.neq("v", "a"), "v <> 'a'"],
  ["gt leaves out the NULL row", (q) => q.gt("n", 1), "n > 1"],
  ["gte", (q) => q.gte("n", 2), "n >= 2"],
  ["lt leaves out the NULL row", (q) => q.lt("n", 3), "n < 3"],
  ["lte", (q) => q.lte("n", 2), "n <= 2"],
  ["in never matches NULL, even when the list holds one", (q) => q.in("v", ["a", null]), "v IN ('a', NULL)"],
  ["is null", (q) => q.is("v", null), "v IS NULL"],
  ["not is null", (q) => q.not("v", "is", null), "v IS NOT NULL"],
  ["like is case sensitive", (q) => q.like("v", "a%"), "v LIKE 'a%'"],
  ["ilike is not", (q) => q.ilike("v", "a%"), "v ILIKE 'a%'"],
  ["or: eq and is null", (q) => q.or("v.eq.a,v.is.null"), "v = 'a' OR v IS NULL"],
  ["or: neq leaves out the NULL row", (q) => q.or("v.neq.a,n.eq.1"), "v <> 'a' OR n = 1"],
];

const problems = [];
const ids = (rows) => rows.map((r) => Number(r.id)).sort((a, b) => a - b);
const fromSql = (text) => {
  const r = psql(url, { sql: `BEGIN;\n${text}\nROLLBACK;\n`, tuples: true });
  if (r.status !== 0) throw new Error(`memdb-conformance: SQL failed\n${r.stderr}`);
  return r.stdout.split("\n").filter(Boolean).map((l) => Number(l));
};

for (const [name, apply, where] of CASES) {
  const mem = new MemDb({ schema: null }, { t: ROWS });
  const { data, error } = await apply(mem.from("t").select("id"));
  const got = error ? [`error: ${error.message}`] : ids(data);
  const want = fromSql(`SELECT id FROM ${SQL_ROWS} WHERE ${where} ORDER BY id;`);
  if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`MemDb answers "${name}" with ${JSON.stringify(got)}; the database answers ${JSON.stringify(want)} (WHERE ${where})`);
}

for (const [name, call] of [["eq", (q) => q.eq("v", null)], ["neq", (q) => q.neq("v", null)]]) {
  let message = "";
  try {
    call(new MemDb({ schema: null }, { t: ROWS }).from("t"));
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  if (!/not IS (NOT )?NULL/.test(message)) problems.push(`MemDb accepts .${name}(column, null), which the database reads as a comparison with the text "null" (it must refuse and name .is / .not)`);
}

// The server's cut: 1500 rows, an unranged select, a limit above the cut and a ranged select past it each return 1000, as `LIMIT 1000` does.
const many = new MemDb({ schema: null }, { t: Array.from({ length: 1500 }, (_, i) => ({ id: i + 1 })) });
const wantCut = fromSql("SELECT id FROM generate_series(1, 1500) AS id ORDER BY id LIMIT 1000;").length;
for (const [name, query] of [["an unranged select", many.from("t").select("id")], ["limit(5000)", many.from("t").select("id").limit(5000)], ["range(0, 1499)", many.from("t").select("id").range(0, 1499)]]) {
  const { data } = await query;
  if (data.length !== wantCut) problems.push(`MemDb returns ${data.length} rows for ${name}; the server returns ${wantCut} (max_rows)`);
}
const { count } = await many.from("t").select("id", { count: "exact", head: true });
if (count !== 1500) problems.push(`MemDb counts ${count} rows for an exact head count; the server counts all 1500 (the cut does not apply to a count)`);

for (const p of problems) console.error(`memdb-conformance: ${p}`);
console.log(problems.length ? `memdb-conformance: ${problems.length} difference(s)` : `memdb-conformance: ${CASES.length} filters, the two refused nulls and the 1000-row cut agree with the database`);
process.exit(problems.length ? 1 : 0);
