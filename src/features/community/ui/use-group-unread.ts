"use client";

// Ported from old_repo/src/components/community/CommunitySidebar.tsx (lines 76-111)
// The per-group unread counts for the sidebar's pills. No interval of its own (the old sidebar polled every 60 s and never paused): it reads once when it mounts and again whenever the shell's ONE unread count changes,
// which that store polls while the tab is visible. A failed read is null (no pills), never zero.
import { useEffect, useState } from "react";

import { useUnreadCount } from "@/ui/shell";

import { communityApi } from "../lib/api";

export function useGroupUnread(enabled: boolean): Map<string, number> | null {
  const { unreadCount } = useUnreadCount(enabled);
  const [counts, setCounts] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void communityApi.notificationCounts().then((r) => {
      if (live) setCounts(r.ok && r.data ? new Map(r.data.groups.map((g) => [g.group_id, g.unread_count])) : null);
    });
    return () => {
      live = false;
    };
  }, [enabled, unreadCount]);
  return counts;
}
