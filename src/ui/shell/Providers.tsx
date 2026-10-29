"use client";

// Ported from old_repo/src/app/layout.tsx (lines 31-76)
import type { ReactNode } from "react";

import { applyWorkspaceSeed } from "@/core/workspace/store";
import { AuthProvider } from "@/features/auth/ui/AuthProvider";

import { AppShell } from "./AppShell";
import { seedBootstrap, type WorkspaceBootstrapData } from "./bootstrap-store";
import { GlobalErrorReporter } from "./GlobalErrorReporter";
import { QueryProvider } from "./QueryProvider";
import { SurfaceNavProvider } from "./surface-nav";
import { seedUnreadCount } from "./use-unread-count";

/** The client tree under the root layout: one QueryClient, the auth provider seeded into the workspace store, the error reporter and the shell. A function prop cannot cross from the server layout, hence this client part. */
export function Providers({ children, assistant }: { children: ReactNode; assistant?: ReactNode }) {
  return (
    <QueryProvider>
      <AuthProvider
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
      </AuthProvider>
    </QueryProvider>
  );
}
