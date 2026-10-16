"use client";

// Ported from old_repo/src/components/auth/UserMenuDropdown.tsx (lines 43-134)
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/** The account menu: email, workspace, admin badge, Workspace profile, Settings and Sign out (each a 44 px row). Esc and an outside click close it and Esc returns focus to the trigger. */
export function UserMenu({ email, orgName, isAdmin, onSignOut, onNavigate, triggerClassName }: { email: string | null; orgName: string; isAdmin: boolean; onSignOut: () => void; onNavigate?: () => void; triggerClassName?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const close = () => {
    setOpen(false);
    onNavigate?.();
  };
  return (
    <div ref={root} className="cl-usermenu">
      <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-label="Open account menu" className={triggerClassName ?? "cl-nav-footrow"} onClick={() => setOpen((v) => !v)}>
        <span className="cl-nav-foot-title">Account</span>
        <span className="cl-nav-foot-sub">{orgName || "—"}</span>
      </button>
      {open && (
        <div role="menu" className="cl-usermenu-pop">
          <div className="cl-usermenu-head">
            <p className="cl-usermenu-email">{email}</p>
            <p className="cl-usermenu-org">{orgName}</p>
            {isAdmin && <span className="cl-usermenu-badge">Admin</span>}
          </div>
          <Link role="menuitem" href="/profile" prefetch={false} className="cl-usermenu-item" onClick={close}>
            Workspace profile
          </Link>
          <Link role="menuitem" href="/settings" prefetch={false} className="cl-usermenu-item" onClick={close}>
            Settings
          </Link>
          <button role="menuitem" type="button" className="cl-usermenu-item" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
