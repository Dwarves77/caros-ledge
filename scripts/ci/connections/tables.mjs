// Who writes and who reads each table, from the syntax tree and the SQL, for the connection check (rule 17: nothing runs alone; a surface reader reads only what the machine writes).
//   writers: a `.from("t")` chain ending in insert, update, upsert or delete (src, scripts and the Edge Function); a call to a table-name helper (`write("t", ...)`, an object property `table: "t"`); an `.rpc("f")` whose SQL
//            function writes t; a trigger function that writes t; a top-level `INSERT INTO public.t` (a seed) in the schema or a migration; the Edge Function's own `record(deps, "t", "insert", ...)`.
//   readers: the `.from("t")` chains of the surface readers (src/features/<module>/(read|server|queries)/).
// A view is written when a table it selects from is. Nothing here is a hand list: a table written by a path this does not see must be waived by name (connections-allow.json) with the reason.
import ts from "typescript";

import { dbCallsOf } from "../db-calls.mjs";

const HELPER = /^(write|insert|upsert|update|persist|save|append|put|record)\w*$/i;

/** Tables named as the first argument of a write helper, or as a `table:` property, in one file. */
function helperWrites(path, text, known) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = new Set();
  const visit = (n) => {
    if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && known.has(n.arguments[0].text)) {
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : "";
      if (HELPER.test(callee)) out.add(n.arguments[0].text);
    }
    if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "table" && ts.isStringLiteral(n.initializer) && known.has(n.initializer.text)) out.add(n.initializer.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** SQL function name -> the tables its body writes (INSERT INTO, UPDATE, DELETE FROM), over the schema and migration texts. */
export function sqlFunctionWrites(sqlTexts, known) {
  const fns = new Map();
  for (const sql of sqlTexts) {
    for (const m of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?(\w+)\s*\([\s\S]*?\$(\w*)\$([\s\S]*?)\$\2\$/gi)) {
      const set = fns.get(m[1]) ?? new Set();
      for (const w of m[3].matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?(\w+)/gi)) if (known.has(w[1].toLowerCase())) set.add(w[1].toLowerCase());
      fns.set(m[1], set);
    }
  }
  return fns;
}

/** Trigger function names over the SQL texts. */
export const triggerFunctions = (sqlTexts) => new Set(sqlTexts.flatMap((sql) => [...sql.matchAll(/CREATE (?:OR REPLACE )?(?:CONSTRAINT )?TRIGGER[\s\S]*?EXECUTE (?:FUNCTION|PROCEDURE) (?:public\.)?(\w+)\s*\(/gi)].map((m) => m[1])));

/** View name -> the tables it selects from. */
export function viewSources(sqlTexts, known) {
  const views = new Map();
  for (const sql of sqlTexts) {
    for (const m of sql.matchAll(/CREATE (?:OR REPLACE )?VIEW (?:public\.)?(\w+)[\s\S]*?(?=;\s*(?:\n|$))/gi)) {
      const from = new Set([...m[0].matchAll(/\b(?:FROM|JOIN)\s+(?:public\.)?(\w+)/gi)].map((x) => x[1].toLowerCase()).filter((t) => t !== m[1].toLowerCase() && known.has(t)));
      views.set(m[1], from);
    }
  }
  return views;
}

/**
 * The writers of every table: Map table -> array of descriptions. `sources` is { src: Map(path -> text), other: Map(path -> text) for scripts and the Edge Function }, `known` the table and view names.
 */
export function tableWriters({ src, other, sqlTexts, known, rpcCalled }) {
  const writers = new Map();
  const add = (t, why) => writers.set(t, [...(writers.get(t) ?? []), why]);
  for (const [path, text] of [...src, ...other]) {
    for (const c of dbCallsOf(path, text)) if (c.kind === "from" && c.writes.length) add(c.name, `${path}:${c.line}`);
    for (const t of helperWrites(path, text, known)) add(t, `${path} (a write helper)`);
    for (const m of text.matchAll(/\brecord\(\s*\w+,\s*"(\w+)",\s*"(?:insert|update|upsert)"/g)) if (known.has(m[1])) add(m[1], `${path} (record)`);
  }
  const functions = sqlFunctionWrites(sqlTexts, known);
  const triggers = triggerFunctions(sqlTexts);
  for (const [fn, tables] of functions) for (const t of tables) if (rpcCalled.has(fn) || triggers.has(fn)) add(t, `${triggers.has(fn) ? "trigger function" : "rpc"} ${fn}`);
  for (const sql of sqlTexts) for (const m of sql.matchAll(/^\s*INSERT\s+INTO\s+(?:public\.)?(\w+)/gim)) if (known.has(m[1].toLowerCase())) add(m[1].toLowerCase(), "a seed in the schema or a migration");
  for (const [view, from] of viewSources(sqlTexts, known)) if ([...from].some((t) => writers.has(t))) add(view, `a view over ${[...from].join(", ")}`);
  return writers;
}

/** Tables a surface reader reads: Map table -> array of `file:line`. */
export function readerReads(src, isReader) {
  const reads = new Map();
  for (const [path, text] of src) {
    if (!isReader(path)) continue;
    for (const c of dbCallsOf(path, text)) if (c.kind === "from") reads.set(c.name, [...(reads.get(c.name) ?? []), `${path}:${c.line}`]);
  }
  return reads;
}

/** Every `.rpc("name")` called in the given texts. */
export function rpcNames(texts) {
  return new Set([...texts].flatMap(([path, text]) => dbCallsOf(path, text).filter((c) => c.kind === "rpc").map((c) => c.name)));
}
