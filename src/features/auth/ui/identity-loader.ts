// Ported from old_repo/src/components/auth/identity-loader.ts (lines 1-110)
// Ported from old_repo/src/components/shell/bootstrap-seed.ts (lines 1-129)
import { RetryableError } from "@/core/http/backoff";
import type { IdentityBootstrap } from "@/core/types";
import { IDENTITY_ERROR_SEED, nextIdentityRetryDelay, resolveAuthSeed, shouldApplySeed, type AuthSeed, type IdentityStatus } from "@/ui/shell/identity-seed";

export { IDENTITY_ERROR_SEED, nextIdentityRetryDelay, resolveAuthSeed, shouldApplySeed, shouldShowAdminNav } from "@/ui/shell/identity-seed";
export type { AuthSeed, IdentityStatus };

/** A focus or visibility event re-arms an errored loader at most this often; the Retry control is never throttled. */
const IDENTITY_REARM_COOLDOWN_MS = 30_000;

export interface IdentityLoaderDeps {
  /** Resolves the parsed JSON body; a failed response throws a RetryableError (core/http/backoff) so its Retry-After is honoured. */
  fetchIdentity: () => Promise<unknown>;
  onSeed: (seed: AuthSeed) => void;
  onRetrying?: ((retrying: boolean) => void) | null;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  now?: () => number;
}
export interface IdentityLoader {
  start: () => void;
  /** `manual` is the Retry control or a sign-in seen from another tab; an automatic re-arm (focus, visibility) waits out the cooldown after a failure. */
  rearm: (manual?: boolean, replace?: boolean) => void;
  stop: () => void;
  status: () => IdentityStatus;
}

function asBootstrap(body: unknown): IdentityBootstrap | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Partial<IdentityBootstrap>;
  return "user" in b && "orgId" in b && Array.isArray(b.sectors) && Array.isArray(b.workspaceSectors) ? (b as IdentityBootstrap) : null;
}

/** Bounded-retry identity loading with an injected clock: a failed lookup retries, then settles as an error seed (never "no workspace"); a focus or visibility event re-arms an errored loader. */
export function createIdentityLoader(deps: IdentityLoaderDeps): IdentityLoader {
  let status: IdentityStatus = "pending";
  let attempts = 0;
  let inFlight = false;
  let timer: unknown = null;
  let stopped = false;
  let retrying = false;
  let failedAt = 0;
  let resolvedWithoutUser = false;
  const now = deps.now ?? Date.now;

  const setRetrying = (v: boolean) => {
    if (retrying === v) return;
    retrying = v;
    deps.onRetrying?.(v);
  };
  const apply = (seed: AuthSeed) => {
    if (!shouldApplySeed(status)) return;
    status = seed.status;
    resolvedWithoutUser = seed.status === "resolved" && seed.user === null;
    deps.onSeed(seed);
  };
  const attempt = async (): Promise<void> => {
    if (stopped || status === "resolved") return;
    inFlight = true;
    let bootstrap: IdentityBootstrap | null = null;
    let retryAfterMs: number | null = null;
    let final = false;
    try {
      bootstrap = asBootstrap(await deps.fetchIdentity());
    } catch (e) {
      bootstrap = null;
      if (e instanceof RetryableError) {
        retryAfterMs = e.retryAfterMs;
        final = !e.retryable;
      }
    }
    inFlight = false;
    if (stopped) return;
    attempts += 1;
    if (bootstrap) {
      apply(resolveAuthSeed(bootstrap));
      return setRetrying(false);
    }
    const delay = final ? null : nextIdentityRetryDelay(attempts, retryAfterMs);
    if (delay === null) {
      failedAt = now();
      apply(IDENTITY_ERROR_SEED);
      return setRetrying(false);
    }
    timer = deps.schedule(() => {
      timer = null;
      void attempt();
    }, delay);
  };

  return {
    start() {
      if (stopped || inFlight || timer !== null || attempts > 0) return;
      void attempt();
    },
    rearm(manual = false, replace = false) {
      // An errored round re-arms; so does a resolved-with-no-user identity when a session appears (another tab signed in), fetched in place;
      // so does a resolved identity the caller says belongs to a user who has since been replaced (`replace`: another tab signed in as someone else).
      const signedInElsewhere = manual && status === "resolved" && (resolvedWithoutUser || replace);
      if (stopped || (status !== "error" && !signedInElsewhere) || inFlight || timer !== null) return;
      if (signedInElsewhere) status = "pending";
      if (!manual && now() - failedAt < IDENTITY_REARM_COOLDOWN_MS) return;
      attempts = 0;
      setRetrying(true);
      void attempt();
    },
    stop() {
      stopped = true;
      if (timer !== null) deps.cancel(timer);
      timer = null;
    },
    status: () => status,
  };
}
