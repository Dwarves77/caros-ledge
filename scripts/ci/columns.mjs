// The column check (IMP-070): every `.select("...")` list and every filter or order column in src, on a `.from("table")` chain, names a column the database defines for that table or view; after `.rpc("fn")` it names a
// column of the function's RETURNS TABLE. The in-memory test client cannot catch this for a query a test never runs (a select of `effective_priority` from intelligence_items passed every test and would have failed on the live
// site), so the source is read here. The database's columns are tests/_support/schema.json (the live catalog after schema.sql and every migration; the schema job fails when it differs from the catalog, so it IS the
// database's definition) and the functions' RETURNS TABLE lists in supabase/schema.sql and the migrations. What it reads: a chain of calls after the `.from`, a select or column argument that is a string literal or an
// identifier bound to a string literal in the same file. What it skips, by design: an embedded relation `rel(cols)`, a star, a cast, a json path, a template string with a hole, a chain broken across statements.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FILTERS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "contains", "overlaps", "not", "order"]);
const posix = (p) => p.split("\\").join("/");

/** Table and view columns from the generated catalog file, and function output columns from the SQL text. */
export function loadSchema({ catalog = "tests/_support/schema.json", sqlFiles = ["supabase/schema.sql", ...readdirSync("supabase/migrations").map((f) => `supabase/migrations/${f}`)] } = {}) {
  const tables = new Map(Object.entries(JSON.parse(readFileSync(catalog, "utf8")).tables).map(([t, v]) => [t, new Set(v.columns)]));
  const fns = new Map();
  for (const f of sqlFiles) {
    const sql = readFileSync(f, "utf8");
    for (const m of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?(\w+)\s*\(/gi)) {
      const argsEnd = closeOf(sql, m.index + m[0].length - 1);
      const ret = argsEnd < 0 ? null : /^\s*RETURNS\s+TABLE\s*\(/i.exec(sql.slice(argsEnd, argsEnd + 40));
      if (!ret) continue;
      const open = argsEnd + ret[0].length - 1;
      const list = sql.slice(open + 1, closeOf(sql, open) - 1);
      fns.set(m[1], new Set(splitTop(list).map((c) => c.trim().split(/\s+/)[0].replace(/"/g, "")).filter(Boolean)));
    }
  }
  return { tables, fns };
}

/** A comma list split at the top level only (a type such as numeric(10,2) keeps its comma). */
function splitTop(list) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  return [...parts, cur];
}

/** The index just past the balanced `(...)` that opens at `open`, skipping strings and template literals; -1 when unbalanced. */
function closeOf(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i += 1; i < text.length && text[i] !== c; i += 1) if (text[i] === "\\") i += 1;
    } else if (c === "(") depth += 1;
    else if (c === ")" && (depth -= 1) === 0) return i + 1;
  }
  return -1;
}

/** The first string-literal argument of a call's raw arguments (a literal, or an identifier bound to a literal in this file), or null. */
function firstString(args, consts) {
  const lit = /^\s*(["'])((?:\\.|(?!\1).)*)\1/.exec(args);
  if (lit) return lit[2];
  if (/^\s*[`]/.test(args)) return /^\s*`([^`$]*)`/.exec(args)?.[1] ?? null;
  const id = /^\s*([A-Za-z_]\w*)\s*(?:[,)]|$)/.exec(args);
  return id ? (consts.get(id[1]) ?? null) : null;
}

/** The plain columns a select list names: aliases stripped; relations, stars, casts, json paths and counts skipped. */
export function selectColumns(list) {
  const out = [];
  let depth = 0;
  let token = "";
  const flush = () => {
    const t = token.trim();
    token = "";
    const bare = (t.includes(":") && !t.includes("::") ? t.split(":").slice(1).join(":") : t).trim();
    if (bare && !/[()*!.]|::|->/.test(bare)) out.push(bare);
  };
  for (const ch of list) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) flush();
    else token += ch;
  }
  flush();
  return out;
}

/** Every column violation in one source text. `schema` is loadSchema()'s result. Returns `{ line, message }` rows. */
export function checkSource(text, schema) {
  const consts = new Map();
  for (const m of text.matchAll(/^\s*(?:export\s+)?const\s+([A-Za-z_]\w*)\s*(?::\s*string\s*)?=\s*(["'])((?:\\.|(?!\2).)*)\2\s*;?\s*$/gm)) consts.set(m[1], m[3]);
  const problems = [];
  const lineOf = (i) => text.slice(0, i).split("\n").length;
  for (const m of text.matchAll(/\.(from|rpc)\(\s*(["'])([A-Za-z_]\w*)\2/g)) {
    const [kind, name] = [m[1], m[3]];
    const known = kind === "from" ? schema.tables.get(name) : schema.fns.get(name);
    if (kind === "from" && !known) {
      problems.push({ line: lineOf(m.index), message: `.from("${name}") names a table or view the database does not define` });
      continue;
    }
    let i = m.index + m[0].length;
    const open = text.indexOf("(", m.index + 1 + kind.length);
    i = closeOf(text, open);
    for (;;) {
      const next = /^\s*\.\s*([A-Za-z_]\w*)\s*(<[^>(]*>)?\s*\(/.exec(text.slice(i));
      if (!next) {
        // A wrapper such as qb<Row>(db.from("t")...): the chain continues after the wrapper's own parenthesis.
        const wrap = /^\s*\)/.exec(text.slice(i));
        if (wrap && /\bqb\s*(<[^>(]*>)?\s*\(\s*[\w.]*$/.test(text.slice(Math.max(0, m.index - 80), m.index))) {
          i += wrap[0].length;
          continue;
        }
        break;
      }
      const method = next[1];
      const argsOpen = i + next[0].length - 1;
      const end = closeOf(text, argsOpen);
      if (end < 0) break;
      const args = text.slice(argsOpen + 1, end - 1);
      const at = lineOf(argsOpen);
      if (known && method === "select") {
        const list = firstString(args, consts);
        if (list !== null) for (const c of selectColumns(list)) if (!known.has(c)) problems.push({ line: at, message: `${kind === "from" ? `table "${name}"` : `function "${name}"`} has no column "${c}" (select)` });
      } else if (known && FILTERS.has(method)) {
        const col = firstString(args, consts);
        if (col !== null && !/[.>(]/.test(col) && col !== "" && !known.has(col)) problems.push({ line: at, message: `${kind === "from" ? `table "${name}"` : `function "${name}"`} has no column "${col}" (${method})` });
      }
      i = end;
    }
  }
  return problems;
}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [posix(join(dir, e.name))] : []));

/** Run over a source tree. Returns the problems as `file:line: message`. */
export function checkTree(root = "src", schema = loadSchema()) {
  return walk(root).flatMap((f) => checkSource(readFileSync(f, "utf8"), schema).map((p) => `${f}:${p.line}: ${p.message}`));
}

if (process.argv[1] && posix(process.argv[1]).endsWith("scripts/ci/columns.mjs")) {
  const problems = checkTree();
  for (const p of problems.slice(0, 20)) console.error(p);
  if (problems.length > 20) console.error(`... and ${problems.length - 20} more`);
  console.log(problems.length ? `columns: ${problems.length} problem(s)` : "columns: clean");
  process.exit(problems.length ? 1 : 0);
}
