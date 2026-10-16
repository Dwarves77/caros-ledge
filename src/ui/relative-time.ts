// Ported from old_repo/src/components/ui/relative-time-format.ts (lines 1-27)
import { formatDate } from "@/core/shared";

/** The server-and-first-paint label: a UTC calendar date, independent of the clock, so hydration never mismatches. */
export function stableDateLabel(iso: string): string {
  return Number.isNaN(new Date(iso).getTime()) ? "" : formatDate(iso.slice(0, 10));
}

/** "5 min ago" ... "3 mo ago" at `nowMs`; the caller supplies the clock (a render never reads one). */
export function relativeTimeLabel(iso: string, nowMs: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const minutes = Math.floor(Math.max(0, nowMs - t) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days} day${days === 1 ? "" : "s"} ago` : `${Math.floor(days / 30)} mo ago`;
}
