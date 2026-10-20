"use client";

// Ported from old_repo/src/lib/hooks/useUnreadNotificationsCount.ts (lines 19-79)
import { useEffect } from "react";
import { create } from "zustand";

import { authedFetch } from "@/core/http/authed-fetch";

const UNREAD_POLL_MS = 60_000;
const PATH = "/api/community/notifications?unread_only=true&limit=1";

interface UnreadState {
  /** null = unknown (signed out, or the last read failed). */
  count: number | null;
}
const useUnreadStore = create<UnreadState>(() => ({ count: null }));

/** Fetch the unread count once; a non-answer leaves the count unknown rather than zero. */
async function fetchUnread(fetchImpl: typeof authedFetch = authedFetch): Promise<number | null> {
  try {
    const res = await fetchImpl(PATH, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { unread_count?: unknown };
    return typeof json.unread_count === "number" ? json.unread_count : null;
  } catch {
    return null;
  }
}

let holders = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let onVisible: (() => void) | null = null;
const refresh = async () => useUnreadStore.setState({ count: await fetchUnread() });

function start() {
  void refresh();
  timer = setInterval(() => document.visibilityState === "visible" && void refresh(), UNREAD_POLL_MS);
  onVisible = () => document.visibilityState === "visible" && void refresh();
  document.addEventListener("visibilitychange", onVisible);
}
function stop() {
  if (timer) clearInterval(timer);
  if (onVisible) document.removeEventListener("visibilitychange", onVisible);
  timer = null;
  onVisible = null;
  useUnreadStore.setState({ count: null });
}

/**
 * The unread notifications count: ONE gated singleton shared by the bell and the top bar. It runs only for a signed-in reader (`enabled`), so an anonymous
 * page issues no notifications request (B-0153); the poll runs only while the tab is visible.
 */
export function useUnreadCount(enabled: boolean): { unreadCount: number | null; setUnreadCount: (n: number) => void } {
  const count = useUnreadStore((s) => s.count);
  useEffect(() => {
    if (!enabled) return;
    holders += 1;
    if (holders === 1) start();
    return () => {
      holders -= 1;
      if (holders === 0) stop();
    };
  }, [enabled]);
  return { unreadCount: enabled ? count : null, setUnreadCount: (n) => useUnreadStore.setState({ count: Math.max(0, n) }) };
}
