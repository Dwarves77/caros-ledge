// TEMPORARY (not committed): delete dead exports of the R2c write set and what they orphan.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import ts from "typescript";
import { walk } from "./lib/fs.mjs";
import { buildGraph } from "./ci/connections/graph.mjs";
import { deadExports, runtimeEntries } from "./ci/connections.mjs";

const MINE = /^(src\/core\/fetch\/|src\/core\/sources\/|src\/features\/sources\/|supabase\/functions\/capture-worker|src\/app\/bot)/;
const allow = JSON.parse(readFileSync("scripts/ci/connections-allow.json", "utf8"));

function deadList() {
  const srcPaths = walk("src", (n) => /\.(ts|tsx)$/.test(n));
  const other = [...walk("scripts", (n) => /\.mjs$/.test(n) && !n.includes("tmp-prune")), ...walk("supabase/functions", (n) => /\.ts$/.test(n))];
  const texts = new Map([...srcPaths, ...other].map((p) => [p, readFileSync(p, "utf8")]));
  const graph = buildGraph(texts);
  const srcTexts = new Map(srcPaths.map((p) => [p, texts.get(p)]));
  const rt = runtimeEntries(srcTexts);
  return deadExports(graph, srcPaths, rt).filter((d) => MINE.test(d.file) && !d.runtime);
}

/** Start of the comment run directly above a node (no blank line between), else the node start. */
function startWithComments(text, node, sf) {
  let start = node.getStart(sf);
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    const gap = text.slice(r.end, start);
    if ((gap.match(/\n/g) ?? []).length > 1) break;
    start = r.pos;
  }
  return start;
}

function removeNames(file, names) {
  let text = readFileSync(file, "utf8");
  const crlf = text.includes("\r\n");
  text = text.replace(/\r\n/g, "\n");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const cuts = [];
  const nameSet = new Set(names);
  const hasExport = (n) => n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const usedInFile = (name, declNode) => {
    let used = false;
    const visit = (n) => {
      if (used) return;
      if (ts.isIdentifier(n) && n.text === name && n !== declNode && !(n.parent && ts.isExportSpecifier(n.parent))) used = true;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return used;
  };
  const unexport = (st) => {
    const m = st.modifiers.find((x) => x.kind === ts.SyntaxKind.ExportKeyword);
    cuts.push([m.getStart(sf), st.modifiers.length > 1 && st.modifiers[st.modifiers.length - 1] !== m ? st.modifiers[st.modifiers.indexOf(m) + 1].getStart(sf) : m.end + 1, ""]);
  };
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && hasExport(st) && st.name && nameSet.has(st.name.text) && usedInFile(st.name.text, st.name)) { unexport(st); continue; }
    if (ts.isVariableStatement(st) && hasExport(st) && st.declarationList.declarations.every((d) => ts.isIdentifier(d.name) && nameSet.has(d.name.text) ? usedInFile(d.name.text, d.name) : false)) { unexport(st); continue; }
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && hasExport(st) && st.name && nameSet.has(st.name.text)) {
      cuts.push([startWithComments(text, st, sf), st.end]);
    } else if (ts.isVariableStatement(st) && hasExport(st)) {
      const decls = st.declarationList.declarations;
      const dead = decls.filter((d) => ts.isIdentifier(d.name) && nameSet.has(d.name.text));
      if (dead.length === decls.length) cuts.push([startWithComments(text, st, sf), st.end]);
      else if (dead.length) for (const d of dead) { const i = decls.indexOf(d); cuts.push(i + 1 < decls.length ? [d.getStart(sf), decls[i + 1].getStart(sf)] : [decls[i - 1].end, d.end]); }
    } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      const keep = st.exportClause.elements.filter((e) => !nameSet.has(e.name.text));
      if (keep.length === 0) cuts.push([startWithComments(text, st, sf), st.end]);
      else if (keep.length < st.exportClause.elements.length) {
        const rendered = `export ${st.isTypeOnly ? "type " : ""}{ ${keep.map((e) => e.getText(sf)).join(", ")} }${st.moduleSpecifier ? ` from ${st.moduleSpecifier.getText(sf)}` : ""};`;
        cuts.push([st.getStart(sf), st.end, rendered]);
      }
    }
  }
  cuts.sort((a, b) => b[0] - a[0]);
  for (const [a, b, rep] of cuts) text = text.slice(0, a) + (rep ?? "") + text.slice(b);
  text = text.replace(/\n{3,}/g, "\n\n");
  writeFileSync(file, crlf ? text.replace(/\n/g, "\r\n") : text);
  return cuts.length;
}

/** tsc unused-locals diagnostics for the write set files: [{file, start, end, code, name}]. */
function unused() {
  const cfgPath = ts.findConfigFile(".", ts.sys.fileExists, "tsconfig.json");
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ".");
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noUnusedLocals: true, incremental: false, tsBuildInfoFile: undefined });
  const out = [];
  for (const sf of program.getSourceFiles()) {
    const rel = sf.fileName.replace(/\\/g, "/").replace(process.cwd().replace(/\\/g, "/") + "/", "");
    if (!MINE.test(rel)) continue;
    for (const d of ts.getPreEmitDiagnostics(program, sf)) if ([6133, 6192, 6196, 6198, 6199].includes(d.code)) out.push({ file: rel, start: d.start, length: d.length, code: d.code });
  }
  return out;
}

function removeUnused(list) {
  const byFile = new Map();
  for (const u of list) (byFile.get(u.file) ?? byFile.set(u.file, []).get(u.file)).push(u);
  let n = 0;
  for (const [file, items] of byFile) {
    let text = readFileSync(file, "utf8");
    const crlf = text.includes("\r\n");
    // diagnostics positions are for the original text (CRLF included); work on that text
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const cuts = [];
    for (const it of items) {
      const find = (node) => {
        if (node.getStart(sf) <= it.start && it.start + it.length <= node.end) {
          let hit = null;
          ts.forEachChild(node, (c) => { hit = hit ?? find(c); });
          return hit ?? node;
        }
        return null;
      };
      let node = find(sf);
      if (!node) continue;
      // climb to the removable unit
      let cur = node;
      while (cur && !(ts.isImportSpecifier(cur) || ts.isImportDeclaration(cur) || (ts.isStatement(cur) && cur.parent === sf) || (ts.isVariableDeclaration(cur) && cur.parent.parent.parent === sf))) cur = cur.parent;
      if (!cur) continue;
      if (ts.isImportSpecifier(cur)) {
        const decl = cur.parent.parent.parent;
        const els = cur.parent.elements;
        if (els.length === 1 && !decl.importClause.name) cuts.push([decl.getStart(sf), decl.end, "decl"]);
        else cuts.push([els.indexOf(cur) === 0 ? cur.getStart(sf) : els[els.indexOf(cur) - 1].end, cur.end, "spec"]);
      } else if (ts.isImportDeclaration(cur)) cuts.push([cur.getStart(sf), cur.end]);
      else if (ts.isVariableDeclaration(cur)) {
        const decls = cur.parent.declarations;
        if (decls.length === 1) cuts.push([startWithComments(text, cur.parent.parent, sf), cur.parent.parent.end]);
        else { const i = decls.indexOf(cur); cuts.push(i + 1 < decls.length ? [cur.getStart(sf), decls[i + 1].getStart(sf)] : [decls[i - 1].end, cur.end]); }
      } else cuts.push([startWithComments(text, cur, sf), cur.end]);
      n++;
    }
    cuts.sort((a, b) => b[0] - a[0]);
    const seen = new Set();
    for (const [a, b] of cuts) { if (seen.has(a)) continue; seen.add(a); text = text.slice(0, a) + text.slice(b); }
    text = text.replace(/\r?\n(\r?\n){2,}/g, crlf ? "\r\n\r\n" : "\n\n");
    writeFileSync(file, text);
  }
  return n;
}

const mode = process.argv[2];
if (mode === "dead") {
  for (const d of deadList()) console.log(`${d.file}#${d.name}`);
} else if (mode === "round") {
  const dead = deadList();
  const byFile = new Map();
  for (const d of dead) (byFile.get(d.file) ?? byFile.set(d.file, []).get(d.file)).push(d.name);
  let c = 0;
  for (const [f, ns] of byFile) c += removeNames(f, ns);
  console.log(`removed ${c} export declarations from ${byFile.size} files`);
} else if (mode === "unused") {
  const u = unused();
  const n = removeUnused(u);
  console.log(`unused diagnostics ${u.length}, removed ${n}`);
}
