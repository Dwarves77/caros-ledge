"use client";

// Ported from old_repo/src/lib/hooks/useAdminAttention.ts (lines 1-278)
import { useEffect } from "react";

import { refreshBootstrap, useBootstrapStore, type AdminAttentionCounts } from "./use-bootstrap";

export const ADMIN_ATTENTION_POLL_MS = 60_000;

/**
 * The admin attention counts, read from the bootstrap bundle (one source, not a second poll). A platform admin's bundle is refreshed once a minute while the
 * tab is visible; everyone else never polls. `counts` is null when unknown (not an admin, or the read degraded), never a zero.
 */
export function useAdminAttention(enabled: boolean): { counts: AdminAttentionCounts | null; total: number } {
  const counts = useBootstrapStore((s) => s.data?.adminAttention ?? null);
  useEffect(() => {
    if (!enabled) return;
    const tick = () => document.visibilityState === "visible" && refreshBootstrap();
    const id = setInterval(tick, ADMIN_ATTENTION_POLL_MS);
    return () => clearInterval(id);
  }, [enabled]);
  return { counts: enabled ? counts : null, total: enabled ? (counts?.total ?? 0) : 0 };
}
