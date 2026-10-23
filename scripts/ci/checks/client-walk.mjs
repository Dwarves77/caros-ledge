// The client-bundle check (audit 2026-10-23, section 2.4 "bundle hardening"; the R10d check): a "use client" file ships to every visitor's browser, so nothing it imports, by any chain, may be a
// server-only module, node:crypto, or a file that reads a secret from process.env. Tree-shaking keeps such a module out of a bundle today only by luck: one value import of src/core/workspace/roster.ts
// from a client file put the route guard, the service client and the rate limiter on the module graph. This walks the import graph from every "use client" file (static imports, re-exports and import()
// calls; `import type` and type-only re-exports are erased by the compiler and do not count) and prints the chain to each offence. Run from the repo root: node scripts/ci/checks/client-walk.mjs
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

import ts from "typescript";

import { isMain, posix, walk } from "../../lib/fs.mjs";

/** Modules that exist to run on the server: the route guard, both database client factories, server telemetry, the rate limiter and the platform-admin check. */
export const SERVER_MODULES = new Set(["src/core/http/guard.ts", "src/core/db/clients.ts", "src/core/shared/telemetry.ts", "src/core/http/rate-limit.ts", "src/core/auth/platform-admin.ts"]);
/** Node built-ins a browser bundle must not pull in. */
const NODE_MODULES = new Set(["node:crypto", "crypto"]);
const PUBLIC_ENV = /^(NEXT_PUBLIC_|NODE_ENV$)/;
const EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js"];

const isEnv = (node) => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process" && node.name.text === "env";

/** What one file says about itself: whether it is a client file, what it imports (value imports only), and the non-public environment reads. */
function parse(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let client = false;
  for (const s of sf.statements) {
    if (!(ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression))) break;
    if (s.expression.text === "use client") client = true;
  }
  const imports = [];
  const envReads = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const c = node.importClause;
      const named = c?.namedBindings && ts.isNamedImports(c.namedBindings) ? c.namedBindings.elements : null;
      const typesOnly = c && (c.isTypeOnly || (!c.name && named && named.length > 0 && named.every((e) => e.isTypeOnly)));
      if (!typesOnly) imports.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const named = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null;
      if (!(node.isTypeOnly || (named && named.length > 0 && named.every((e) => e.isTypeOnly)))) imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      imports.push(node.arguments[0].text);
    }
    if (isEnv(node)) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        if (!PUBLIC_ENV.test(parent.name.text)) envReads.push(`process.env.${parent.name.text}`);
      } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const key = ts.isStringLiteralLike(parent.argumentExpression) ? parent.argumentExpression.text : null;
        if (key === null || !PUBLIC_ENV.test(key)) envReads.push(key === null ? "process.env[...]" : `process.env.${key}`);
      } else envReads.push("process.env (the whole environment)");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { client, imports, envReads: [...new Set(envReads)] };
}

/** The repo-relative file a specifier names, or null for a package or a file this tree does not hold. */
function resolveSpec(root, from, spec) {
  const base = spec.startsWith("@/") ? join("src", spec.slice(2)) : spec.startsWith(".") ? join(dirname(from), spec) : null;
  if (base === null) return null;
  for (const candidate of [...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.slice(1).map((e) => join(base, `index${e}`))]) {
    const path = join(root, candidate);
    if (existsSync(path) && statSync(path).isFile()) return posix(normalize(candidate));
  }
  return null;
}

/** Every offence under `root`: { chain: [client file, ..., last file], reason, clients } with one entry per distinct (last file, reason) and the client files that reach it. */
export function clientWalk(root = ".") {
  const files = walk(join(root, "src"), (name) => /\.(tsx?|mjs|js)$/.test(name)).map((f) => posix(relative(root, f)));
  const parsed = new Map();
  const info = (f) => {
    if (!parsed.has(f)) parsed.set(f, parse(f, readFileSync(join(root, f), "utf8")));
    return parsed.get(f);
  };
  const clients = files.filter((f) => info(f).client);
  const found = new Map();
  const record = (chain, reason, client) => {
    const key = `${chain.at(-1)}|${reason}`;
    const entry = found.get(key) ?? { chain, reason, clients: new Set() };
    entry.clients.add(client);
    if (chain.length < entry.chain.length) entry.chain = chain;
    found.set(key, entry);
  };
  for (const client of clients) {
    const seen = new Set([client]);
    const queue = [[client]];
    while (queue.length) {
      const chain = queue.shift();
      const file = chain.at(-1);
      const { imports, envReads } = info(file);
      for (const read of envReads) record(chain, `reads ${read}`, client);
      for (const spec of imports) {
        if (NODE_MODULES.has(spec)) record([...chain, spec], "is a Node built-in a browser bundle cannot hold", client);
        const target = resolveSpec(root, file, spec);
        if (!target) continue;
        if (SERVER_MODULES.has(target)) record([...chain, target], "is a server-only module", client);
        else if (!seen.has(target)) {
          seen.add(target);
          queue.push([...chain, target]);
        }
      }
    }
  }
  return { clients: clients.length, offences: [...found.values()].map((o) => ({ ...o, clients: [...o.clients] })) };
}

if (isMain(import.meta.url)) {
  const { clients, offences } = clientWalk(".");
  for (const o of offences) console.error(`${o.chain.join(" -> ")}  ${o.reason}${o.clients.length > 1 ? ` (reached from ${o.clients.length} client files)` : ""}`);
  console.log(offences.length ? `client-walk: ${offences.length} offence(s) in the graph of ${clients} client file(s)` : `client-walk: clean (${clients} client files reach no server-only module, node:crypto or secret)`);
  process.exit(offences.length ? 1 : 0);
}
