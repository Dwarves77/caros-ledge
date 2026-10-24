import assert from "node:assert/strict";
import { test } from "node:test";

import { createAuthEventHandler } from "@/features/auth/ui/auth-events";
import { createIdentityLoader, type AuthSeed } from "@/features/auth/ui/identity-loader";

type Cb = (event: string, session: { user: { id: string } } | null) => void;
const SESSION = { user: { id: "u1" } };
const settle = () => new Promise((r) => setImmediate(r));
const identityBody = (user: { id: string } | null) => ({ user, orgId: user ? "o1" : null, orgName: "", role: null, sectors: [], workspaceSectors: [], isPlatformAdmin: false });

/** The provider's wiring over a fake supabase-js client that replays the REAL order of a fresh load with a stored session: the subscriber is registered
 * synchronously, then _recoverAndRefresh emits SIGNED_IN, and only after initialisation does INITIAL_SESSION arrive (auth-js GoTrueClient). */
function mount(identity: { id: string } | null, pathname = "/dashboard") {
  const log = { reloads: 0, hrefs: [] as string[], fetches: 0, users: [] as unknown[] };
  let known: { id: string } | null = null;
  const loader = createIdentityLoader({
    fetchIdentity: async () => ((log.fetches += 1), identityBody(identity)),
    onSeed: (s: AuthSeed) => void (known = s.user as { id: string } | null),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as never),
  });
  const handle = createAuthEventHandler({
    setUser: (u) => log.users.push(u),
    loader: () => loader,
    identityHasUser: () => known !== null,
    identityUserId: () => known?.id ?? null,
    pathname: () => pathname,
    navigate: (to) => log.hrefs.push(to),
  });
  let subscriber: Cb | null = null;
  const auth = { onAuthStateChange: (cb: Cb) => ((subscriber = cb), { data: { subscription: { unsubscribe() {} } } }) };
  auth.onAuthStateChange(handle as Cb);
  loader.start();
  return { log, loader, emit: (e: string, s: typeof SESSION | null) => subscriber?.(e, s) };
}

test("a fresh load with a stored session (SIGNED_IN, then INITIAL_SESSION) reloads nothing, navigates nowhere and fetches identity exactly once", async () => {
  const m = mount({ id: "u1" });
  m.emit("SIGNED_IN", SESSION);
  m.emit("INITIAL_SESSION", SESSION);
  await settle();
  assert.deepEqual([m.log.reloads, m.log.hrefs, m.log.fetches, m.loader.status()], [0, [], 1, "resolved"]);
});

test("identity resolved with no user, then SIGNED_IN with a session (another tab signed in): identity is re-fetched once in place, no reload", async () => {
  const m = mount(null);
  await settle();
  m.emit("INITIAL_SESSION", null);
  assert.equal(m.loader.status(), "resolved");
  m.emit("SIGNED_IN", SESSION);
  await settle();
  assert.deepEqual([m.log.reloads, m.log.hrefs, m.log.fetches], [0, [], 2]);
});

test("SIGNED_OUT on /login or another public route does not navigate; on a protected route it goes to /login", async () => {
  const onLogin = mount(null, "/login");
  onLogin.emit("SIGNED_OUT", null);
  assert.deepEqual(onLogin.log.hrefs, []);
  const onPrivacy = mount(null, "/privacy");
  onPrivacy.emit("SIGNED_OUT", null);
  assert.deepEqual(onPrivacy.log.hrefs, []);
  const onDash = mount({ id: "u1" }, "/dashboard");
  onDash.emit("SIGNED_OUT", null);
  assert.deepEqual(onDash.log.hrefs, ["/login"]);
});

test("identity resolved WITH a user is never re-fetched by SIGNED_IN events", async () => {
  const m = mount({ id: "u1" });
  await settle();
  m.emit("SIGNED_IN", SESSION);
  m.emit("SIGNED_IN", SESSION);
  await settle();
  assert.equal(m.log.fetches, 1);
});

test("identity resolved as user A, then another tab signs in as user C (SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED): identity is re-fetched and the tab goes home", async () => {
  for (const event of ["SIGNED_IN", "TOKEN_REFRESHED", "USER_UPDATED"]) {
    const m = mount({ id: "u1" });
    await settle();
    m.emit(event, { user: { id: "u3" } });
    await settle();
    assert.deepEqual([m.log.fetches, m.log.hrefs], [2, ["/"]], event);
  }
});

test("the same user's token refresh or profile update re-fetches nothing and navigates nowhere", async () => {
  const m = mount({ id: "u1" });
  await settle();
  m.emit("TOKEN_REFRESHED", SESSION);
  m.emit("USER_UPDATED", SESSION);
  m.emit("SIGNED_IN", SESSION);
  await settle();
  assert.deepEqual([m.log.fetches, m.log.hrefs], [1, []]);
});
