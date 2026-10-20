"use client";

// Ported from old_repo/src/components/profile/UserProfilePage.tsx (lines 113-457)
import Link from "next/link";
import { useState } from "react";

import { refusalSentence } from "@/core/http/failure";
import { formatLocaleDate, formatNumber } from "@/core/shared";
import type { OrgRole } from "@/core/types";
import { RailCard, SectionCard, StatBlock, StateNote } from "@/ui";
import { workspaceLabel } from "@/ui/shell/identity-seed";
import { useAuth } from "@/features/auth/ui/AuthProvider";

import type { ProfileTabKey } from "../lib/initial-tab";
import { highlightedCount, jurisdictionLabels } from "../lib/labels";
import { useAccount } from "../lib/use-account";

import { AccountFrame, accountTabs } from "./AccountFrame";
import { ActivityTab } from "./ActivityTab";
import { JurisdictionsTab } from "./JurisdictionsTab";
import { MembersPanel } from "./MembersPanel";
import { OrganizationPanel } from "./OrganizationPanel";
import { PersonalTab } from "./PersonalTab";
import { SectorProfileTab } from "./SectorProfileTab";
import { VerifierTab } from "./VerifierTab";
import styles from "./account.module.css";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const monthYear = (iso: string | null): string | null => (iso && !Number.isNaN(new Date(iso).getTime()) ? formatLocaleDate(new Date(iso), { month: "short", year: "numeric", timeZone: "UTC" }) : null);
const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/settings", label: "Settings · notifications, briefing schedule" },
  { href: "/watchlist", label: "Watchlist" },
];

/**
 * /profile: the tab row, the tab bodies, and the rail (stat card, quick links) that stays across every tab. One loader (useAccount) feeds all of it;
 * a failed read is a note with Retry, never an empty profile or a zero. The tab comes from the server (`?tab=`), so the first paint is the right tab.
 */
export function AccountPage({ userId, userEmail, orgId, orgName, role, nowIso, initialTab }: { userId: string; userEmail: string; orgId: string | null; orgName: string; role: OrgRole | null; nowIso: string; initialTab: ProfileTabKey }) {
  const [tab, setTab] = useState<ProfileTabKey>(initialTab);
  const { identityStatus } = useAuth();
  const account = useAccount(userId, orgId);
  const { profile, sectors, org, errors } = account;
  const jurisdictions = jurisdictionLabels(profile.jurisdiction_overrides);
  const since = monthYear(profile.created_at);
  const counts: Partial<Record<ProfileTabKey, string>> = {
    ...(account.memberCount !== null ? { members: formatNumber(account.memberCount) } : org ? { members: formatNumber(org.member_count) } : {}),
    ...(sectors.length > 0 ? { sectors: formatNumber(sectors.length) } : {}),
    ...(jurisdictions.length > 0 ? { jurisdictions: formatNumber(jurisdictions.length) } : {}),
  };
  const workspace = orgName || workspaceLabel(identityStatus, "No workspace");

  return (
    <AccountFrame
      title="Account"
      nowIso={nowIso}
      placeholder='Search settings, or ask "how do I add a member?"'
      tabs={accountTabs({ active: tab, onSelect: setTab, counts })}
      dek={
        <>
          {userEmail} · <b>{workspace}</b>
          {role ? ` · ${capitalize(role)}` : ""}
          {since ? ` · member since ${since}` : ""}
        </>
      }
      rail={
        <>
          <SectionCard padding="14px 16px">
            <div className={styles.statGrid}>
              <StatBlock label="Sectors followed" loading={account.loading} value={formatNumber(sectors.length)} note={errors.sectors ? refusalSentence("tile_unavailable") : highlightedCount(sectors) > 0 ? `${highlightedCount(sectors)} highlighted niches` : "No highlighted niches yet"} />
              <StatBlock label="Home jurisdictions" value={errors.profile ? "—" : formatNumber(jurisdictions.length)} note={errors.profile ? refusalSentence("tile_unavailable") : jurisdictions.length > 0 ? jurisdictions.slice(0, 3).join(" · ") : "None followed yet"} />
              <StatBlock label="Member since" value={since ?? "—"} note={errors.profile ? refusalSentence("tile_unavailable") : orgName ? `${orgName}${role ? ` · ${role}` : ""}` : since ? workspaceLabel(identityStatus, "Not in a workspace") : "Join date not recorded"} />
              <StatBlock label="Plan" value={org ? capitalize(org.org.plan) : "—"} note={errors.org ? refusalSentence("tile_unavailable") : "Billing, owner only"} />
            </div>
          </SectionCard>
          <section aria-label="Quick links">
            <RailCard title="Quick links">
            <div className={styles.chips}>
              {LINKS.map((l) => (
                <Link key={l.href} href={l.href} className={styles.link}>
                  {l.label}
                </Link>
              ))}
            </div>
            </RailCard>
          </section>
        </>
      }
    >
      {errors.profile ? (
        <StateNote tone="error" action={{ label: "Retry", onClick: account.reload }}>
          Your profile did not load: {errors.profile}
        </StateNote>
      ) : null}
      {account.loading && !errors.profile ? <p className={styles.muted}>Loading profile...</p> : null}
      {!account.loading && !errors.profile && tab === "personal" ? <PersonalTab profile={profile} email={userEmail} onSave={account.saveProfile} /> : null}
      {tab === "organization" ? <OrganizationPanel orgId={orgId} org={org} error={errors.org} onReload={account.reload} /> : null}
      {tab === "members" ? (
        <>
          <MembersPanel orgId={orgId} callerUserId={userId} callerEmail={userEmail} />
          <OrganizationPanel orgId={orgId} org={org} error={errors.org} onReload={account.reload} />
        </>
      ) : null}
      {tab === "sectors" ? <SectorProfileTab sectorIds={sectors} failed={errors.sectors} /> : null}
      {tab === "jurisdictions" ? <JurisdictionsTab jurisdictionIds={profile.jurisdiction_overrides} /> : null}
      {tab === "verifier" ? <VerifierTab status={profile.verifier_status} onApply={account.requestVerification} /> : null}
      {tab === "activity" ? <ActivityTab /> : null}
    </AccountFrame>
  );
}
