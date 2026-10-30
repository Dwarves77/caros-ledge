import { requiresAuth } from "@/core/auth/route-policy";

import type { IdentityStatus } from "./identity-loader";

interface SessionLike {
  user?: unknown;
}
export interface AuthEventDeps {
  setUser: (user: unknown) => void;
  /** The identity loader, or null before it exists. */
  loader: () => { status: () => IdentityStatus; rearm: (manual?: boolean, replace?: boolean) => void } | null;
  /** Whether the identity lookup resolved a user (not what the auth client says). */
  identityHasUser: () => boolean;
  /** The id of the user the identity lookup resolved, or null when none. */
  identityUserId: () => string | null;
  pathname: () => string;
  navigate: (to: string) => void;

}

/**
 * What the shell does with supabase-js auth events. Never reloads the document: on a fresh load with a stored session supabase-js emits SIGNED_IN
 * BEFORE INITIAL_SESSION, so any "reload on SIGNED_IN" fires on every load. A sign-in seen while identity resolved to no user re-fetches identity in
 * place; a sign-out goes to /login only from a route that needs a session (never reloads /login itself). A session for a DIFFERENT user than the one this tab
 * resolved (another tab signed in as someone else) replaces the identity and sends the tab home: its org, role and admin nav belong to the old user.
 */
export function createAuthEventHandler(deps: AuthEventDeps) {

  return (event: string, session: SessionLike | null): void => {
    deps.setUser(session?.user ?? null);
    if (event === "SIGNED_OUT") {
      if (requiresAuth(deps.pathname())) deps.navigate("/login");
      return;
    }
    const signedIn = event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED";
    if (!signedIn || !session?.user) return;
    const loader = deps.loader();
    if (!loader || loader.status() !== "resolved") return;
    if (!deps.identityHasUser()) {
      if (event === "SIGNED_IN") loader.rearm(true);
      return;
    }
    const known = deps.identityUserId();
    const incoming = (session.user as { id?: unknown }).id;
    if (known !== null && typeof incoming === "string" && incoming !== known) {
      loader.rearm(true, true);
      deps.navigate("/");
    }
  };
}
