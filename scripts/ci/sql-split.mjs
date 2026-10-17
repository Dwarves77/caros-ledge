// Splits SQL text into statements the way psql does: on a semicolon outside quotes, comments, dollar quotes and parentheses.
// Each statement carries the 1-based line it starts on (the first line with SQL, not the comment above it), for error lines.
export function splitStatements(text) {
  const out = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  const push = (end) => {
    const body = text.slice(start, end);
    const lead = body.length - body.replace(/^(?:\s+|--[^\n]*|\/\*[\s\S]*?\*\/)+/, "").length;
    const sql = body.slice(lead).trim();
    if (sql) out.push({ sql, line: text.slice(0, start + lead).split("\n").length });
  };
  while (i < text.length) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    if (two === "--") i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
    else if (two === "/*") {
      let level = 1;
      i += 2;
      while (i < text.length && level) {
        if (text.startsWith("/*", i)) { level += 1; i += 2; } else if (text.startsWith("*/", i)) { level -= 1; i += 2; } else i += 1;
      }
    } else if (c === "'" || c === '"') {
      const escapes = c === "'" && /[eE]/.test(text[i - 1] ?? "") && !/\w/.test(text[i - 2] ?? " ");
      i += 1;
      while (i < text.length) {
        if (escapes && text[i] === "\\") i += 2;
        else if (text[i] === c) { if (text[i + 1] === c) i += 2; else break; } else i += 1;
      }
      i += 1;
    } else if (c === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(text.slice(i))) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))[0];
      const end = text.indexOf(tag, i + tag.length);
      i = end < 0 ? text.length : end + tag.length;
    } else {
      if (c === "(") depth += 1;
      else if (c === ")") depth = Math.max(0, depth - 1);
      else if (c === ";" && depth === 0) { push(i); start = i + 1; }
      i += 1;
    }
  }
  push(text.length);
  return out;
}
