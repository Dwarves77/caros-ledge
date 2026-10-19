// The reference graph of the source tree, built from the TypeScript syntax tree (not from words in text): which file exports which value, which file imports it and actually uses the binding, which exports are
// re-exports of another file's, and which files a root (a route, a page, the instrumentation hook, a script, the Edge Function) can reach. The connection check (scripts/ci/connections.mjs) asks this graph
// which exports nothing reachable ever calls, so a comment, a string or a type position that merely contains a name is not a caller.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import ts from "typescript";

import { posix } from "../../lib/fs.mjs";

const EXTENSIONS = [".ts", ".tsx", "/index.ts", "/index.tsx", ""];

/** The file a specifier names, among `files` (a Set of posix paths), or null for a package. `@/` is src/. */
export function resolveSpecifier(from, spec, files) {
  const base = spec.startsWith("@/") ? `src/${spec.slice(2)}` : spec.startsWith(".") ? posix(join(dirname(from), spec)) : null;
  if (!base) return null;
  const clean = base.replace(/\.(js|mjs|ts|tsx)$/, "");
  return [...EXTENSIONS.map((e) => `${clean}${e}`), ...EXTENSIONS.map((e) => `${base}${e}`)].find((c) => files.has(c)) ?? null;
}

const hasModifier = (node, kind) => (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []).some((m) => m.kind === kind);
const nameText = (n) => (n && ts.isIdentifier(n) ? n.text : null);

/** What one source file declares and uses. */
export function analyse(path, text) {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const exports = new Map(); // name -> { line, kind: "value" | "type" }
  const reexports = []; // { spec, names: [[exportedAs, importedName]] | "*" }
  const imports = []; // { spec, bindings: [{ imported, local, typeOnly }] }
  const dynamicSpecs = [];
  const line = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (name, node, kind) => name && exports.set(name, { line: line(node), kind });

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause;
      const bindings = [];
      if (clause?.name) bindings.push({ imported: "default", local: clause.name.text, typeOnly: clause.isTypeOnly });
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bindings.push({ imported: "*", local: clause.namedBindings.name.text, typeOnly: clause.isTypeOnly });
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const el of clause.namedBindings.elements) bindings.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text, typeOnly: clause.isTypeOnly || el.isTypeOnly });
      imports.push({ spec: st.moduleSpecifier.text, bindings });
    } else if (ts.isExportDeclaration(st)) {
      const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      const typeOnly = st.isTypeOnly;
      if (spec && !st.exportClause) reexports.push({ spec, names: "*", typeOnly });
      else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
        const pairs = st.exportClause.elements.map((el) => [el.name.text, (el.propertyName ?? el.name).text, typeOnly || el.isTypeOnly]);
        if (spec) reexports.push({ spec, names: pairs, typeOnly });
        else for (const [as, local, t] of pairs) add(as, st, t ? "type" : "value", local);
      } else if (spec && st.exportClause && ts.isNamespaceExport(st.exportClause)) add(st.exportClause.name.text, st, "value");
    } else if (ts.isExportAssignment(st)) add("default", st, "value");
    else if (hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
      const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
      if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) add(isDefault ? "default" : nameText(st.name), st, "value");
      else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) add(nameText(d.name), d, "value");
      else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) add(nameText(st.name), st, "type");
    }
  }

  // Value uses of local names: every identifier that is not part of an import declaration, an export specifier, a declaration's own name, a property name or a type reference.
  const uses = new Map(); // local name -> count
  const members = new Map(); // namespace local -> Set of member names read; "*" when the namespace is used as a whole
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      // `const { a, b } = await import(spec)` uses a and b and nothing else of spec; `const m = await import(spec)` is a namespace (its members are read below); any other shape uses the whole module.
      const spec = node.arguments[0].text;
      const parent = node.parent && ts.isAwaitExpression(node.parent) ? node.parent.parent : node.parent;
      const declared = parent && ts.isVariableDeclaration(parent) ? parent : null;
      if (declared && ts.isObjectBindingPattern(declared.name) && declared.name.elements.every((e) => ts.isIdentifier(e.name) && !e.dotDotDotToken && (!e.propertyName || ts.isIdentifier(e.propertyName)))) {
        imports.push({ spec, bindings: declared.name.elements.map((e) => ({ imported: (e.propertyName ?? e.name).text, local: e.name.text, typeOnly: false })) });
      } else if (declared && ts.isIdentifier(declared.name)) imports.push({ spec, bindings: [{ imported: "*", local: declared.name.text, typeOnly: false }] });
      else dynamicSpecs.push(spec);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const set = members.get(node.expression.text) ?? new Set();
      set.add(node.name.text);
      members.set(node.expression.text, set);
    }
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const declares = (ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === node;
      const property = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isPropertyDeclaration(p) && p.name === node) || (ts.isMethodDeclaration(p) && p.name === node);
      const exportSpec = ts.isExportSpecifier(p);
      if (!declares && !property && !exportSpec) uses.set(node.text, (uses.get(node.text) ?? 0) + 1);
      // `export { local as as }`: the local name is used by the export (a re-export of a local binding).
      if (exportSpec && !p.parent.parent.moduleSpecifier) uses.set((p.propertyName ?? p.name).text, (uses.get((p.propertyName ?? p.name).text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { exports, reexports, imports, dynamicSpecs, uses, members };
}

/**
 * The graph of every file in `texts` (Map path -> source text): for each export, the files that use it; `reachable(roots)` the files an import chain from the roots reaches.
 */
export function buildGraph(texts, extraRoots = []) {
  const files = new Set(texts.keys());
  const info = new Map([...texts].map(([path, text]) => [path, analyse(path, text)]));
  const edges = new Map(); // file -> Set of files it imports
  const usedBy = new Map(); // `${file}#${name}` -> Set of files using it
  const markUsed = (file, name, by) => {
    const key = `${file}#${name}`;
    (usedBy.get(key) ?? usedBy.set(key, new Set()).get(key)).add(by);
  };
  // An export, followed through re-exports to where it is defined: [definingFile, name], or null for a package/unknown.
  const defining = (file, name, seen = new Set()) => {
    const key = `${file}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const f = info.get(file);
    if (!f) return null;
    if (f.exports.has(name) && !f.reexports.some((r) => r.names !== "*" && r.names.some(([as]) => as === name))) return [file, name];
    for (const r of f.reexports) {
      const target = resolveSpecifier(file, r.spec, files);
      if (!target) continue;
      if (r.names === "*") {
        const hit = defining(target, name, seen);
        if (hit) return hit;
      } else {
        const pair = r.names.find(([as]) => as === name);
        if (pair) return defining(target, pair[1], seen);
      }
    }
    return f.exports.has(name) ? [file, name] : null;
  };
  for (const [file, f] of info) {
    const out = new Set();
    for (const imp of f.imports) {
      const target = resolveSpecifier(file, imp.spec, files);
      if (!target) continue;
      out.add(target);
      for (const b of imp.bindings) {
        if (b.typeOnly) continue;
        if (b.imported === "*") {
          const names = f.members.get(b.local);
          const all = !names || (f.uses.get(b.local) ?? 0) > names.size;
          for (const [name] of info.get(target).exports) if (all || names.has(name)) { const d = defining(target, name); if (d) markUsed(d[0], d[1], file); }
          for (const r of info.get(target).reexports) if (r.names === "*") for (const [name] of info.get(resolveSpecifier(target, r.spec, files))?.exports ?? []) if (all || names.has(name)) { const d = defining(target, name); if (d) markUsed(d[0], d[1], file); }
        } else if ((f.uses.get(b.local) ?? 0) > 0) {
          const d = defining(target, b.imported);
          if (d) markUsed(d[0], d[1], file);
        }
      }
    }
    for (const spec of f.dynamicSpecs) {
      const target = resolveSpecifier(file, spec, files);
      if (!target) continue;
      out.add(target);
      for (const [name] of info.get(target).exports) { const d = defining(target, name); if (d) markUsed(d[0], d[1], file); }
    }
    for (const r of f.reexports) {
      const target = resolveSpecifier(file, r.spec, files);
      if (target) out.add(target);
    }
    edges.set(file, out);
  }
  const reachable = (roots) => {
    const seen = new Set();
    for (const stack = [...roots]; stack.length; ) {
      const f = stack.pop();
      if (seen.has(f) || !files.has(f)) continue;
      seen.add(f);
      stack.push(...(edges.get(f) ?? []));
    }
    return seen;
  };
  return { info, edges, usedBy, reachable, defining, files, extraRoots };
}

export const textsOf = (paths) => new Map(paths.map((p) => [p, readFileSync(p, "utf8")]));
