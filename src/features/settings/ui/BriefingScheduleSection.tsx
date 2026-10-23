"use client";

// Ported from old_repo/src/components/settings/BriefingScheduleSection.tsx (lines 67-306)
import { useState, useSyncExternalStore } from "react";

import { JURISDICTIONS } from "@/core/workspace/vocabulary";
import { useWorkspaceStore } from "@/core/workspace/store";
import { Button, ChoiceChip, FormField, InlineErrorBanner, Input, Segmented, Toast, type SegmentedOption } from "@/ui";

import { useSettingsStore } from "../state/settings-store";

import { SettingsGate } from "./SettingsGate";
import styles from "./settings.module.css";

type Cadence = "daily" | "weekly" | "biweekly";
interface Schedule {
  cadence: Cadence;
  day: string;
  time: string;
  jurisdictions: string[];
}

const DAYS: ReadonlyArray<SegmentedOption<string>> = [
  { id: "monday", label: "Mon" },
  { id: "tuesday", label: "Tue" },
  { id: "wednesday", label: "Wed" },
  { id: "thursday", label: "Thu" },
  { id: "friday", label: "Fri" },
];
/** Biweekly stays a trailing segment (ruling R7): the artboard draws two cadences, the product has three. */
const CADENCES: ReadonlyArray<SegmentedOption<Cadence>> = [
  { id: "weekly", label: "Weekly" },
  { id: "daily", label: "Daily" },
  { id: "biweekly", label: "Biweekly" },
];

/** The saved schedule from the stored alert_config; a key the row does not hold reads as the default, never as an invented value. */
function stored(config: Record<string, unknown>): Schedule {
  return {
    cadence: (config.briefingCadence as Cadence | undefined) ?? "weekly",
    day: (config.briefingDay as string | undefined) ?? "monday",
    time: (config.briefingTime as string | undefined) ?? "08:00",
    jurisdictions: Array.isArray(config.briefingJurisdictions) ? (config.briefingJurisdictions as string[]) : [],
  };
}
const same = (a: Schedule, b: Schedule) => a.cadence === b.cadence && a.day === b.day && a.time === b.time && a.jurisdictions.length === b.jurisdictions.length && a.jurisdictions.every((j) => b.jurisdictions.includes(j));
const noSubscription = () => () => undefined;
/** The reader's time zone after hydration (null on the server): a zone read during render would mismatch. */
const useTimeZone = (): string | null => useSyncExternalStore(noSubscription, () => Intl.DateTimeFormat().resolvedOptions().timeZone || null, () => null);

function ScheduleForm() {
  const alertConfig = useSettingsStore((s) => s.alertConfig);
  const commit = useSettingsStore((s) => s.commit);
  const role = useWorkspaceStore((s) => s.userRole);
  const orgName = useWorkspaceStore((s) => s.orgName);
  const zone = useTimeZone();
  const canEdit = role === "owner" || role === "admin";
  const baseline = stored(alertConfig);
  const [draft, setDraft] = useState<Partial<Schedule>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const schedule: Schedule = { ...baseline, ...draft };
  const dirty = !same(schedule, baseline);

  async function save() {
    setSaving(true);
    setError(null);
    const message = await commit("alert_config", { briefingCadence: schedule.cadence, briefingDay: schedule.day, briefingTime: schedule.time, briefingDelivery: "in_app", briefingJurisdictions: schedule.jurisdictions });
    setSaving(false);
    if (message) return setError(message);
    setDraft({});
    setSaved(true);
  }
  const edit = (patch: Partial<Schedule>) => canEdit && setDraft((d) => ({ ...d, ...patch }));
  const toggle = (id: string) => edit({ jurisdictions: schedule.jurisdictions.includes(id) ? schedule.jurisdictions.filter((j) => j !== id) : [...schedule.jurisdictions, id] });

  return (
    <div className={styles.briefing}>
      <FormField group label="Cadence">{() => <Segmented options={CADENCES} selected={[schedule.cadence]} onSelect={(id) => edit({ cadence: id })} label="Briefing cadence" disabled={!canEdit} />}</FormField>
      {schedule.cadence !== "daily" ? <FormField group label="Day">{() => <Segmented options={DAYS} selected={[schedule.day]} onSelect={(id) => edit({ day: id })} label="Briefing day" disabled={!canEdit} />}</FormField> : null}
      <FormField label={zone ? `Time · ${zone}` : "Time · your local timezone"}>{(c) => <Input {...c} type="time" aria-label="Briefing time" value={schedule.time} onChange={(e) => edit({ time: e.target.value })} disabled={!canEdit} />}</FormField>
      <details className={styles.disclosure}>
        <summary>Jurisdiction weighting</summary>
        <p className="cl-field-hint">{schedule.jurisdictions.length === 0 ? "All jurisdictions weighted equally" : `${schedule.jurisdictions.length} weighted, others still included at base weight`}</p>
        <div className={styles.chips}>
          {JURISDICTIONS.map((j) => (
            <ChoiceChip key={j.id} label={j.label} pressed={schedule.jurisdictions.includes(j.id)} onToggle={() => toggle(j.id)} disabled={!canEdit} />
          ))}
        </div>
        <p className="cl-field-hint">Delivery is in the app. Email and push are not available yet.</p>
      </details>
      {!canEdit ? <p className="cl-field-hint">Only an owner or admin can change the briefing schedule.</p> : null}
      {error ? <InlineErrorBanner message={`Not saved: ${error}`} /> : null}
      <Button variant="primary" onClick={() => void save()} disabled={!dirty || !canEdit || saving}>
        {saving ? "Saving..." : "Save schedule"}
      </Button>
      <Toast message={`Saved to ${orgName || "workspace"}.`} visible={saved} onDismiss={() => setSaved(false)} />
    </div>
  );
}

/**
 * The briefing schedule (cadence, day, time in the reader's zone, jurisdiction weights), read from and saved to the workspace's alert_config key-wise. It is
 * mounted on Settings and in onboarding step 4 and loads once through the settings store: the old section had a loader no one called, so it could neither
 * load nor save (B-0665), and it printed "Saved" without reading the write result (B-0186).
 */
export function BriefingScheduleSection() {
  return (
    <SettingsGate>
      <ScheduleForm />
    </SettingsGate>
  );
}
