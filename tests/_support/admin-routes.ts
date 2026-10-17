// Discovers every admin route file for the admin route tests.
import { readdirSync, statSync } from "node:fs";

import { as, ctx, type Persona } from "../_support/personas.ts";

const ROOT = "src/app/api/admin";
const ID = "77777777-7777-4777-8777-777777777777";
const routes = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(`${dir}/${n}`).isDirectory() ? routes(`${dir}/${n}`) : n === "route.ts" ? [`${dir}/${n}`] : []));
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Handler = (request: Request, context: unknown) => Promise<Response>;

/** Every admin route file with its methods, its url (dynamic segments filled with a uuid) and its params. */
export async function adminRoutes() {
  const out: { path: string; method: (typeof METHODS)[number]; handler: Handler; params: Record<string, string> }[] = [];
  for (const file of routes(ROOT)) {
    const mod = (await import(`../../${file}`)) as Record<string, unknown>;
    const params: Record<string, string> = {};
    const path = file.slice("src/app".length, -"/route.ts".length).replace(/\[(\w+)\]/g, (_m, k: string) => ((params[k] = ID), ID));
    for (const method of METHODS) if (typeof mod[method] === "function") out.push({ path, method, handler: mod[method] as Handler, params });
  }
  return out;
}
export const hit = async (r: Awaited<ReturnType<typeof adminRoutes>>[number], persona: Persona): Promise<number | "passed"> => {
  try {
    const res = await r.handler(as(persona, r.path, r.method === "GET" || r.method === "DELETE" ? {} : { method: r.method, body: "{}" }), ctx(r.params));
    return res.status;
  } catch {
    return "passed"; // past the guard: the handler itself threw on an empty world
  }
};

