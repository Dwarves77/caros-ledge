// LIVE-GATE-1: mints the signed-in browser session the live gate reads. No password is typed anywhere: the service role asks Supabase Auth for a magic link for the admin account (auth.admin.generateLink), the token hash is
// exchanged for a session through the same cookie writer the app uses (@supabase/ssr), and the cookies are saved as a Playwright storage state at scripts/tmp/live-session.json (gitignored).
//
//   node scripts/ci/live-session.mjs [--base https://carosledge.com | http://localhost:3000] [--out scripts/tmp/live-session.json]
//
// Environment NAMES: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, LIVE_ADMIN_EMAIL (a workstation loads them with `node --env-file=<.env.local>`); VERCEL_AUTOMATION_BYPASS_SECRET is sent to the target origin only.
// Exit contract (src/core/harness/exit.ts): exit 2 only when a name is unset on a workstation; in CI an unset name is exit 1. Exit 1 also when the first navigation after sign-in still ends on /login, and then no session file is left behind.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { dirname } from "node:path";
import { parseArgs } from "node:util";

import { isMain } from "../lib/fs.mjs";

import { installBypass } from "./live/bypass.mjs";

export const SESSION_FILE = "scripts/tmp/live-session.json";
export const DEFAULT_BASE = "https://carosledge.com";
export const SESSION_NEEDS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "LIVE_ADMIN_EMAIL"];
const PATH_OF = (u) => new URL(u, "https://x.invalid").pathname;

/** The Playwright storage state for the cookies a session writer produced: scoped to the target host, secure only on https (the app's cookieOptions: lax, path /). Pure. */
export function storageStateOf(cookies, base, nowSec = Math.floor(Date.now() / 1000)) {
  const url = new URL(base);
  return {
    cookies: cookies.map(({ name, value, maxAge }) => ({ name, value, domain: url.hostname, path: "/", expires: nowSec + (maxAge ?? 400 * 86400), httpOnly: false, secure: url.protocol === "https:", sameSite: "Lax" })),
    origins: [],
  };
}

/** The session cookies for `email`: a magic link minted with the service role, its token hash exchanged through the app's own cookie writer. Throws with the Auth message (never a key or token). */
export async function mintCookies(env) {
  const { createClient } = await import("@supabase/supabase-js");
  const { createServerClient } = await import("@supabase/ssr");
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: env.LIVE_ADMIN_EMAIL });
  if (link.error || !link.data?.properties?.hashed_token) throw new Error(`generateLink failed: ${link.error?.message ?? "no token hash"}`);
  const jar = new Map();
  const ssr = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: { getAll: () => [...jar].map(([name, { value }]) => ({ name, value })), setAll: (list) => list.forEach(({ name, value, options }) => jar.set(name, { value, maxAge: options?.maxAge })) },
  });
  const done = await ssr.auth.verifyOtp({ type: "magiclink", token_hash: link.data.properties.hashed_token });
  if (done.error || !done.data?.session) throw new Error(`verifyOtp failed: ${done.error?.message ?? "no session"}`);
  return [...jar].filter(([, { value }]) => value).map(([name, { value, maxAge }]) => ({ name, value, maxAge }));
}

/** Opens `base` with the state and answers where it ended: { ok, path }. ok is false when the first navigation lands on /login. */
export async function landsSignedIn(state, base, env = process.env) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ storageState: state });
    await installBypass(ctx, base, env);
    const page = await ctx.newPage();
    await page.goto(`${base}/`, { waitUntil: "load", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    const path = PATH_OF(page.url());
    return { ok: !path.startsWith("/login"), path };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  register("../lib/ts-hooks.mjs", import.meta.url, { data: {} });
  const { skipVerdict, summarise } = await import("../../src/core/harness/exit.ts");
  const { values } = parseArgs({ options: { base: { type: "string" }, out: { type: "string", default: SESSION_FILE } }, strict: true });
  const env = process.env;
  const base = (values.base ?? env.LIVE_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, "");
  const verdict = skipVerdict(env, SESSION_NEEDS.filter((n) => !env[n]));
  if (verdict.message) {
    console.log(`live-session: ${verdict.message}`);
    summarise(env, "Live session", verdict);
    process.exit(verdict.exit);
  }
  rmSync(values.out, { force: true }); // a stale session must never stand in for the one this run failed to mint
  let state;
  try {
    state = storageStateOf(await mintCookies(env), base);
  } catch (e) {
    console.error(`live-session: could not mint a session: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const landed = await landsSignedIn(state, base, env);
  if (!landed.ok) {
    console.error(`live-session: the first navigation to ${base}/ after sign-in ended on ${landed.path}: the session is not accepted there`);
    process.exit(1);
  }
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, JSON.stringify(state));
  console.log(`live-session: signed in at ${base} (landed on ${landed.path}); ${state.cookies.length} cookie(s) saved to ${values.out}`);
}

if (isMain(import.meta.url)) await main();
