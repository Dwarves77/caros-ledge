import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const src = files("src").map((f) => f.split(sep).join("/")).filter((f) => /\.(ts|tsx)$/.test(f));
const rel = (f: string): string => relative("src", f).split(sep).join("/");
const text = (f: string) => readFileSync(f, "utf8");

// A guard is any require* function or *Guard function; a wrapper is any function in the tree whose own body calls one
// (runCollab, a token wrapper). Both are read from the tree, so a slice that adds a route or a wrapper edits no literal here.
const GUARD_CALL = /\b(require[A-Z]\w*|\w*Guard)\(/;
const wrappers = new Set<string>();
for (const f of src) {
  for (const seg of text(f).split(/\n(?=(?:export )?(?:async )?function )/)) {
    const name = /^(?:export )?(?:async )?function (\w+)/.exec(seg)?.[1];
    if (name && GUARD_CALL.test(seg)) wrappers.add(name);
  }
}
const isGuarded = (body: string): boolean => GUARD_CALL.test(body) || [...wrappers].some((w) => new RegExp(`\\b${w}\\(`).test(body));

/** A feature barrel (the server surface of a feature, IMP-106) re-exports a handler from the file that defines it: follow `export { GET as name } from "./path"` to that file, so the guard is read where the handler is. */
const definingFile = (file: string, name: string): string => {
  const m = new RegExp(String.raw`export \{ \w+ as ${name} \} from "\./([^"]+)"`).exec(text(file));
  return m ? `${file.slice(0, file.lastIndexOf("/"))}/${m[1]}.ts` : file;
};

test("PROP-001/160: every route handler is behind a guard, or is one of the two public auth endpoints", () => {
  const publicRoutes = new Set(["src/features/auth/api/identity.ts", "src/features/auth/api/callback.ts"]);
  // Public by documented exception (operator-approved 2026-07-11): build metadata only, no database, no parameters, nothing to limit.
  const documentedPublic = new Set(["src/features/telemetry/api/version.ts"]);
  const routes = src.filter((f) => f.endsWith("/route.ts"));
  assert.ok(routes.length > 0, "no route files found");
  for (const route of routes) {
    const target = /from "@\/(features\/[^"]+)"/.exec(text(route))?.[1];
    assert.ok(target, `${route} re-exports a feature handler`);
    const handler = definingFile(`src/${target}.ts`, /export \{\s*(\w+)/.exec(text(route))?.[1] ?? "GET");
    const body = text(handler);
    if (documentedPublic.has(handler)) continue;
    if (publicRoutes.has(handler)) assert.match(body, /checkRateLimit/, `${handler} is public, so it must rate limit`);
    else assert.ok(isGuarded(body), `${handler} has no guard`);
  }
});

test("PROP-028/127 and PROP-011/109: one module attaches the bearer, one factory builds service clients", () => {
  const mentions = (re: RegExp) => src.filter((f) => re.test(text(f))).map(rel).sort();
  // The third holder is the e-mail provider's own API key (core/shared/email.ts, IMP-014): a different credential to a different service, not the user's session bearer.
  assert.deepEqual(mentions(/authorization/i), ["core/db/clients.ts", "core/http/authed-fetch.ts", "core/shared/email.ts"]);
  assert.deepEqual(mentions(/SUPABASE_SERVICE_ROLE_KEY/), ["core/db/clients.ts"]);
  assert.deepEqual(mentions(/\bcreateClient\(/), ["core/db/clients.ts"]);
  assert.deepEqual(mentions(/\bcreateServerClient\(/), ["core/db/clients.ts"]);
  assert.deepEqual(mentions(/\bcreateBrowserClient\(/), ["core/db/browser.ts"]);
});

test("the console is touched by the logger alone", () => {
  assert.deepEqual(src.filter((f) => /\bconsole\./.test(text(f))).map(rel), ["core/shared/log.ts"]);
});

test("no auth code reads the user over the network per request: getClaims, never getUser, on the server", () => {
  const server = src.filter((f) => !f.endsWith(".tsx") && !f.includes("/ui/"));
  assert.deepEqual(server.filter((f) => /auth\.getUser\(/.test(text(f))), []);
});

test("every source file under src/core and src/features is under 400 lines", () => {
  for (const f of src) assert.ok(text(f).split("\n").length <= 400, `${f} is over 400 lines`);
});
