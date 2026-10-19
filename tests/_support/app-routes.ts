// The routes of the app, read from the file system (G5), and the modules a route reaches. The page sweep names the routes it draws; this file is what makes that list a statement about the whole app:
// a page added under src/app is a route the sweep must draw or an exemption must explain, and an exempt page must not reach a module that reads the database (it would read silently, outside every sweep).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SRC = resolve("src");
/** The test mounts under /privacy/ui-fixtures answer 404 unless UI_FIXTURES=1, set only in the UX job: they are not routes of the product. */
const FIXTURE_PREFIX = "/privacy/ui-fixtures";

export interface AppRoute {
  /** The URL pattern, dynamic segments as [name]. */
  route: string;
  /** The file that serves it, relative to the repo root. */
  file: string;
}

/** Every page and route handler under src/app outside /api (the API routes are exercised by the persona tests), the fixture mounts left out. */
export function appRoutes(root = "src/app"): AppRoute[] {
  const out: AppRoute[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!(dir === root && name === "api")) walk(full);
      } else if (name === "page.tsx" || name === "route.ts") {
        const route = `/${relative(root, dir).split(/[\\/]/).filter(Boolean).join("/")}`;
        if (!route.startsWith(FIXTURE_PREFIX)) out.push({ route, file: full.replaceAll("\\", "/") });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.route.localeCompare(b.route));
}

const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^"'`;]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
function resolveModule(spec: string, from: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}

/**
 * Every source module reachable from the entry files through value imports (type-only imports are not runtime reachability). The walk stops at src/core: the page session, the clients and the shared readers there are
 * infrastructure that every swept page exercises; what a page adds is in src/features, src/ui and src/app, and that is what an exemption must account for.
 */
export function importClosure(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entries.map((e) => resolve(e));
  while (queue.length) {
    const file = queue.pop() as string;
    if (seen.has(file) || !/\.tsx?$/.test(file) || file.replaceAll("\\", "/").startsWith(`${SRC.replaceAll("\\", "/")}/core/`)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const next = resolveModule((m[1] ?? m[2] ?? m[3]) as string, file);
      if (next) queue.push(next);
    }
  }
  return seen;
}

/** A module that reads the database: it calls `.from("table")` or `.rpc("name")` with a literal name, outside core/db (Array.from and the like have no string literal). */
function readsDatabase(file: string): boolean {
  if (file.replaceAll("\\", "/").includes("/src/core/db/")) return false;
  for (const m of readFileSync(file, "utf8").matchAll(/([A-Za-z_$][\w$]*)?\s*\.(?:from|rpc)\(\s*["'`][a-z_]+["'`]/g)) if (!/^(?:Buffer|Array|\w*Array|Object|Set|Map)$/.test(m[1] ?? "")) return true;
  return false;
}

/** The modules of the closure that read the database, as repo-relative paths. */
export function readersIn(closure: Set<string>): string[] {
  return [...closure].filter(readsDatabase).map((f) => relative(resolve("."), f).replaceAll("\\", "/")).sort();
}

/** The routes on disk that the registry does not list, and the registry entries whose route is gone. */
export function routeProblems(found: readonly string[], registered: readonly string[]): { unlisted: string[]; stale: string[] } {
  return { unlisted: found.filter((r) => !registered.includes(r)), stale: registered.filter((r) => !found.includes(r)) };
}
