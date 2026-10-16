"use client";

// Ported from old_repo/src/components/profile/NotificationPreferences.tsx (lines 29-262)
import { useEffect, useState } from "react";

import { browserClient } from "@/core/db/browser";
import { InlineErrorBanner, StateNote, Switch, Toast } from "@/ui";

import { DEFAULT_NOTIFICATION_PREFS, readNotificationPrefs, saveNotificationPrefs, SWITCHES, type NotificationPrefs, type SwitchKey } from "../lib/notification-prefs";

import styles from "./account.module.css";

function PrefRow({ label, description, on, locked, busy, onFlip }: { label: string; description: string; on: boolean; locked?: boolean; busy?: boolean; onFlip: () => void }) {
  return (
    <div className={styles.prefRow}>
      <div className={styles.prefText}>
        <p className={styles.prefLabel}>{label}</p>
        <p className={styles.prefDesc}>{description}</p>
      </div>
      <Switch on={on} label={label} onChange={onFlip} {...(locked ? { locked } : {})} {...(busy ? { busy } : {})} />
    </div>
  );
}

/**
 * The notification switches. A switch flips at once and is written; when the write is refused the switch goes back to what is stored and the reason is
 * shown (the old switch stayed flipped on a failed save). While one write is in flight the switches wait, so two quick flips cannot race. The invitation
 * switch is locked on: the reader must be reachable when invited.
 */
export function NotificationPreferences({ userId }: { userId: string }) {
  const [prefs, setPrefs] = useState<NotificationPrefs>({ ...DEFAULT_NOTIFICATION_PREFS });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readNotificationPrefs(browserClient(), userId).then((r) => {
      if (cancelled) return;
      setPrefs(r.prefs);
      setLoadError(r.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, attempt]);

  async function flip(key: SwitchKey) {
    const before = prefs;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    setSaving(true);
    setError(null);
    const message = await saveNotificationPrefs(browserClient(), userId, next);
    setSaving(false);
    if (message) {
      setPrefs(before);
      return setError(`Not saved, the switch is back where it was: ${message}`);
    }
    setSaved(true);
  }

  if (loading) return <p className={styles.muted}>Loading notification preferences...</p>;
  if (loadError) {
    return (
      <StateNote tone="error" action={{ label: "Retry", onClick: () => (setLoading(true), setAttempt((n) => n + 1)) }}>
        Notification preferences did not load: {loadError}
      </StateNote>
    );
  }
  return (
    <div>
      {SWITCHES.map((row) => (
        <PrefRow key={row.key} label={row.label} description={row.description} on={prefs[row.key]} busy={saving} onFlip={() => void flip(row.key)} />
      ))}
      <PrefRow label="Workspace invitations" description="Always on, you must be reachable" on locked onFlip={() => undefined} />
      {error ? <InlineErrorBanner message={error} /> : null}
      <Toast message="Notification preferences saved." visible={saved} onDismiss={() => setSaved(false)} />
    </div>
  );
}
