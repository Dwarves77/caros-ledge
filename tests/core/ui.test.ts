import assert from "node:assert/strict";
import { test } from "node:test";

import { createIdentityLoader, IDENTITY_ERROR_SEED, nextIdentityRetryDelay, resolveAuthSeed, shouldApplySeed, shouldShowAdminNav, type AuthSeed } from "@/features/auth/ui/identity-loader";
import { authSentence, isAlreadyRegistered } from "@/features/auth/ui/auth-sentences";

const body = (over: Record<string, unknown> = {}) => ({ user: { id: "u1", email: "a@b.test" }, orgId: "o1", orgName: "Acme", role: "owner", sectors: [], workspaceSectors: ["air"], isPlatformAdmin: true, ...over });

function harness(responses: unknown[]) {
  const seeds: AuthSeed[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  let fetches = 0;
  const loader = createIdentityLoader({
    fetchIdentity: async () => {
      const next = responses[Math.min(fetches, responses.length - 1)];
      fetches += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    onSeed: (s) => seeds.push(s),
    schedule: (fn, ms) => {
      const t = { fn, ms, live: true };
      timers.push(t);
      return t;
    },
    cancel: (h) => ((h as { live: boolean }).live = false),
  });
  const fire = async () => {
    const t = timers.find((x) => x.live);
    if (!t) return false;
    t.live = false;
    t.fn();
    await new Promise((r) => setImmediate(r));
    return true;
  };
  return { loader, seeds, timers, fire, fetches: () => fetches };
}
const settle = () => new Promise((r) => setImmediate(r));

test("identity loader: a failed lookup retries at 1 s, 2 s and 4 s (three retries) and settles as an error, never as 'no workspace'", async () => {
  const h = harness([null, new Error("net"), null, null, null]);
  h.loader.start();
  await settle();
  assert.deepEqual(h.timers.map((t) => t.ms), [1000]);
  await h.fire();
  assert.deepEqual(h.timers.map((t) => t.ms), [1000, 2000]);
  await h.fire();
  assert.deepEqual(h.timers.map((t) => t.ms), [1000, 2000, 4000]);
  await h.fire();
  assert.equal(h.seeds.length, 1);
  assert.deepEqual(h.seeds[0], IDENTITY_ERROR_SEED);
  assert.equal(h.seeds[0]?.orgId, undefined, "orgId stays unknown, it is not null");
  assert.equal(h.loader.status(), "error");
  assert.equal(h.fetches(), 4, "one attempt and three retries, never more");
});

test("identity loader: a resolved seed is final, focus re-arms an errored loader, stop cancels the timer", async () => {
  const ok = harness([body()]);
  ok.loader.start();
  await settle();
  assert.equal(ok.seeds[0]?.status, "resolved");
  assert.deepEqual([ok.seeds[0]?.orgId, ok.seeds[0]?.sectors, ok.seeds[0]?.isPlatformAdmin], ["o1", ["air"], true]);
  ok.loader.rearm();
  await settle();
  assert.equal(ok.fetches(), 1, "rearm does nothing once resolved");

  const recover = harness([null, null, null, null, body()]);
  recover.loader.start();
  await settle();
  await recover.fire();
  await recover.fire();
  await recover.fire();
  assert.equal(recover.loader.status(), "error");
  recover.loader.rearm();
  await settle();
  assert.equal(recover.loader.status(), "error", "a focus event inside the cooldown does not start a new round");
  recover.loader.rearm(true);
  await settle();
  assert.equal(recover.loader.status(), "resolved");
  assert.equal(recover.seeds.at(-1)?.status, "resolved");

  const stopping = harness([null]);
  stopping.loader.start();
  await settle();
  stopping.loader.stop();
  assert.equal(stopping.timers[0]?.live, false);
});

test("identity seed: signed-out identity has an unknown org, a malformed body is an error, the admin nav needs a resolved admin", () => {
  assert.equal(resolveAuthSeed(body({ user: null }) as never).orgId, undefined);
  assert.equal(resolveAuthSeed(body({ user: null }) as never).isPlatformAdmin, false);
  assert.equal(resolveAuthSeed(null), IDENTITY_ERROR_SEED);
  assert.equal(nextIdentityRetryDelay(0), null);
  assert.deepEqual([1, 2, 3].map((n) => nextIdentityRetryDelay(n)), [1000, 2000, 4000]);
  assert.equal(nextIdentityRetryDelay(4), null);
  assert.equal(shouldApplySeed("resolved"), false);
  assert.equal(shouldShowAdminNav({ status: "resolved", isPlatformAdmin: true }), true);
  assert.equal(shouldShowAdminNav({ status: "error", isPlatformAdmin: true }), false);
});

test("sign-in failures: a wrong password, an unknown address and an unconfirmed address answer one sentence; every other failure answers the unavailable sentence", () => {
  const invalid = authSentence({ message: "Invalid login credentials", code: "invalid_credentials" });
  assert.equal(invalid, "That e-mail and password do not match.");
  assert.equal(authSentence({ message: "Email not confirmed", code: "email_not_confirmed" }), invalid, "an unconfirmed address reads as a wrong password");
  assert.equal(authSentence({ message: "Invalid login credentials" }), invalid, "the message alone classifies when a client sends no code");
  assert.equal(authSentence({ message: "Email not confirmed" }), invalid);
  assert.equal(authSentence({ message: "Signups not allowed for otp" }), "Sign-in is not available right now; try again in a minute.");
  assert.equal(authSentence({ message: "Email rate limit exceeded", code: "over_email_send_rate_limit" }), "Sign-in is not available right now; try again in a minute.");
  assert.equal(authSentence({}), "Sign-in is not available right now; try again in a minute.");
});

test("sign-up: an already-registered address is never told apart (an error naming it counts as a sent confirmation)", () => {
  assert.equal(isAlreadyRegistered({ message: "User already registered", code: "user_already_exists" }), true);
  assert.equal(isAlreadyRegistered({ message: "User already registered" }), true);
  assert.equal(isAlreadyRegistered({ message: "Password should be at least 8 characters", code: "weak_password" }), false);
});
