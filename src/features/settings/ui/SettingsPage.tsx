"use client";

// Ported from old_repo/src/components/pages/SettingsPage.tsx (lines 30-304)
// Ported from old_repo/src/components/pages/SettingsPage.tsx (lines 305-639)
import { useEffect, useRef, useState } from "react";

import { formatNumber } from "@/core/shared";
import { ALL_SECTORS } from "@/core/workspace";
import { BAND_ORDER } from "@/core/lists";
import { AccountFrame, accountTabs } from "@/features/account/ui/AccountFrame";
import { NotificationPreferences } from "@/features/account/ui/NotificationPreferences";
import { ArchiveViewer } from "@/features/workspace/ui/ArchiveViewer";
import { Button, ChoiceChip, EmptyState, FormCard, InlineErrorBanner, RailCard, Segmented, StateNote, Switch, type SegmentedOption } from "@/ui";

import type { SettingsData } from "../server/settings-data";
import { useSettingsStore, type DashboardRegionKey, type SortKey } from "../state/settings-store";

import { BriefingScheduleSection } from "./BriefingScheduleSection";
import { FailedBlock } from "./FailedBlock";
import { OrganisationProfileSection } from "./OrganisationProfileSection";
import { SettingsGate } from "./SettingsGate";
import { SupersessionHistory } from "./SupersessionHistory";
import styles from "./settings.module.css";

/** The section index under the tab row (ruling R9): anchored sections in one scrolling page, not a second tab row. */
const SECTIONS = [
  { id: "general", shortName: "General" },
  { id: "notifications", shortName: "Notifications" },
  { id: "data", shortName: "Data" },
  { id: "archive", shortName: "Archive" },
  { id: "help", shortName: "Help" },
];
const COLLAPSED_SECTORS = 12;
const SORTS: ReadonlyArray<SegmentedOption<SortKey>> = [
  { id: "next-date", label: "Next date" },
  { id: "newest", label: "Newest" },
  { id: "az", label: "A-Z" },
];
/** The artboard draws a third PDF segment; no PDF export exists, so the segment would be a control with nothing behind it. */
const EXPORTS: ReadonlyArray<SegmentedOption<"html" | "slack">> = [
  { id: "html", label: "HTML" },
  { id: "slack", label: "Slack" },
];
/** Alert bands are the urgency vocabulary itself (Awareness is background, never alerted). */
const ALERT_BANDS: ReadonlyArray<SegmentedOption<string>> = BAND_ORDER.filter((b) => b.key !== "awareness").map((b) => ({ id: b.priority, label: b.label }));
const REGIONS: ReadonlyArray<{ key: DashboardRegionKey; label: string }> = [
  { key: "BandTiles", label: "Band tiles" },
  { key: "DueNext", label: "Due next" },
  { key: "WhatChanged", label: "What changed" },
  { key: "WatchlistRail", label: "Watchlist rail" },
  { key: "AcrossPlatform", label: "Across the platform" },
  { key: "Supersessions", label: "Supersessions" },
];

function DashboardDefaults() {
  const s = useSettingsStore();
  const shown: Record<DashboardRegionKey, boolean> = { BandTiles: s.showBandTiles, DueNext: s.showDueNext, WhatChanged: s.showWhatChanged, WatchlistRail: s.showWatchlistRail, AcrossPlatform: s.showAcrossPlatform, Supersessions: s.showSupersessions };
  return (
    <FormCard title="Dashboard defaults" aside="Applies on every load" id="general">
      <SettingsGate>
        {s.saveError ? <InlineErrorBanner message={`A change was not saved and shows on this screen only: ${s.saveError}`} /> : null}
        <div className={styles.controls}>
          <div className="cl-field">
            <span className="cl-field-label">Default sort</span>
            <Segmented options={SORTS} selected={[s.defaultSort]} onSelect={s.setDefaultSort} label="Default sort" />
          </div>
          <div className="cl-field">
            <span className="cl-field-label">Default export</span>
            <Segmented options={EXPORTS} selected={[s.exportFormat]} onSelect={s.setExportFormat} label="Default export" />
          </div>
          <div className="cl-field">
            <span className="cl-field-label">Alert bands</span>
            <Segmented multiple options={ALERT_BANDS} selected={s.alertPriorities} onSelect={(id) => s.setAlertPriorities(s.alertPriorities.includes(id) ? s.alertPriorities.filter((x) => x !== id) : [...s.alertPriorities, id])} label="Alert bands" />
          </div>
        </div>
        <div className={styles.toggles}>
          {REGIONS.map((r) => (
            <div key={r.key} className={styles.toggle}>
              <span className={styles.toggleLabel}>{r.label}</span>
              <Switch on={shown[r.key]} label={`Show ${r.label}`} onChange={() => s.toggleSection(r.key)} />
            </div>
          ))}
        </div>
      </SettingsGate>
    </FormCard>
  );
}

/** The workspace's sectors: autosaved a moment after the last change, through the settings store's one writer (sector_profile has no other). A refused save keeps the choice on screen with its reason and a Retry. */
function FreightSectors() {
  const stored = useSettingsStore((s) => s.sectorProfile);
  const commit = useSettingsStore((s) => s.commit);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<string[] | null>(null);
  const current = draft ?? stored;

  async function write(list: string[]) {
    pending.current = null;
    const message = await commit("sector_profile", list);
    if (message) return setError(message);
    setError(null);
    setDraft((d) => (d === list ? null : d));
  }
  function change(next: string[]) {
    setDraft(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void write(next), 700);
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) void commit("sector_profile", pending.current);
    },
    [commit],
  );

  // The collapsed grid leads with the saved sectors and fills to twelve; it follows the SAVED list so a chip never jumps while it is being toggled.
  const ordered = expanded ? ALL_SECTORS : [...ALL_SECTORS.filter((s) => stored.includes(s.id)), ...ALL_SECTORS.filter((s) => !stored.includes(s.id))].slice(0, COLLAPSED_SECTORS);
  const toggle = (id: string) => change(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
  return (
    <FormCard
      title="Freight sectors"
      aside={`${current.length} selected · filters your default view, briefings and relevance`}
      foot={{
        left: (
          <Button variant="ghost" size="sm" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show fewer sectors" : `Show all ${formatNumber(ALL_SECTORS.length)} sectors`}
          </Button>
        ),
        right: (
          <>
            <Button variant="ghost" size="sm" onClick={() => change(ALL_SECTORS.map((s) => s.id))}>
              Select all
            </Button>
            <Button variant="ghost" size="sm" onClick={() => change([])}>
              Clear
            </Button>
          </>
        ),
      }}
    >
      <SettingsGate>
        {error ? (
          <StateNote tone="error" action={{ label: "Retry", onClick: () => void write(current) }}>
            The sectors were not saved: {error}
          </StateNote>
        ) : null}
        <div className={styles.sectors}>
          {ordered.map((s) => (
            <ChoiceChip key={s.id} label={s.label} pressed={current.includes(s.id)} onToggle={() => toggle(s.id)} />
          ))}
        </div>
      </SettingsGate>
    </FormCard>
  );
}

/** /settings: artboard 15. Two columns under the merged account tab row; the sections the artboard draws no region for follow as anchored sections (R7). */
export function SettingsPage({ userId, nowIso, orgName, data }: { userId: string; nowIso: string; orgName: string; data: SettingsData }) {
  const archive = data.archive;
  return (
    <AccountFrame
      title="Settings"
      nowIso={nowIso}
      placeholder='Search settings, or ask "how do I change my briefing day?"'
      tabs={accountTabs({ active: "settings" })}
      sections={SECTIONS}
      notice={{ text: <><b>Applies workspace-wide</b> · changes here affect every member, not just you</> }}
      dek={<>Dashboard defaults, freight sectors, notifications, briefing schedule{orgName ? <> · scoped to <b>{orgName}</b></> : null}</>}
      rail={
        <>
          <RailCard title="Briefing schedule">
            <BriefingScheduleSection />
          </RailCard>
          <RailCard title="Appearance">
            <p className={styles.text}>Light only. There is one theme; the product reads like a printed ledger and stays that way.</p>
          </RailCard>
          <RailCard title="Data & supersessions">
            <div className={styles.railLinks}>
              <a href="#data" className={styles.railLink}>
                Supersession history{data.supersessions.rows ? ` · ${formatNumber(data.supersessions.rows.length)}${data.supersessions.truncated ? "+" : ""}` : ""}
              </a>
              <a href="#archive" className={styles.railLink}>
                Archive
              </a>
            </div>
          </RailCard>
        </>
      }
    >
      <DashboardDefaults />
      <FreightSectors />
      <OrganisationProfileSection />
      <div id="notifications" className={styles.section}>
        <FormCard title="Notifications" aside="In-app only">
          <NotificationPreferences userId={userId} />
        </FormCard>
      </div>
      <div id="data" className={styles.section}>
        <FormCard title="Supersession history">
          <SupersessionHistory section={data.supersessions} />
        </FormCard>
      </div>
      <div id="archive" className={styles.section}>
        <FormCard title="Archive" aside={archive.rows ? `${archive.rows.length}${archive.truncated ? "+" : ""} item${archive.rows.length === 1 ? "" : "s"} · still recoverable` : "Not loaded"}>
          {archive.rows ? <ArchiveViewer rows={archive.rows} /> : <FailedBlock>The archive did not load: {archive.error}</FailedBlock>}
        </FormCard>
      </div>
      <div id="help" className={styles.section}>
        <FormCard title="Help">
          <EmptyState>Documentation and contact routes are not published yet. Until then, workspace owners reach the team through the onboarding channel.</EmptyState>
        </FormCard>
      </div>
    </AccountFrame>
  );
}
