"use client";

// Ported from old_repo/src/components/ui/RelativeTime.tsx (lines 25-35)
import { useSyncExternalStore } from "react";

import { relativeTimeLabel, stableDateLabel } from "./relative-time";

// One shared ticker for every mounted instance: a module-level interval with subscribers (the old part started one interval per instance).
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let minute = 0;

function subscribe(onChange: () => void): () => void {
  subscribers.add(onChange);
  if (timer === null) {
    minute = Math.trunc(performance.timeOrigin + performance.now());
    timer = setInterval(() => {
      minute = Math.trunc(performance.timeOrigin + performance.now());
      subscribers.forEach((fn) => fn());
    }, 60_000);
  }
  return () => {
    subscribers.delete(onChange);
    if (subscribers.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}
const snapshot = (): number => minute;

/** Hydration-safe relative time: the stable date until mounted, then "N min ago" on the shared minute tick. */
export function RelativeTime({ iso }: { iso: string }) {
  const now = useSyncExternalStore(subscribe, snapshot, () => 0);
  return <>{now === 0 ? stableDateLabel(iso) : relativeTimeLabel(iso, now)}</>;
}
