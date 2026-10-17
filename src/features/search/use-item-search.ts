"use client";

// Ported from old_repo/src/components/portfolio/PortfolioAddSearch.tsx (lines 80-107)
// Ported from old_repo/src/components/ui/CommandBar.tsx (lines 237-262)
import { useEffect, useState } from "react";

import { authedFetch } from "@/core/http/authed-fetch";

import { MIN_QUERY_LEN, type SearchRow } from "./types";

const DEBOUNCE_MS = 250;
type Settled = { query: string; rows: SearchRow[]; failed: boolean };

/** Standard Search as a hook: debounced, abortable, with the failure kept apart from "no hits" (a network exception was a stuck "Searching..." in the old card). */
export function useItemSearch(q: string): { hits: SearchRow[]; searching: boolean; failed: boolean; retry: () => void } {
  const query = q.trim();
  const [settled, setSettled] = useState<Settled | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (query.length < MIN_QUERY_LEN) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        let next: Settled = { query, rows: [], failed: true };
        try {
          const res = await authedFetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: ctl.signal });
          const body = res.ok ? ((await res.json()) as { results?: unknown }) : null;
          if (body && Array.isArray(body.results)) next = { query, rows: body.results as SearchRow[], failed: false };
        } catch {
          if (ctl.signal.aborted) return;
        }
        if (!ctl.signal.aborted) setSettled(next);
      })();
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [query, attempt]);
  const current = settled?.query === query ? settled : null;
  return { hits: current && !current.failed ? current.rows : [], searching: query.length >= MIN_QUERY_LEN && current === null, failed: current?.failed ?? false, retry: () => (setSettled(null), setAttempt((n) => n + 1)) };
}
