"use client";

// Ported from old_repo/src/components/admin/OrganizationsTable.tsx (lines 43-250)
// Ported from old_repo/src/components/admin/redesign/WorkspacesUsageRow.tsx (lines 86-176)
// Ported from old_repo/src/lib/admin/member-display-name.ts (lines 1-25)
import { useState } from "react";

import { formatDate, formatNumber, pluralize } from "@/core/shared";
import { MembersPanel } from "@/features/account/ui/MembersPanel";
import { Absence, RailCard, RowTable, SectionCard, SectionHead, StatBlock, StateNote } from "@/ui";

import type { MemberRow, OrgRow } from "../read/dashboard";

import styles from "./admin.module.css";

/** A member renders by name, never by id: full name, display name, e-mail, else the absence of a profile. */
export function memberDisplayName(m: Pick<MemberRow, "user">): string {
  const u = m.user;
  return u?.full_name?.trim() || u?.display_name?.trim() || u?.email?.trim() || "(no profile)";
}

/** Role counts for one set of members, owners first. Pure. */
function tallyRoles(members: readonly Pick<MemberRow, "role">[]): [string, number][] {
  const order = ["owner", "admin", "member", "viewer"];
  const counts = new Map<string, number>();
  for (const m of members) counts.set(m.role, (counts.get(m.role) ?? 0) + 1);
  return [...counts].sort((a, b) => (order.indexOf(a[0]) + 1 || 9) - (order.indexOf(b[0]) + 1 || 9));
}

/** The four figures of the usage card, computed from the rows read (never a snapshot literal): companies, distinct individuals, the newest join, and the owner split. Pure. */
function usageFigures(orgs: readonly OrgRow[], members: readonly MemberRow[]) {
  const newest = members.reduce<MemberRow | null>((n, m) => (m.created_at && (!n || n.created_at < m.created_at) ? m : n), null);
  const owners = members.filter((m) => m.role === "owner").length;
  return { companies: orgs.length, individuals: new Set(members.map((m) => m.user_id)).size, newest, owners, others: members.length - owners };
}

/** The usage card of the rail. "Active this month" is an absence with its reason until per-organisation activity is recorded, never a zero. */
export function UsageCard({ orgs, members, capped }: { orgs: readonly OrgRow[]; members: readonly MemberRow[]; capped?: boolean }) {
  const f = usageFigures(orgs, members);
  return (
    <RailCard title="Who is using the platform">
      <div className={styles.grid2}>
        <StatBlock label="Companies" value={formatNumber(f.companies)} note={f.companies === 1 && orgs[0] ? `${orgs[0].name}${orgs[0].plan ? ` · ${orgs[0].plan}` : ""}` : `${f.companies} organizations`} />
        <StatBlock label="Individuals" value={formatNumber(f.individuals)} note={`${f.owners} ${pluralize(f.owners, "owner")} · ${f.others} other ${pluralize(f.others, "member")}${capped ? " (list capped)" : ""}`} />
        <StatBlock label="Newest join" value={f.newest ? formatDate(f.newest.created_at.slice(0, 10)) : "none yet"} note={f.newest ? `${memberDisplayName(f.newest)} · ${f.newest.role}` : "no joins yet"} />
        <div>
          <StatBlock label="Active this month" value="—" />
          <Absence reason="connect data" />
        </div>
      </div>
    </RailCard>
  );
}

/** Organisations with their member count, role mix and last join. A row opens its member list (the one members panel), a platform admin reading any organisation. */
export function WorkspacesOverview({ orgs, members, capped, userId, userEmail }: { orgs: readonly OrgRow[]; members: readonly MemberRow[]; capped: boolean; userId: string; userEmail: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = orgs.map((o) => {
    const mine = members.filter((m) => m.org_id === o.id);
    const last = mine.reduce<string | null>((l, m) => (l === null || m.created_at > l ? m.created_at : l), null);
    return {
      key: o.id,
      activateLabel: `${open === o.id ? "Hide" : "Show"} members of ${o.name}`,
      onActivate: () => setOpen(open === o.id ? null : o.id),
      cells: [
        <span key="n" className={styles.cell}><b className={styles.strong}>{o.name}</b>{o.plan ? <span className={styles.muted}> · {o.plan}</span> : null}</span>,
        <span key="c">{capped ? `${mine.length}+` : mine.length}</span>,
        <span key="r" className={styles.chips}>{tallyRoles(mine).map(([role, n]) => <span key={role} className={styles.pill}>{n} {role}</span>)}</span>,
        <span key="j">{last ? formatDate(last.slice(0, 10)) : <Absence reason="not in primary source" variant="dash" />}</span>,
      ],
      ...(open === o.id ? { below: <MembersPanel orgId={o.id} callerUserId={userId} callerEmail={userEmail} /> } : {}),
    };
  });
  return (
    <SectionCard as="section" aria-label="Organizations">
      <SectionHead title="Organizations" aside={`${orgs.length} ${pluralize(orgs.length, "org")} · ${members.length}${capped ? "+" : ""} ${pluralize(members.length, "membership")}`} />
      {orgs.length === 0 ? (
        <div className={styles.body}><StateNote>No organizations exist yet.</StateNote></div>
      ) : (
        <RowTable columns={[{ label: "Organization", width: "minmax(180px, 2fr)" }, { label: "Members", width: "90px" }, { label: "Roles", width: "minmax(180px, 2fr)" }, { label: "Last join", width: "120px" }]} rows={rows} />
      )}
    </SectionCard>
  );
}
