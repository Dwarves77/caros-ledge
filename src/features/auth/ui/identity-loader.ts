// Ported from old_repo/src/components/auth/identity-loader.ts (lines 1-110)
// Ported from old_repo/src/components/shell/bootstrap-seed.ts (lines 1-129)
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

/** Two retries after the first attempt (600 ms, then 1.8 s), then the round ends in the error seed. */
export const IDENTITY_RETRY_DELAYS_MS: readonly number[] = Object.freeze([600, 1800]);
export function nextIdentityRetryDelay(attemptsMade: number): number | null {
  if (attemptsMade < 1 || attemptsMade > IDENTITY_RETRY_DELAYS_MS.length) return null;
  return IDENTITY_RETRY_DELAYS_MS[attemptsMade - 1] ?? null;
}

export interface IdentityLoaderDeps {
  /** Resolves the parsed JSON body, or null when the response was not ok. */
  fetchIdentity: () => Promise<unknown>;
  onSeed: (seed: AuthSeed) => void;
  onRetrying?: (retrying: boolean) => void;
  schedule: (fn: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
}
export interface IdentityLoader {
  start: () => void;
  rearm: () => void;
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
    try {
      bootstrap = asBootstrap(await deps.fetchIdentity());
    } catch {
      bootstrap = null;
    }
    inFlight = false;
    if (stopped) return;
    attempts += 1;
    if (bootstrap) {
      apply(resolveAuthSeed(bootstrap));
      return setRetrying(false);
    }
    const delay = nextIdentityRetryDelay(attempts);
    if (delay === null) {
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
    rearm() {
      if (stopped || status !== "error" || inFlight || timer !== null) return;
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
