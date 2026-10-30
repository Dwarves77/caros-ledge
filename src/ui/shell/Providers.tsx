"use client";

// Ported from old_repo/src/app/layout.tsx (lines 31-76)
import { createContext, useContext, type ComponentType, type ReactNode } from "react";

import { applyWorkspaceSeed } from "@/core/workspace/store";

import { AppShell } from "./AppShell";
import { seedBootstrap, type WorkspaceBootstrapData } from "./bootstrap-store";
import { GlobalErrorReporter } from "./GlobalErrorReporter";
import type { AuthSeed, IdentityStatus } from "./identity-seed";
import { QueryProvider } from "./QueryProvider";
import { SurfaceNavProvider } from "./surface-nav";
import { seedUnreadCount } from "./use-unread-count";

export interface AuthContextValue { user: { id: string; email?: string | null } | null; orgId: string | null | undefined; loading: boolean; identityStatus: IdentityStatus; retryingIdentity: boolean; retryIdentity: () => void; isPlatformAdmin: boolean; signOut: () => Promise<void>; }

export const AuthContext = createContext<AuthContextValue>({ user: null, orgId: undefined, loading: true, identityStatus: "pending", retryingIdentity: false, retryIdentity: () => {}, isPlatformAdmin: false, signOut: async () => {} });
export const useAuth = () => useContext(AuthContext);

export type AuthProviderComponent = ComponentType<{ children: ReactNode; onSeed?: (seed: AuthSeed, raw?: unknown) => void }>;

/** The client tree under the root layout: one QueryClient, the auth provider seeded into the workspace store, the error reporter and the shell. A function prop cannot cross from the server layout, hence this client part. */
export function Providers({ children, assistant, Auth }: { children: ReactNode; assistant?: ReactNode; Auth: AuthProviderComponent }) {
  return (
    <QueryProvider>
      <Auth
        onSeed={(seed, raw) => {
          applyWorkspaceSeed(seed);
          if (!seed.user || !raw || typeof raw !== "object") return;
          const r = raw as { bootstrap?: WorkspaceBootstrapData | null; unreadCount?: number | null };
          if (r.bootstrap && typeof r.bootstrap === "object") seedBootstrap(seed.user.id, r.bootstrap);
          if ("unreadCount" in r) seedUnreadCount(typeof r.unreadCount === "number" ? r.unreadCount : null);
        }}
      >
        <GlobalErrorReporter />
        <SurfaceNavProvider>
          <AppShell {...(assistant ? { assistant } : {})}>{children}</AppShell>
        </SurfaceNavProvider>
      </Auth>
    </QueryProvider>
  );
}
