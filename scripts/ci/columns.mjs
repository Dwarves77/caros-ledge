// The column check (IMP-070): every database call in src names a table, column and function the database defines. Read from the syntax tree (scripts/ci/db-calls.mjs), for each `.from("table")` chain: the `select` list, every
// filter and order column (`eq`, `in`, `or("a.eq.1,b.is.null")`, `match({...})`), and the keys of an `insert`, `update` or `upsert` payload with the columns of its `onConflict`; for each `.rpc("function")`: that the function
// exists, that every argument key is one of its parameters, and that a `select` after it names a column of its RETURNS TABLE. The in-memory test client cannot catch this for a call a test never runs (a select of
// `effective_priority` from intelligence_items passed every test and would have failed on the live site), and a write to a column that does not exist is a 404 on the live site, so the source is read here. The database's
// columns are tests/_support/schema.json (the live catalog after schema.sql and every migration; the schema job fails when it differs from the catalog, so it IS the database's definition); the functions come from
// supabase/schema.sql and the migrations. What it skips, by design: an embedded relation `rel(cols)`, a star, a cast, a json path, a template string with a hole, a payload held in a variable, a chain broken across statements.
import { readdirSync, readFileSync } from "node:fs";

import { isMain, posix, walk } from "../lib/fs.mjs";

import { dbCallsOf } from "./db-calls.mjs";

/** Table and view columns from the generated catalog file, and function parameters and output columns from the SQL text. */
export function loadSchema({ catalog = "tests/_support/schema.json", sqlFiles = ["supabase/schema.sql", ...readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).map((f) => `supabase/migrations/${f}`)] } = {}) {
  const tables = new Map(Object.entries(JSON.parse(readFileSync(catalog, "utf8")).tables).map(([t, v]) => [t, new Set(v.columns)]));
  const fns = new Map(); // name -> { params: Set, outputs: Set | null }
  for (const f of sqlFiles) {
    const sql = readFileSync(f, "utf8");
    for (const m of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?(\w+)\s*\(/gi)) {
      const argsEnd = closeOf(sql, m.index + m[0].length - 1);
      if (argsEnd < 0) continue;
      const entry = fns.get(m[1]) ?? { params: new Set(), outputs: null };
      for (const part of splitTop(sql.slice(m.index + m[0].length, argsEnd - 1))) {
        const name = part.trim().replace(/^(IN|OUT|INOUT|VARIADIC)\s+/i, "").split(/\s+/)[0];
        if (name && /^[A-Za-z_]\w*$/.test(name) && part.trim().split(/\s+/).length > 1) entry.params.add(name);
      }
      const ret = /^\s*RETURNS\s+TABLE\s*\(/i.exec(sql.slice(argsEnd, argsEnd + 40));
      if (ret) {
        const open = argsEnd + ret[0].length - 1;
        entry.outputs = new Set(splitTop(sql.slice(open + 1, closeOf(sql, open) - 1)).map((c) => c.trim().split(/\s+/)[0].replace(/"/g, "")).filter(Boolean));
      }
      fns.set(m[1], entry);
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

/** The index just past the balanced `(...)` that opens at `open`, skipping strings; -1 when unbalanced. */
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

/** Every violation in one source text. `schema` is loadSchema()'s result. Returns `{ line, message }` rows. */
export function checkSource(text, schema, path = "x.ts", calls = dbCallsOf(path, text)) {
  const problems = [];
  for (const c of calls) {
    const add = (message, line = c.line) => problems.push({ line, message });
    if (c.kind === "rpc") {
      const fn = schema.fns.get(c.name);
      if (!fn) {
        add(`.rpc("${c.name}") names a function the database does not define`);
        continue;
      }
      for (const key of c.rpcArgs?.keys ?? []) if (!fn.params.has(key)) add(`function "${c.name}" has no parameter "${key}" (rpc arguments)`);
    }
    const known = c.kind === "from" ? schema.tables.get(c.name) : schema.fns.get(c.name)?.outputs;
    if (c.kind === "from" && !known) {
      add(`.from("${c.name}") names a table or view the database does not define`);
      continue;
    }
    if (!known) continue;
    const label = c.kind === "from" ? `table "${c.name}"` : `function "${c.name}"`;
    if (c.select !== null) for (const col of selectColumns(c.select)) if (!known.has(col)) add(`${label} has no column "${col}" (select)`, c.selectLine);
    for (const f of c.filters) if (!/[.>(]/.test(f.column) && f.column !== "" && !known.has(f.column)) add(`${label} has no column "${f.column}" (${f.method})`, f.line);
    if (c.kind === "from") {
      for (const w of c.writes) for (const key of w.keys) if (!known.has(key)) add(`${label} has no column "${key}" (${w.method})`, w.line);
      for (const { column, line } of c.onConflict) if (!known.has(column)) add(`${label} has no column "${column}" (onConflict)`, line);
    }
  }
  return problems.sort((a, b) => a.line - b.line);
}

/** Run over a source tree. Returns the problems as `file:line: message`. */
export function checkTree(root = "src", schema = loadSchema()) {
  let checked = 0;
  const problems = walk(root, (n) => /\.(ts|tsx)$/.test(n)).flatMap((f) => {
    const text = readFileSync(f, "utf8");
    const calls = dbCallsOf(f, text);
    checked += calls.length;
    return checkSource(text, schema, f, calls).map((p) => `${posix(f)}:${p.line}: ${p.message}`);
  });
  return checked ? problems : [...problems, `${root}: no database call was found to check (a check that read nothing certifies nothing)`];
}

if (isMain(import.meta.url)) {
  const problems = checkTree();
  for (const p of problems.slice(0, 40)) console.error(p);
  if (problems.length > 40) console.error(`... and ${problems.length - 40} more`);
  console.log(problems.length ? `columns: ${problems.length} problem(s)` : "columns: clean");
  process.exit(problems.length ? 1 : 0);
}
