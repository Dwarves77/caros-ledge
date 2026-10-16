// Ported from old_repo/src/components/auth/identity-loader.ts (lines 1-110)
// Ported from old_repo/src/components/shell/bootstrap-seed.ts (lines 1-129)
import { RetryableError, retryDelayMs } from "@/core/http/backoff";
import type { IdentityBootstrap, OrgRole } from "@/core/types";

export type IdentityStatus = "pending" | "resolved" | "error";

/** What the client applies once identity has resolved (or failed for good). `orgId` is three-valued: undefined = not yet known, null = known to have no workspace. */
export interface AuthSeed {
  status: Exclude<IdentityStatus, "pending">;
  user: IdentityBootstrap["user"];
  orgId: string | null | undefined;
  orgName: string;
  role: OrgRole | null;
  sectors: string[];
  isPlatformAdmin: boolean;
}

export const IDENTITY_ERROR_SEED: AuthSeed = Object.freeze({ status: "error", user: null, orgId: undefined, orgName: "", role: null, sectors: [], isPlatformAdmin: false });

export function resolveAuthSeed(bootstrap: IdentityBootstrap | null): AuthSeed {
  if (!bootstrap) return IDENTITY_ERROR_SEED;
  return {
    status: "resolved",
    user: bootstrap.user,
    orgId: bootstrap.user ? bootstrap.orgId : undefined,
    orgName: bootstrap.orgName,
    role: bootstrap.role,
    sectors: bootstrap.sectors.length > 0 ? bootstrap.sectors : bootstrap.workspaceSectors,
    isPlatformAdmin: !!bootstrap.user && bootstrap.isPlatformAdmin === true,
  };
}

/** A later seed never overwrites a resolved one. */
export const shouldApplySeed = (current: IdentityStatus): boolean => current !== "resolved";
export const shouldShowAdminNav = (p: { status: IdentityStatus; isPlatformAdmin: boolean }): boolean => p.status === "resolved" && p.isPlatformAdmin === true;

/** Three retries after the first attempt (1 s, 2 s, 4 s; a Retry-After wins when longer), then the round ends in the error seed. */
export const nextIdentityRetryDelay = retryDelayMs;
/** A focus or visibility event re-arms an errored loader at most this often; the Retry control is never throttled. */
export const IDENTITY_REARM_COOLDOWN_MS = 30_000;

export interface IdentityLoaderDeps {
  /** Resolves the parsed JSON body; a failed response throws a RetryableError (core/http/backoff) so its Retry-After is honoured. */
  fetchIdentity: () => Promise<unknown>;
  onSeed: (seed: AuthSeed) => void;
  onRetrying?: (retrying: boolean) => void;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
  now?: () => number;
}
export interface IdentityLoader {
  start: () => void;
  /** `manual` is the Retry control; an automatic re-arm (focus, visibility) waits out the cooldown after a failure. */
  rearm: (manual?: boolean) => void;
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
  const now = deps.now ?? Date.now;

  const setRetrying = (v: boolean) => {
    if (retrying === v) return;
    retrying = v;
    deps.onRetrying?.(v);
  };
  const apply = (seed: AuthSeed) => {
    if (!shouldApplySeed(status)) return;
    status = seed.status;
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
    const delay = final ? null : retryDelayMs(attempts, retryAfterMs);
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
    rearm(manual = false) {
      if (stopped || status !== "error" || inFlight || timer !== null) return;
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
