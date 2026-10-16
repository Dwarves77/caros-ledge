"use client";

// Ported from old_repo/src/components/profile/UserProfilePage.tsx (lines 269-308)
// Ported from old_repo/src/components/pages/SettingsPage.tsx (lines 148-212)
import type { ReactNode } from "react";

import { formatLocaleDate } from "@/core/shared";
import { Masthead, SectionIndex, TabRow } from "@/ui";
import type { TabRowItem } from "@/ui/TabRow";
import { ShellCommandBar } from "@/ui/shell/CommandBar";
import { PageFrame } from "@/ui/shell/PageFrame";

import { PROFILE_TAB_KEYS, type ProfileTabKey } from "../lib/initial-tab";

import styles from "./account.module.css";

const LABELS: Record<ProfileTabKey, string> = { personal: "Personal", organization: "Organization", members: "Members & roles", sectors: "Sector profile", jurisdictions: "Jurisdictions", verifier: "Verifier badge", activity: "Activity" };

/**
 * The merged account tab row (artboard 14 and 15: one row, not a stacked pair). The seven profile tabs are in-page switches on /profile and links
 * back to `/profile?tab=` from /settings; "Settings" is the eighth entry, a link on /profile and the active tab on /settings.
 */
export function accountTabs(opts: { active: ProfileTabKey | "settings"; onSelect?: (tab: ProfileTabKey) => void; counts?: Partial<Record<ProfileTabKey, string>> }): TabRowItem[] {
  const tabs: TabRowItem[] = PROFILE_TAB_KEYS.map((key) => {
    const label = `${LABELS[key]}${opts.counts?.[key] ? ` · ${opts.counts[key]}` : ""}`;
    return opts.onSelect ? { key, label, active: opts.active === key, onClick: () => opts.onSelect?.(key) } : { key, label, href: `/profile?tab=${key}` };
  });
  return [...tabs, opts.active === "settings" ? { key: "settings", label: "Settings", active: true } : { key: "settings", label: "Settings", href: "/settings" }];
}

interface FrameProps {
  title: string;
  dek: ReactNode;
  nowIso: string;
  tabs: TabRowItem[];
  placeholder: string;
  notice?: { text: ReactNode };
  /** The settings page's sticky section index, directly under the tab row (ruling R9). */
  sections?: ReadonlyArray<{ id: string; shortName: string }>;
  rail: ReactNode;
  children: ReactNode;
}

/** The frame /profile and /settings share: the masthead (date from the request's one instant), the tab row, an optional section index, then the content and its 300 px rail. */
export function AccountFrame({ title, dek, nowIso, tabs, placeholder, notice, sections, rail, children }: FrameProps) {
  const dateLabel = formatLocaleDate(new Date(nowIso), { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  return (
    <div>
      <div className={styles.head}>
        <Masthead title={title} dateLabel={dateLabel} nowIso={nowIso} eyebrowSuffix="Personal" dek={dek} commandBar={<ShellCommandBar placeholder={placeholder} />} {...(notice ? { notice } : {})} />
      </div>
      <div className={styles.head}>
        <TabRow tabs={tabs} ariaLabel="Account sections" />
      </div>
      {sections ? (
        <div className={styles.head}>
          <SectionIndex sections={sections.map((s) => ({ ...s }))} />
        </div>
      ) : null}
      <PageFrame padding="account" rail={<aside className={styles.rail}>{rail}</aside>}>
        <div className={styles.stack}>{children}</div>
      </PageFrame>
    </div>
  );
}
