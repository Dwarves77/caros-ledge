"use client";

// Ported from old_repo/src/components/list-surface/ListSurfaceShell.tsx (lines 642-677)
import { useCallback, useEffect, useMemo, useState } from "react";

export type RemainderState = "idle" | "loading" | "ready" | "failed";

/**
 * The first page plus the remainder, with an explicit failed state and Retry. The old hook turned a failed remainder into an empty rest, so a list silently
 * stayed at the first page (B-0155); here a failure is a state the surface says out loud. Rows are de-duplicated by id against the first page.
 */
export function useListRows<T extends { id: string }>(firstPage: T[], fetchRest: () => Promise<T[]>, enabled: boolean): { rows: T[]; state: RemainderState; loadingMore: boolean; failed: boolean; retry: () => void } {
  const [rest, setRest] = useState<T[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Reset in a task, not synchronously in the effect body.
    const reset = setTimeout(() => (setRest(null), setFailed(false)), 0);
    fetchRest().then(
      (r) => !cancelled && setRest(r),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
      clearTimeout(reset);
    };
    // fetchRest is the caller's closure; `attempt` is the retry key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, attempt]);
  const rows = useMemo(() => {
    if (!rest) return firstPage;
    const seen = new Set(firstPage.map((r) => r.id));
    return [...firstPage, ...rest.filter((r) => !seen.has(r.id))];
  }, [firstPage, rest]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const state: RemainderState = !enabled ? "idle" : failed ? "failed" : rest === null ? "loading" : "ready";
  return { rows, state, loadingMore: state === "loading", failed: state === "failed", retry };
}
