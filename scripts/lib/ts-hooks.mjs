import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Module hooks that let `node` run the TypeScript sources: the "@/" alias, extensionless specifiers and JSON as data. The tests register them with a stand-in for the database clients (fakeClients);
// the turn CLI registers them without one, so a production run reaches the real clients.
const SRC = new URL("../../src/", import.meta.url);
const REAL_CLIENTS = new URL("core/db/clients.ts", SRC).href;
let FAKE_CLIENTS = null;
let NEXT_CACHE = null;

export function initialize(data) {
  FAKE_CLIENTS = data?.fakeClients ?? null;
  NEXT_CACHE = data?.nextCache ?? null;
}

function find(base) {
  const p = fileURLToPath(base);
  for (const candidate of [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`, `${p}/index.tsx`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return pathToFileURL(candidate).href;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  let target = null;
  if (specifier.startsWith("@/")) target = find(new URL(specifier.slice(2), SRC));
  else if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith(SRC.href)) target = find(new URL(specifier, context.parentURL));
  // Source modules get scripted client factories; a test reaches the real ones by importing the file by its path.
  if (FAKE_CLIENTS && target === REAL_CLIENTS && context.parentURL?.startsWith(SRC.href)) target = FAKE_CLIENTS;
  // A module drawn in a node test has no incremental cache for revalidateTag: source modules get the stand-in (tests only).
  if (NEXT_CACHE && specifier === "next/cache" && context.parentURL?.startsWith(SRC.href)) target = NEXT_CACHE;
  // Node's ESM resolver does not read next's package layout: "next/navigation" is the file next/navigation.js.
  if (!target && /^next\/[a-z-]+$/.test(specifier)) target = `${specifier}.js`;
  return next(target ?? specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith(".json") && url.startsWith(SRC.href)) {
    return { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")}`, shortCircuit: true };
  }
  // A component test renders the real .tsx sources: JSX is transpiled (types stripped) and a stylesheet is a stand-in whose class names are their own keys.
  if (url.startsWith(SRC.href) && url.endsWith(".tsx")) {
    const ts = (await import("typescript")).default;
    const out = ts.transpileModule(readFileSync(new URL(url), "utf8"), { fileName: fileURLToPath(url), compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  if (url.startsWith(SRC.href) && url.endsWith(".css")) {
    return { format: "module", source: url.endsWith(".module.css") ? "export default new Proxy({}, { get: (_t, k) => (typeof k === 'string' ? k : undefined) });" : "export default {};", shortCircuit: true };
  }
  return next(url, context);
}
