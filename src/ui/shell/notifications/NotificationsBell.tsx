"use client";

// Ported from old_repo/src/components/community/NotificationsBell.tsx (lines 27-143)
// The platform notifications bell: a 44 px button with the unread count from the ONE shared unread store (the poll the shell already runs), and the inbox in the kit Dialog (focus trap, Esc, focus return). Mounted by
// the shell for a signed-in user on every page, not only inside Community.
import { useState } from "react";

import { useAuth } from "../Providers";
import { Dialog } from "../../Dialog";
import { useUnreadCount } from "../use-unread-count";

import { NotificationsList } from "./NotificationsList";

export function NotificationsBell() {
  const { user, identityStatus } = useAuth();
  const { unreadCount, setUnreadCount } = useUnreadCount(identityStatus !== "pending" && !!user);
  const [open, setOpen] = useState(false);
  if (!user) return null;
  const n = unreadCount ?? 0;
  return (
    <div className="cl-bell-slot">
      <button type="button" className="cl-bell" aria-haspopup="dialog" aria-label={n > 0 ? `Notifications, ${n} unread` : "Notifications"} onClick={() => setOpen(true)}>
        <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 7H4c0-1 2-2 2-7z" />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
        {n > 0 && (
          <span aria-hidden="true" className="cl-bell-badge">
            {n > 99 ? "99+" : n}
          </span>
        )}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Notifications">
        <NotificationsList onUnreadChange={setUnreadCount} onClose={() => setOpen(false)} />
      </Dialog>
    </div>
  );
}
