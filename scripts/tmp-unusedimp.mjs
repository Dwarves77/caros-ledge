import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
let out;
try { out = execFileSync("npx", ["eslint", "tests", "-f", "json"], { encoding: "utf8", shell: true, maxBuffer: 1 << 28 }); } catch (e) { out = e.stdout; }
for (const f of JSON.parse(out)) {
  const bad = new Set(f.messages.filter((m) => /is defined but never used|is assigned a value but never used/.test(m.message)).map((m) => /'([^']+)'/.exec(m.message)[1]));
  if (!bad.size) continue;
  let text = readFileSync(f.filePath, "utf8");
  const crlf = text.includes("\r\n");
  text = text.replace(/\r\n/g, "\n");
  const sf = ts.createSourceFile(f.filePath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const cuts = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      const els = st.importClause.namedBindings.elements;
      const keep = els.filter((e) => !bad.has(e.name.text));
      if (keep.length === els.length) continue;
      if (!keep.length && !st.importClause.name) cuts.push([st.getStart(sf), st.end, ""]);
      else cuts.push([st.getStart(sf), st.end, `import ${st.importClause.isTypeOnly ? "type " : ""}{ ${keep.map((e) => e.getText(sf)).join(", ")} } from ${st.moduleSpecifier.getText(sf)};`]);
    } else if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1 && ts.isIdentifier(st.declarationList.declarations[0].name) && bad.has(st.declarationList.declarations[0].name.text)) cuts.push([st.getStart(sf), st.end, ""]);
  }
  cuts.sort((a, b) => b[0] - a[0]);
  for (const [a, b, r] of cuts) text = text.slice(0, a) + r + text.slice(b);
  text = text.replace(/\n{3,}/g, "\n\n");
  writeFileSync(f.filePath, crlf ? text.replace(/\n/g, "\r\n") : text);
  console.log(f.filePath.split("\\").slice(-2).join("/"), cuts.length);
}
