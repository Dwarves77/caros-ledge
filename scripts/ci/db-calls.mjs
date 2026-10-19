// The database calls of a source file, read from the TypeScript syntax tree: every `.from("table")` and `.rpc("function")` chain with what it selects, filters, orders and WRITES (the keys of an insert, update or upsert
// payload, an upsert's onConflict columns, an rpc's argument keys). scripts/ci/columns.mjs checks each name against the catalog; scripts/ci/connections.mjs asks which tables and columns anything writes and anything reads.
// What it reads: a chain of calls after the `.from`/`.rpc`, an argument that is a string literal, a template string with no hole, or an identifier bound to a string literal in the same file, an object literal payload (or an
// array of them; a spread makes the payload `open`, its other keys are still read). What it skips, by design: a chain broken across statements, a payload held in a variable, a computed key.
import ts from "typescript";

const FILTERS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "contains", "containedBy", "overlaps", "not", "order", "filter", "textSearch"]);
const WRITES = new Set(["insert", "update", "upsert"]);

const textOf = (n, consts) => {
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isIdentifier(n)) return consts.get(n.text) ?? null;
  if (ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isParenthesizedExpression(n)) return textOf(n.expression, consts);
  return null;
};

/** The property names of an object literal (or of every element of an array of them), and whether a spread or a computed key left it open. */
export function payloadKeys(node) {
  const keys = [];
  let open = false;
  const objects = !node ? [] : ts.isArrayLiteralExpression(node) ? node.elements : [node];
  for (const o of objects) {
    const lit = ts.isAsExpression(o) || ts.isParenthesizedExpression(o) ? o.expression : o;
    if (!ts.isObjectLiteralExpression(lit)) {
      open = true;
      continue;
    }
    for (const p of lit.properties) {
      if (ts.isSpreadAssignment(p)) open = true;
      else if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) keys.push(p.name.text);
      else open = true;
    }
  }
  return { keys, open };
}

/** The columns an `.or("a.eq.1,b.is.null")` string names: the first dotted token of each top-level comma part. */
export function orColumns(expr) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim().split(".")[0]).filter((c) => c && !/[>(]/.test(c));
}

/** Every database call chain in one source text: { kind: "from" | "rpc", name, line, select, filters, writes, onConflict, rpcArgs }. */
export function dbCallsOf(path, text) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const consts = new Map();
  const collect = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer)) && ts.isVariableDeclarationList(n.parent) && n.parent.flags & ts.NodeFlags.Const) consts.set(n.name.text, n.initializer.text);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["from", "rpc"].includes(node.expression.name.text)) {
      const name = textOf(node.arguments[0], consts);
      if (name !== null && /^[A-Za-z_]\w*$/.test(name)) calls.push(chainOf(node, name, sf, consts));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

function chainOf(start, name, sf, consts) {
  const kind = start.expression.name.text;
  const call = { kind, name, line: sf.getLineAndCharacterOfPosition(start.getStart(sf)).line + 1, select: null, selectLine: 0, filters: [], writes: [], onConflict: [], rpcArgs: kind === "rpc" ? payloadKeys(start.arguments[1]) : null };
  let cur = start;
  for (;;) {
    let p = cur.parent;
    while (p && (ts.isNonNullExpression(p) || ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p))) p = p.parent;
    if (p && ts.isPropertyAccessExpression(p) && p.expression === cur && p.parent && ts.isCallExpression(p.parent) && p.parent.expression === p) {
      method(p.name.text, p.parent, call, consts, sf);
      cur = p.parent;
    } else if (p && ts.isCallExpression(p) && p.arguments.includes(cur) && ts.isIdentifier(p.expression) && p.expression.text === "qb") {
      cur = p; // qb<Row>(db.from("t").select("x")).eq("y", 1): the chain goes on after the wrapper
    } else return call;
  }
}

function method(name, call, out, consts, sf) {
  const [a0, a1] = call.arguments;
  const line = sf.getLineAndCharacterOfPosition(call.expression.name.getStart(sf)).line + 1;
  if (name === "select") {
    const list = textOf(a0, consts);
    if (list !== null) {
      out.select = list;
      out.selectLine = line;
    }
  } else if (FILTERS.has(name)) {
    const col = textOf(a0, consts);
    if (col !== null) out.filters.push({ method: name, column: col, line });
  } else if (name === "or") {
    const expr = textOf(a0, consts);
    if (expr !== null) for (const column of orColumns(expr)) out.filters.push({ method: "or", column, line });
  } else if (name === "match") {
    for (const column of payloadKeys(a0).keys) out.filters.push({ method: "match", column, line });
  } else if (WRITES.has(name)) {
    out.writes.push({ method: name, line, ...payloadKeys(a0) });
    if (name === "upsert" && a1 && ts.isObjectLiteralExpression(a1)) {
      for (const p of a1.properties) if (ts.isPropertyAssignment(p) && p.name.getText() === "onConflict") out.onConflict.push(...(textOf(p.initializer, consts)?.split(",").map((c) => ({ column: c.trim(), line })).filter((c) => c.column) ?? []));
    }
  } else if (name === "delete") out.writes.push({ method: "delete", line, keys: [], open: false });
}
