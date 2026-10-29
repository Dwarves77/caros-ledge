"use client";

// Ported from old_repo/src/components/auth/AuthProvider.tsx (lines 130-260)
import type { User } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { browserClient } from "@/core/db/browser";
import { failureOf } from "@/core/http/backoff";

import { createAuthEventHandler } from "./auth-events";
import { createIdentityLoader, type AuthSeed, type IdentityLoader, type IdentityStatus } from "./identity-loader";

interface AuthContextValue {
  user: User | null;
  /** undefined while identity is unresolved, null once known to have no workspace, else the active org. */
  orgId: string | null | undefined;
  loading: boolean;
  identityStatus: IdentityStatus;
  retryingIdentity: boolean;
  retryIdentity: () => void;
  isPlatformAdmin: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({ user: null, orgId: undefined, loading: true, identityStatus: "pending", retryingIdentity: false, retryIdentity: () => {}, isPlatformAdmin: false, signOut: async () => {} });

/**
 * Client auth context: seeds identity from /api/auth/identity with bounded retry, keeps tabs in sync, signs out.
 * `onSeed` hands the resolved workspace (org, role, sectors) to the workspace store, which this slice does not know.
 */
export function AuthProvider({ children, onSeed }: { children: ReactNode; onSeed?: (seed: AuthSeed, raw?: unknown) => void }) {
  const [user, setUser] = useState<User | null>(null);
  const [orgId, setOrgId] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus>("pending");
  const [retryingIdentity, setRetryingIdentity] = useState(false);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const loaderRef = useRef<IdentityLoader | null>(null);
  const knownUserRef = useRef<User | null>(null);
  const lastRawRef = useRef<unknown>(null);

  const seed = useCallback(
    (applied: AuthSeed) => {
      setIdentityStatus(applied.status);
      setLoading(false);
      if (applied.status === "error") {
        setOrgId(undefined);
        setIsPlatformAdmin(false);
        return;
      }
      knownUserRef.current = applied.user as User | null;
      setUser(applied.user as User | null);
      setOrgId(applied.orgId);
      setIsPlatformAdmin(applied.isPlatformAdmin);
      onSeed?.(applied, lastRawRef.current);
    },
    [onSeed],
  );

  useEffect(() => {
    const loader = createIdentityLoader({
      fetchIdentity: async () => {
        const chromeless = /^\/(login|signup|auth|onboarding|invitations|privacy|bot)(\/|$)/.test(window.location.pathname);
        const r = await fetch("/api/auth/identity", { credentials: "same-origin", cache: "no-store", headers: chromeless ? {} : { "x-shell-bundle": "1" } });
        if (!r.ok) throw failureOf(r.status, r.headers.get("Retry-After"));
        const json: unknown = await r.json();
        lastRawRef.current = json;
        return json;
      },
      onSeed: seed,
      onRetrying: setRetryingIdentity,
      schedule: (fn, ms) => window.setTimeout(fn, ms),
      cancel: (handle) => window.clearTimeout(handle as number),
    });
    loaderRef.current = loader;
    loader.start();
    const onFocus = () => loader.rearm();
    const onVisibility = () => document.visibilityState === "visible" && loader.rearm();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      loader.stop();
      loaderRef.current = null;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [seed]);

  // Cross-tab sync, never a document reload (see auth-events.ts): a sign-out elsewhere leaves a protected route for /login; a sign-in elsewhere re-fetches identity in place.
  useEffect(() => {
    const handle = createAuthEventHandler({
      setUser: (user) => setUser(user as User | null),
      loader: () => loaderRef.current,
      identityHasUser: () => knownUserRef.current !== null,
      identityUserId: () => knownUserRef.current?.id ?? null,
      pathname: () => window.location.pathname,
      navigate: (to) => void (window.location.href = to),
    });
    const { data: { subscription } } = browserClient().auth.onAuthStateChange(handle);
    return () => subscription.unsubscribe();
  }, []);

  const retryIdentity = useCallback(() => loaderRef.current?.rearm(true), []);
  const signOut = async () => {
    await browserClient().auth.signOut();
    window.location.href = "/login";
  };

  return <AuthContext.Provider value={{ user, orgId, loading, identityStatus, retryingIdentity, retryIdentity, isPlatformAdmin, signOut }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
