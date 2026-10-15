"use client";

// Ported from old_repo/src/components/auth/AuthFrame.tsx (lines 24-250)
// Ported from old_repo/src/lib/constants.ts (lines 1-2)
// Ported from old_repo/src/lib/urgency/bands.ts (lines 36-85)
import { useSyncExternalStore, type ReactNode } from "react";

import { formatLocaleDate, isoWeek } from "@/core/shared/dates";

import styles from "./auth.module.css";

const APP_NAME = "Caro's Ledge";
const APP_TAGLINE = "Freight Sustainability Intelligence";
const EDITORIAL_VOLUME = "IV";

// The four urgency bands, taught once on the auth frame (onboarding artboard 17): real vocabulary, no numbers.
const BANDS = [
  { key: "immediate", label: "Immediate", window: "≤ 90 days" },
  { key: "action", label: "Action", window: "≤ 6 months" },
  { key: "monitor", label: "Monitor", window: "6–12 months" },
  { key: "awareness", label: "Awareness", window: "background" },
] as const;

let clientToday: Date | null = null;
const noSubscription = () => () => {};

/** Today, from the visitor's clock after hydration (null on the server and during hydration): the server's date can differ, and a wall-clock read during render mismatches. */
export function useToday(): Date | null {
  return useSyncExternalStore(noSubscription, () => (clientToday ??= new Date()), () => null);
}

export const DATE_LABEL = { weekday: "long", year: "numeric", month: "long", day: "numeric" } as const;

/** The logged-out frame: identity panel (brand, band legend, the app's one legal disclaimer) and the caller's content. Below 768px it is one column, form first. */
export function AuthFrame({ children }: { children: ReactNode }) {
  const today = useToday();
  return (
    <div className={styles.desk}>
      <div className={styles.frame}>
        <div className={styles.identity}>
          <div>
            <div className={styles.rule} />
            <div className={styles.appName}>{APP_NAME}</div>
            <div className={styles.tagline}>{APP_TAGLINE}</div>
          </div>
          <div className={styles.legendBlock}>
            <div className={styles.volume}>VOL {EDITORIAL_VOLUME}{today ? ` · No. ${isoWeek(today)} · ${formatLocaleDate(today, DATE_LABEL)}` : ""}</div>
            <div className={styles.legendTitle}>Every item, one of four urgency bands</div>
            <div className={styles.legend}>
              {BANDS.map((b) => (
                <div key={b.key}>
                  <div className={styles.bandName} style={{ color: `var(--${b.key})` }}>
                    {b.label}
                  </div>
                  <div className={styles.bandWindow}>{b.window}</div>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.disclaimer}>
            For informational purposes only. Not legal advice. Regulations move fast, always verify with official sources before acting.{" "}
            <a href="/privacy">Privacy</a>
          </div>
        </div>
        <div className={styles.panel}>{children}</div>
      </div>
    </div>
  );
}

/** The shared page head: the date eyebrow, the title, and an optional dek. */
export function AuthMasthead({ title, dek }: { title: string; dek?: string }) {
  const today = useToday();
  return (
    <header className={styles.masthead}>
      {today && <div className={styles.eyebrow}>{formatLocaleDate(today, DATE_LABEL)}</div>}
      <h1 className={styles.title}>{title}</h1>
      {dek && <p className={styles.dek}>{dek}</p>}
    </header>
  );
}
