"use client";

// Ported from old_repo/src/components/community/CommunitySidebar.tsx (lines 51-692)
// The Community navigation, drawn on the kit's nav-card classes in the shell's surface-nav slot (the same 44 px rows and footer as the platform nav; on the phone it is the drawer's content). Your starred, private and
// public groups with their unread pills, the current group marked, a filter that really filters, the browse links, and the account footer. Topics are not drawn (no writer exists); the unread pills follow the ONE shared
// unread store (they refetch when its count changes), with no second poll of their own; a failed read draws no pills rather than zeros.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { formatNumber } from "@/core/shared";
import { Input } from "@/ui";

import type { ShellContext } from "../lib/shell-context";
import type { Membership } from "../lib/types";

import styles from "./community.module.css";
import { useGroupUnread } from "./use-group-unread";
import { Avatar } from "./parts/Avatar";

function Section({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="cl-nav-section">
      <button type="button" className={styles.sectionToggle} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="cl-nav-section-label">{label}</span>
        <span className="cl-nav-count">{formatNumber(count)}</span>
      </button>
      {open && <div className="cl-nav-rows">{children}</div>}
    </div>
  );
}

function GroupRow({ m, active, unread, onNavigate }: { m: Membership; active: boolean; unread: number | undefined; onNavigate: (() => void) | undefined }) {
  return (
    <Link href={`/community/${m.group.slug}`} prefetch={false} aria-current={active ? "page" : undefined} className={`cl-nav-row${active ? " cl-nav-row--active" : ""}`} {...(onNavigate ? { onClick: onNavigate } : {})}>
      <span className={styles.navLabel}>{m.group.name}</span>
      {!!unread && <span className="cl-nav-count" aria-label={`${unread} unread`}>{formatNumber(unread)}</span>}
    </Link>
  );
}

export function CommunitySidebar({ shell, variant, onNavigate }: { shell: ShellContext; variant: "card" | "drawer"; onNavigate: (() => void) | undefined }) {
  const pathname = usePathname();
  const [filter, setFilter] = useState("");
  const counts = useGroupUnread(true);
  const { currentUser, memberships } = shell;
  const q = filter.trim().toLowerCase();
  const shown = memberships.filter((m) => !q || m.group.name.toLowerCase().includes(q));
  const starred = shown.filter((m) => m.starred);
  const privateGroups = shown.filter((m) => !m.starred && m.group.privacy === "private");
  const publicGroups = shown.filter((m) => !m.starred && m.group.privacy === "public");
  const row = (m: Membership) => <GroupRow key={m.group_id} m={m} active={pathname === `/community/${m.group.slug}`} unread={counts?.get(m.group_id)} onNavigate={onNavigate} />;
  const nav = onNavigate ? { onClick: onNavigate } : {};
  const body = (
    <>
      <div className={styles.sideHead}>
        <Link href="/" prefetch={false} className={styles.sideBack} {...nav}>
          ← Back to Caro&rsquo;s Ledge
        </Link>
        <p className={styles.sideTitle}>Community</p>
        <p className={styles.sideWho}>
          {currentUser.name}
          {currentUser.employer ? ` · ${currentUser.employer}` : ""}
        </p>
        <Input type="search" aria-label="Filter your groups" placeholder="Filter your groups" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <nav className="cl-nav-sections" aria-label="Community">
        <Section label="Starred" count={starred.length}>
          {starred.length === 0 ? <p className={styles.navEmpty}>{q ? "No starred group matches." : "Star a group to pin it here."}</p> : starred.map(row)}
        </Section>
        <Section label="Private groups" count={privateGroups.length}>
          {privateGroups.length === 0 ? <p className={styles.navEmpty}>{q ? "No private group matches." : "You are not in any private groups yet."}</p> : privateGroups.map(row)}
        </Section>
        <Section label="Public forums" count={publicGroups.length}>
          {publicGroups.length === 0 ? <p className={styles.navEmpty}>{q ? "No public forum matches." : "Join a public forum from Browse."}</p> : publicGroups.map(row)}
        </Section>
        <div className="cl-nav-section">
          <p className="cl-nav-section-label">Browse</p>
          <div className="cl-nav-rows">
            {[
              ["/community/browse", "All groups"],
              ["/community/discover", "Discover by entity"],
              ["/community/directory", "Peer-organisation directory"],
              ["/community/profile", "Your community profile"],
            ].map(([href, label]) => (
              <Link key={href} href={href as string} prefetch={false} aria-current={pathname === href ? "page" : undefined} className={`cl-nav-row${pathname === href ? " cl-nav-row--active" : ""}`} {...nav}>
                {label}
              </Link>
            ))}
          </div>
        </div>
      </nav>
      <div className="cl-nav-foot">
        <Link href="/settings" prefetch={false} className="cl-nav-footrow" {...nav}>
          <span className={styles.footWho}>
            <Avatar name={currentUser.name} url={currentUser.headshotUrl} size={28} />
            <span>
              <span className="cl-nav-foot-title">{currentUser.name}</span>
              <span className="cl-nav-foot-sub">{currentUser.employer || currentUser.email}</span>
            </span>
          </span>
          <span className="cl-nav-foot-sub">Settings</span>
        </Link>
      </div>
    </>
  );
  return variant === "drawer" ? (
    <div data-part="nav-card" className="cl-nav-drawer">
      {body}
    </div>
  ) : (
    <aside data-part="nav-card" className="cl-nav-card">
      {body}
    </aside>
  );
}
