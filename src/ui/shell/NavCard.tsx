"use client";

// Ported from old_repo/src/components/Sidebar.tsx (lines 114-529)
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { formatNumber } from "@/core/shared";
import { useAuth } from "@/features/auth/ui/AuthProvider";
import { useWorkspaceStore } from "@/core/workspace/store";

import { BandGradientRule } from "../BandParts";

import { shouldShowAdminNav, workspaceLabel } from "./identity-seed";
import { APP_NAME, APP_TAGLINE, gradientCountsFrom, isActivePath, SECTIONS } from "./nav-model";
import { useAdminAttention } from "./use-admin-attention";
import { useBootstrapStore } from "./use-bootstrap";
import { UserMenu } from "./UserMenu";

function Wordmark({ drawer, onNavigate }: { drawer: boolean; onNavigate?: (() => void) | undefined }) {
  const nav = onNavigate ? { onClick: onNavigate } : {};
  return (
    <div className={drawer ? "cl-nav-brand cl-nav-brand--drawer" : "cl-nav-brand"}>
      <Link href="/" prefetch={false} className="cl-nav-brand-link" {...nav}>
        <h1 data-guard-display="wordmark" className="cl-nav-wordmark">
          {APP_NAME}
        </h1>
        <p className="cl-nav-tagline">{APP_TAGLINE}</p>
      </Link>
    </div>
  );
}

/**
 * THE nav: the 252 px card on desktop and the 288 px drawer body on the phone (the same rows at two sizes; the drawer mounts it inside a Sheet).
 * The cap is the band rule from live priority counts (no split when the counts are unknown); a count that failed to read prints nothing, not 0.
 * The footer is two rows, Account (the menu) and, for a platform admin, Admin with its attention count and the caller's workspace role.
 */
export function NavCard({ variant = "card", onNavigate }: { variant?: "card" | "drawer"; onNavigate?: () => void }) {
  const pathname = usePathname(); const router = useRouter(); const warm = (href: string) => () => router.prefetch(href);
  const { user, signOut, identityStatus, isPlatformAdmin } = useAuth();
  const role = useWorkspaceStore((s) => s.userRole);
  const orgName = useWorkspaceStore((s) => s.orgName);
  const counts = useBootstrapStore((s) => s.data?.navCounts ?? null);
  const showAdmin = shouldShowAdminNav({ status: identityStatus, isPlatformAdmin });
  const { total } = useAdminAttention(showAdmin);
  const drawer = variant === "drawer";
  const nav = onNavigate ? { onClick: onNavigate } : {};
  const label = workspaceLabel(identityStatus, orgName);
  const body = (
    <>
      <BandGradientRule counts={gradientCountsFrom(counts?.byPriority)} />
      <Wordmark drawer={drawer} onNavigate={onNavigate} />
      <nav className="cl-nav-sections" aria-label={drawer ? "Navigation" : undefined}>
        {SECTIONS.map((section, i) => (
          <div key={section.label} className="cl-nav-section">
            {i > 0 && !drawer && <div className="cl-nav-divider" aria-hidden="true" />}
            <p className="cl-nav-section-label">{section.label}</p>
            <div className="cl-nav-rows">
              {section.items.map(({ href, label: text, countKey }) => {
                const active = isActivePath(pathname, href);
                const n = countKey && counts ? counts[countKey] : null;
                return (
                  <Link key={href} href={href} prefetch={false} onMouseEnter={warm(href)} onFocus={warm(href)} {...nav} aria-current={active ? "page" : undefined} className={`cl-nav-row${active ? " cl-nav-row--active" : ""}`}>
                    <span>{text}</span>
                    {n != null && <span className="cl-nav-count">{formatNumber(n)}</span>}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="cl-nav-foot">
        {user ? (
          <UserMenu email={user.email ?? null} orgName={label === "No workspace" ? "" : orgName || label} isAdmin={showAdmin} onSignOut={() => void signOut()} {...(onNavigate ? { onNavigate } : {})} />
        ) : (
          <Link href="/profile" prefetch={false} {...nav} className="cl-nav-footrow">
            <span className="cl-nav-foot-title">Account</span>
            <span className="cl-nav-foot-sub">{"—"}</span>
          </Link>
        )}
        {showAdmin && (
          <Link href="/admin" prefetch={false} {...nav} aria-current={isActivePath(pathname, "/admin") ? "page" : undefined} aria-label={total > 0 ? `Admin (${total} item${total === 1 ? "" : "s"} need attention)` : "Admin"} className="cl-nav-footrow">
            <span className="cl-nav-foot-title">Admin</span>
            <span className="cl-nav-foot-end">
              {total > 0 && <span className="cl-nav-count">{formatNumber(total)}</span>}
              {role && <span className="cl-nav-role">{role}</span>}
            </span>
          </Link>
        )}
      </div>
    </>
  );
  return drawer ? <div data-part="nav-card" className="cl-nav-drawer">{body}</div> : <aside data-part="nav-card" className="cl-nav-card">{body}</aside>;
}
