import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";

import * as auth from "@/core/auth";
import * as db from "@/core/db";
import * as http from "@/core/http";
import * as shared from "@/core/shared";

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const src = files("src").map((f) => f.split(sep).join("/")).filter((f) => /\.(ts|tsx)$/.test(f));
const rel = (f: string): string => relative("src", f).split(sep).join("/");
const text = (f: string) => readFileSync(f, "utf8");

test("PROP-001/160: every route handler is behind a guard, or is one of the two public auth endpoints", () => {
  const publicRoutes = new Set(["src/features/auth/api/identity.ts", "src/features/auth/api/callback.ts"]);
  // Public by documented exception (operator-approved 2026-07-11): build metadata only, no database, no parameters, nothing to limit.
  const documentedPublic = new Set(["src/features/telemetry/api/version.ts"]);
  const routes = src.filter((f) => f.endsWith("/route.ts"));
  assert.ok(routes.length >= 11, `found ${routes.length} routes`);
  for (const route of routes) {
    const target = /from "@\/(features\/[^"]+)"/.exec(text(route))?.[1];
    assert.ok(target, `${route} re-exports a feature handler`);
    const handler = `src/${target}.ts`;
    const body = text(handler);
    if (documentedPublic.has(handler)) continue;
    if (publicRoutes.has(handler)) assert.match(body, /checkRateLimit/, `${handler} is public, so it must rate limit`);
    else assert.match(body, /requireUser|requireAdmin|requireOrgRole|runCollab|workerAuthGuard|withToken/, `${handler} has no guard`);
  }
});

test("PROP-028/127 and PROP-011/109: one module attaches the bearer, one factory builds service clients", () => {
  const mentions = (re: RegExp) => src.filter((f) => re.test(text(f))).map(rel).sort();
  assert.deepEqual(mentions(/authorization/i), ["core/db/clients.ts", "core/http/authed-fetch.ts"]);
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

test("the interface the brief names exists", () => {
  const has = (mod: object, names: string[]) => assert.deepEqual(names.filter((n) => !(n in mod)), []);
  has(http, ["requireUser", "requireAdmin", "requireOrgRole", "isRefusal", "HttpError", "rateLimitHeaders", "parseJson", "uuid", "email"]);
  has(db, ["userClient", "serviceClient", "boundedRead", "withTimeout", "keyset", "SCHEMA_KEYS"]);
  has(auth, ["getClaims", "currentMembership", "ensureProfile", "resolveIdentity", "decideRoute", "sanitizeReturnPath", "isPlatformAdmin"]);
  has(shared, ["log", "captureError", "withErrorCapture", "sendInvitationEmail", "formatDate", "isoWeek", "htmlToText", "slugify", "canonicalUrl", "hostOf", "domainForItemType", "resolveItemUuid"]);
});

test("every source file under src/core and src/features is under 400 lines", () => {
  for (const f of src) assert.ok(text(f).split("\n").length <= 400, `${f} is over 400 lines`);
});
