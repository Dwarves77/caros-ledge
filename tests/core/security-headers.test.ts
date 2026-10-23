// Audit 2.3.8: browser security headers. The fixed ones are next.config.ts's `headers()`; the Content-Security-Policy is built per request in the proxy from src/core/http/csp.ts (the project's origin comes from the environment at request time).
// Scripts allow 'unsafe-inline' and not a nonce: a nonce cannot be stamped on a prerendered page, and the login, sign-up, privacy and reset pages are prerendered (the browser blocks every script on them: see the PR).
import assert from "node:assert/strict";
import { test } from "node:test";

import { NextRequest } from "next/server";

import { contentSecurityPolicy } from "@/core/http/csp";
import { proxy } from "@/proxy";

import config from "../../next.config.ts";
import { fakeDb, signedIn, signedOut } from "../_support/fake-db.ts";
import { scripted } from "../_support/fake-clients.ts";

const SUPABASE = "https://placeholder.supabase.co";
const directive = (csp: string, name: string): string[] => (csp.split(";").map((d) => d.trim().split(/\s+/)).find(([n]) => n === name) ?? []).slice(1);

test("next.config.ts: the X-Powered-By header is off and every route carries the five fixed security headers with their exact values", async () => {
  assert.equal(config.poweredByHeader, false);
  const rules = await config.headers?.();
  assert.equal(rules?.length, 1, "one rule");
  assert.equal(rules?.[0]?.source, "/(.*)");
  const got = Object.fromEntries((rules?.[0]?.headers ?? []).map((h) => [h.key, h.value]));
  assert.deepEqual(got, {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  });
});

test("contentSecurityPolicy: default-deny, this site and the project's own origin for data, the map tiles for images, no frames, no plugins", () => {
  const csp = contentSecurityPolicy({ supabaseOrigin: SUPABASE, production: true });
  assert.deepEqual(directive(csp, "default-src"), ["'self'"]);
  assert.deepEqual(directive(csp, "script-src"), ["'self'", "'unsafe-inline'"], "production allows no eval and no remote script host");
  assert.deepEqual(directive(csp, "style-src"), ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(directive(csp, "img-src"), ["'self'", "data:", "https://*.tile.openstreetmap.org", SUPABASE]);
  assert.deepEqual(directive(csp, "connect-src"), ["'self'", SUPABASE]);
  assert.deepEqual(directive(csp, "font-src"), ["'self'"]);
  assert.deepEqual(directive(csp, "object-src"), ["'none'"]);
  assert.deepEqual(directive(csp, "base-uri"), ["'self'"]);
  assert.deepEqual(directive(csp, "form-action"), ["'self'"]);
  assert.deepEqual(directive(csp, "frame-ancestors"), ["'none'"]);
  assert.deepEqual(directive(contentSecurityPolicy({ supabaseOrigin: SUPABASE, production: false }), "script-src"), ["'self'", "'unsafe-inline'", "'unsafe-eval'"], "the dev server needs eval");
  assert.deepEqual(directive(contentSecurityPolicy({ supabaseOrigin: null, production: true }), "connect-src"), ["'self'"], "no project origin, no entry (never the string 'null')");
});

test("proxy: every response (served, redirected, the 503 page) carries the Content-Security-Policy built from this request's environment", async () => {
  const cspOf = (res: Response) => res.headers.get("Content-Security-Policy") ?? "";
  const nodeEnv = process.env.NODE_ENV;
  Reflect.set(process.env, "NODE_ENV", "production");
  scripted.request = () => fakeDb(undefined, { claims: signedOut }).db;
  const login = await proxy(new NextRequest("https://app.example.test/login"));
  assert.equal(login.status, 200);
  assert.deepEqual(directive(cspOf(login), "frame-ancestors"), ["'none'"]);
  assert.deepEqual(directive(cspOf(login), "script-src"), ["'self'", "'unsafe-inline'"]);
  assert.ok(directive(cspOf(login), "connect-src").includes(SUPABASE), "derived from NEXT_PUBLIC_SUPABASE_URL at request time");
  assert.equal(login.headers.get("x-middleware-request-x-nonce"), null, "no nonce is minted: nothing could use it");
  const saved = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://other-project.supabase.co/rest/v1?x=1";
  try {
    assert.deepEqual(directive(cspOf(await proxy(new NextRequest("https://app.example.test/login"))), "connect-src"), ["'self'", "https://other-project.supabase.co"], "origin only: no path, no query");
  } finally {
    process.env.NEXT_PUBLIC_SUPABASE_URL = saved;
  }
  const redirect = await proxy(new NextRequest("https://app.example.test/dashboard"));
  assert.equal(redirect.status, 307);
  assert.match(redirect.headers.get("location") ?? "", /\/login\?redirect=%2Fdashboard$/);
  assert.deepEqual(directive(cspOf(redirect), "frame-ancestors"), ["'none'"]);
  scripted.request = () => fakeDb(undefined, { claims: { data: null, error: { name: "AuthRetryableFetchError", status: 503, message: "down" } } }).db;
  const unavailable = await proxy(new NextRequest("https://app.example.test/dashboard"));
  assert.equal(unavailable.status, 503);
  assert.deepEqual(directive(cspOf(unavailable), "frame-ancestors"), ["'none'"]);
  scripted.request = () => fakeDb(undefined, { claims: signedIn("u1") }).db;
  const inside = await proxy(new NextRequest("https://app.example.test/dashboard"));
  assert.equal(inside.status, 200);
  assert.deepEqual(directive(cspOf(inside), "default-src"), ["'self'"]);
  if (nodeEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV");
  else Reflect.set(process.env, "NODE_ENV", nodeEnv);
});
