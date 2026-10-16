import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = new URL("../../src/", import.meta.url);
const REAL_CLIENTS = new URL("core/db/clients.ts", SRC).href;
const FAKE_CLIENTS = new URL("./fake-clients.ts", import.meta.url).href;

function find(base) {
  const p = fileURLToPath(base);
  for (const candidate of [p, `${p}.ts`, `${p}.tsx`, `${p}/index.ts`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return pathToFileURL(candidate).href;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  let target = null;
  if (specifier.startsWith("@/")) target = find(new URL(specifier.slice(2), SRC));
  else if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith(SRC.href)) target = find(new URL(specifier, context.parentURL));
  // Source modules get scripted client factories; a test reaches the real ones by importing the file by its path.
  if (target === REAL_CLIENTS && context.parentURL?.startsWith(SRC.href)) target = FAKE_CLIENTS;
  // Node's ESM resolver does not read next's package layout: "next/navigation" is the file next/navigation.js.
  if (!target && /^next\/[a-z-]+$/.test(specifier)) target = `${specifier}.js`;
  return next(target ?? specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith(".json") && url.startsWith(SRC.href)) {
    return { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")}`, shortCircuit: true };
  }
  return next(url, context);
}
