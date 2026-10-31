// Ported from old_repo/src/lib/forward-events/obligation-rail-select.mjs (lines 1-54)
// The rail card's rows: events inside 30 days of the server's day, soonest first, at most the artboard's four. UTC day math; `now` is passed in by the
// caller (the server's clock, never the client's).
import { normalizeDisplayTitle } from "@/core/fetch/titles";

const OBLIGATION_RAIL_WINDOW_DAYS = 30;
const OBLIGATION_RAIL_ROW_CAP = 4;
const MS_PER_DAY = 86_400_000;

/** UTC midnight (ms) of the leading YYYY-MM-DD of a value, or null. */
function utcDayStart(value: unknown): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms : null;
}
/** Whole days from `from`'s UTC day to the event date; null when the date does not parse. */
export function daysFrom(eventDate: unknown, from: Date): number | null {
  const target = utcDayStart(eventDate);
  return target === null ? null : Math.round((target - Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) / MS_PER_DAY);
}
export function selectObligationRailRows<E extends { event_date?: unknown }>(events: readonly E[] | null | undefined, now: Date): E[] {
  if (!Array.isArray(events)) return [];
  return events
    .map((ev) => ({ ev, days: ev && typeof ev === "object" ? daysFrom(ev.event_date, now) : null }))
    .filter((e): e is { ev: E; days: number } => e.days !== null && e.days >= 0 && e.days <= OBLIGATION_RAIL_WINDOW_DAYS)
    .sort((a, b) => a.days - b.days)
    .slice(0, OBLIGATION_RAIL_ROW_CAP)
    .map((e) => e.ev);
}
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function formatBy(eventDate: unknown, precision: unknown, compact: boolean): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(eventDate || ""));
  if (!m) return String(eventDate || "");
  const [, year, month, day] = m as unknown as [string, string, string, string];
  const full = MONTH_NAMES[parseInt(month, 10) - 1] ?? month;
  const name = compact ? full.slice(0, 3) : full;
  if (precision === "year") return year;
  if (precision === "month") return `${name} ${year}`;
  return compact ? `${name} ${parseInt(day, 10)} ${year}` : `${name} ${parseInt(day, 10)}, ${year}`;
}
/** "March 4, 2026", "March 2026" or "2026" by precision; a malformed date is shown verbatim, never guessed. */
export const formatForwardEvent = (eventDate: unknown, precision: unknown): string => formatBy(eventDate, precision, false);
/** The compact form: "Mar 4 2026". */
export const formatForwardEventCompact = (eventDate: unknown, precision: unknown): string => formatBy(eventDate, precision, true);

const RAIL_TITLE_MAX = 80;
const RAIL_LEAD_MAX = 140;
const cut = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${(space > max * 0.6 ? head.slice(0, space) : head).replace(/[\s,;:.—-]+$/, "")}…`;
};
/** A rail row's two lines: the item's short title (an Annex list is the title's tail and goes) and the first sentence of the clause cut at 140 characters; the full clause lives on the item. */
export function railRowLines(ev: { item: { title: string | null }; obligation_text: string }): { title: string; lead: string } {
  const text = String(ev.obligation_text ?? "").replace(/\s+/g, " ").trim();
  return { title: cut(normalizeDisplayTitle(ev.item.title ?? "").title, RAIL_TITLE_MAX), lead: cut(text.split(/(?<=[.!?])\s+/)[0] ?? text, RAIL_LEAD_MAX) };
}
