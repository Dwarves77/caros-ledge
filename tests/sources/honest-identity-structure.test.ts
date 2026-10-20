// R2c C1, INV-R2c-1 (structure half): no transport can send an identity other than the declared one because the code that could is gone, and the /bot page the identity points to says what a publisher needs to know.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import BotPage from "@/app/bot/page";
import { BOT_USER_AGENT, DECLARED_HEADERS } from "@/core/fetch/policy";
import { decideRoute } from "@/core/auth/route-policy";

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n).split("\\").join("/")]));
const code = [...walk("src"), ...walk("supabase/functions")].filter((f) => /\.(ts|tsx)$/.test(f));
const text = (f: string) => readFileSync(f, "utf8");
/** The code of a file without its comments, which are allowed to talk about identities. */
const bare = (f: string) => text(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const TRANSPORT_DIRS = ["src/core/fetch/", "src/features/sources/", "supabase/functions/"];

test("INV-R2c-1: the Chrome and Safari strings appear nowhere in the code, and the second fingerprint and its retry are gone", () => {
  for (const f of code) {
    const t = text(f);
    assert.doesNotMatch(t, /Mozilla\/\d|AppleWebKit|Chrome\/\d|Safari\/\d|Gecko\//, `${f} carries a browser identity`);
    assert.doesNotMatch(t, /ALT_HEADERS_ON_403|PRIMARY_HEADERS/, `${f} names the old fingerprints`);
  }
});
test("INV-R2c-1: one declared User-Agent in policy.ts; in the transport directories only the guard, the policy and the SEC string mention a user agent, and no GET bypasses the guard", () => {
  assert.equal(BOT_USER_AGENT, "CarosLedge/1.0 (+https://carosledge.com/bot)");
  assert.equal(DECLARED_HEADERS["User-Agent"], BOT_USER_AGENT);
  const owners = new Set(["src/core/fetch/policy.ts", "src/core/fetch/guard.ts", "src/core/fetch/honest.ts", "src/core/fetch/robots.ts"]);
  const transports = code.filter((f) => TRANSPORT_DIRS.some((d) => f.startsWith(d)));
  assert.ok(transports.length > 10);
  for (const f of transports) {
    if (!owners.has(f)) assert.doesNotMatch(bare(f), /user-agent/i, `${f} sets or names a user agent`);
    // A bare fetch( is a GET outside the guard. The three places that bind the global fetch to the guard are the only exceptions.
    if (!["src/core/fetch/guard.ts", "src/core/fetch/honest.ts", "supabase/functions/capture-worker/process.ts"].includes(f)) assert.doesNotMatch(bare(f), /(?<![.\w])fetch\(|\?\? fetch\b/, `${f} calls fetch outside the guard`);
  }
  assert.match(text("src/core/fetch/guard.ts"), /headers\.set\("User-Agent", g\.userAgent\)/, "the guard replaces whatever user agent a caller passed");
});
test("no archive, cache or proxy is read to pass a wall: the code names none", () => {
  for (const f of code.filter((x) => TRANSPORT_DIRS.some((d) => x.startsWith(d)))) assert.doesNotMatch(bare(f), /archive\.org|wayback|googleusercontent|webcache|HTTPS?_PROXY|proxyUrl|browserless/i, f);
});

test("the /bot page states what is collected, how often, how to opt out and the contact from the environment; it is public", () => {
  delete process.env.BOT_CONTACT_EMAIL;
  const unset = renderToStaticMarkup(BotPage());
  for (const s of ["What it collects", "How often", "Opting out", "User-agent: CarosLedge", "Disallow: /", "CarosLedge/1.0 (+https://carosledge.com/bot)", "robots.txt", "never solves a CAPTCHA"]) assert.ok(unset.replace(/&quot;|&#x27;/g, "").includes(s), s);
  assert.match(unset, /has not been set for this deployment yet/);
  process.env.BOT_CONTACT_EMAIL = "crawler@publisher-contact.test";
  try {
    assert.match(renderToStaticMarkup(BotPage()), /mailto:crawler@publisher-contact\.test/);
  } finally {
    delete process.env.BOT_CONTACT_EMAIL;
  }
  assert.deepEqual(decideRoute({ pathname: "/bot", authenticated: false }), { action: "allow" });
});
