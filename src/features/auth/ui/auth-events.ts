import { requiresAuth } from "@/core/auth/route-policy";

import type { IdentityStatus } from "./identity-loader";

interface SessionLike {
  user?: unknown;
}
export interface AuthEventDeps {
  setUser: (user: unknown) => void;
  /** The identity loader, or null before it exists. */
  loader: () => { status: () => IdentityStatus; rearm: (manual?: boolean) => void } | null;
  /** Whether the identity lookup resolved a user (not what the auth client says). */
  identityHasUser: () => boolean;
  pathname: () => string;
  navigate: (to: string) => void;
  requiresAuth?: (pathname: string) => boolean;
}

/**
 * What the shell does with supabase-js auth events. Never reloads the document: on a fresh load with a stored session supabase-js emits SIGNED_IN
 * BEFORE INITIAL_SESSION, so any "reload on SIGNED_IN" fires on every load. A sign-in seen while identity resolved to no user re-fetches identity in
 * place; a sign-out goes to /login only from a route that needs a session (never reloads /login itself).
 */
export function createAuthEventHandler(deps: AuthEventDeps) {
  const needsAuth = deps.requiresAuth ?? requiresAuth;
  return (event: string, session: SessionLike | null): void => {
    deps.setUser(session?.user ?? null);
    if (event === "SIGNED_OUT") {
      if (needsAuth(deps.pathname())) deps.navigate("/login");
      return;
    }
    if (event === "SIGNED_IN" && session?.user) {
      const loader = deps.loader();
      if (loader && loader.status() === "resolved" && !deps.identityHasUser()) loader.rearm(true);
    }
  };
}
