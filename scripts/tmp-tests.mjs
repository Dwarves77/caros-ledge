// TEMPORARY (not committed): drop the test() blocks whose source names an export that no longer exists, and the imports.
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const errs = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean);
const apply = process.argv[3] === "apply";
const KEEP = new Set((process.env.KEEP ?? "").split(",").filter(Boolean));
const byFile = new Map();
for (const l of errs) {
  const m = /^(tests\/[^(]+)\((\d+),(\d+) \| .*?(?:member(?: named)? '(\w+)'|declares '(\w+)' locally)/.exec(l);
  if (!m) continue;
  (byFile.get(m[1]) ?? byFile.set(m[1], new Set()).get(m[1])).add(m[4] ?? m[5]);
}
for (const [file, names] of byFile) {
  let text = readFileSync(file, "utf8");
  const crlf = text.includes("\r\n");
  text = text.replace(/\r\n/g, "\n");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const cuts = [];
  const uses = (node) => {
    let hit = null;
    const visit = (n) => { if (hit) return; if (ts.isIdentifier(n) && names.has(n.text) && !KEEP.has(n.text)) hit = n.text; ts.forEachChild(n, visit); };
    visit(node);
    return hit;
  };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) || ts.isImportEqualsDeclaration(st)) continue;
    const hit = uses(st);
    if (!hit) continue;
    const call = ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) ? st.expression : null;
    const title = call && call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) ? call.arguments[0].text.slice(0, 110) : null;
    console.log(`${file}: remove ${title ? `test "${title}"` : `statement ${st.getText(sf).slice(0, 60).replace(/\n/g, " ")}`} (names ${hit})`);
    let start = st.getStart(sf);
    const ranges = ts.getLeadingCommentRanges(text, st.getFullStart()) ?? [];
    for (let i = ranges.length - 1; i >= 0; i--) { if ((text.slice(ranges[i].end, start).match(/\n/g) ?? []).length > 1) break; start = ranges[i].pos; }
    cuts.push([start, st.end]);
  }
  // imports: drop the missing specifiers
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings || !ts.isNamedImports(st.importClause.namedBindings)) continue;
    const els = st.importClause.namedBindings.elements;
    const keep = els.filter((e) => !names.has((e.propertyName ?? e.name).text));
    if (keep.length === els.length) continue;
    if (!keep.length && !st.importClause.name) cuts.push([st.getStart(sf), st.end]);
    else cuts.push([st.getStart(sf), st.end, `import ${st.importClause.isTypeOnly ? "type " : ""}{ ${keep.map((e) => e.getText(sf)).join(", ")} } from ${st.moduleSpecifier.getText(sf)};`]);
  }
  if (!apply) continue;
  cuts.sort((a, b) => b[0] - a[0]);
  for (const [a, b, rep] of cuts) text = text.slice(0, a) + (rep ?? "") + text.slice(b);
  text = text.replace(/\n{3,}/g, "\n\n");
  writeFileSync(file, crlf ? text.replace(/\n/g, "\r\n") : text);
}
