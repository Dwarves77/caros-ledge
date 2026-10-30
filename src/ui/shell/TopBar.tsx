"use client";

// Ported from old_repo/src/components/layout/TopBar.tsx (lines 42-202)
import Link from "next/link";
import { usePathname } from "next/navigation";

import { BandGradientRule } from "../BandParts";

import { useAuth } from "./Providers";
import { gradientCountsFrom, navTitleForPath } from "./nav-model";
import { useBootstrapStore } from "./use-bootstrap";
import { useUnreadCount } from "./use-unread-count";

function focusCommandBar() {
  const el = document.getElementById("cl-command-bar-input");
  if (!el) return;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.focus();
}

/** The phone bar: the band rule, a 44 px hamburger, the page title, a search glyph that focuses the page's command bar, and the account avatar (the unread dot is notifications only). Shown below 768 px (base.css). */
export function TopBar({ onMenuClick }: { onMenuClick: () => void }) {
  const title = navTitleForPath(usePathname());
  const { user, identityStatus } = useAuth();
  const { unreadCount } = useUnreadCount(identityStatus !== "pending" && !!user);
  const byPriority = useBootstrapStore((s) => s.data?.navCounts?.byPriority ?? null);
  const initial = (user?.email ?? "?").trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="cl-topbar">
      <BandGradientRule counts={gradientCountsFrom(byPriority)} />
      <header className="cl-topbar-row">
        <button type="button" onClick={onMenuClick} aria-label="Open navigation" className="cl-topbar-btn">
          <span aria-hidden="true">☰</span>
        </button>
        <h1 className="cl-topbar-title">{title}</h1>
        <div className="cl-topbar-end">
          <button type="button" onClick={focusCommandBar} aria-label="Search" className="cl-topbar-btn">
            <span aria-hidden="true">⌕</span>
          </button>
          <Link href="/profile" prefetch={false} className="cl-topbar-btn" aria-label={unreadCount ? `Account, ${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}` : "Account"}>
            <span aria-hidden="true" className="cl-topbar-avatar">
              {initial}
              {!!unreadCount && <span className="cl-topbar-dot" />}
            </span>
          </Link>
        </div>
      </header>
    </div>
  );
}
