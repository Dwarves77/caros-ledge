"use client";

// Ported from old_repo/src/app/layout.tsx (lines 31-76)
import type { ReactNode } from "react";

import { applyWorkspaceSeed } from "@/core/workspace";
import { AuthProvider } from "@/features/auth/ui/AuthProvider";

import { AppShell } from "./AppShell";
import { GlobalErrorReporter } from "./GlobalErrorReporter";
import { QueryProvider } from "./QueryProvider";
import { SurfaceNavProvider } from "./surface-nav";

/** The client tree under the root layout: one QueryClient, the auth provider seeded into the workspace store, the error reporter and the shell. A function prop cannot cross from the server layout, hence this client part. */
export function Providers({ children, assistant }: { children: ReactNode; assistant?: ReactNode }) {
  return (
    <QueryProvider>
      <AuthProvider onSeed={applyWorkspaceSeed}>
        <GlobalErrorReporter />
        <SurfaceNavProvider>
          <AppShell {...(assistant ? { assistant } : {})}>{children}</AppShell>
        </SurfaceNavProvider>
      </AuthProvider>
    </QueryProvider>
  );
}
