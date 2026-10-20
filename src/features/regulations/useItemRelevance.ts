"use client";

// Ported from old_repo/src/components/regulations/BindingBanner.tsx (lines 109-124)
// Ported from old_repo/src/components/shell/RelevanceBadgeClient.tsx (lines 1-47)
// ONE fetch of /api/detail/relevance per item per page, shared by the binding banner and the relevance card (the old tree sent the same request twice on every detail render). The in-flight
// request is held by item id; a failure is never kept (Retry asks again).
import { useCallback, useEffect, useState } from "react";

import { requestJson } from "@/core/http/request-json";
import type { ItemRelevance, ObligationBinding } from "@/core/workspace";

export interface RelevanceResponse {
  relevance: ItemRelevance | null;
  binding: ObligationBinding | null;
}
export type RelevanceFetch = { phase: "loading" } | { phase: "failed" } | { phase: "ready"; data: RelevanceResponse };

const inflight = new Map<string, Promise<RelevanceResponse | null>>();

/** The relevance response for an item, or null when the call failed. Concurrent callers for one item share one request. */
function fetchRelevance(itemId: string): Promise<RelevanceResponse | null> {
  const held = inflight.get(itemId);
  if (held) return held;
  const p = requestJson<RelevanceResponse>(`/api/detail/relevance?itemId=${encodeURIComponent(itemId)}`).then((r) => (r.ok && r.data ? r.data : null));
  inflight.set(itemId, p);
  void p.then(() => inflight.delete(itemId));
  return p;
}

export function useItemRelevance(itemId: string): RelevanceFetch & { retry: () => void } {
  const [state, setState] = useState<RelevanceFetch>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchRelevance(itemId).then((data) => !cancelled && setState(data ? { phase: "ready", data } : { phase: "failed" }));
    return () => {
      cancelled = true;
    };
  }, [itemId, attempt]);
  const retry = useCallback(() => (setState({ phase: "loading" }), setAttempt((n) => n + 1)), []);
  return { ...state, retry };
}
