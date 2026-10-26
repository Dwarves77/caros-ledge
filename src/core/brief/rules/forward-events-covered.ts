// New in FWD-COVER-1: the coverage half of the no-vacuum rule (J17 keeps the interpretive half). Every dated forward event and timeline row the export supplied appears in the brief: the entry's events block carries its date, a section states it in a rendering of data/date-renderings.json, or the entry's omitted_events names the date with a reason. Dates only; no word matching (ADR-053).
import { violation } from "./_text";
import { stated } from "./stored-date-stated";
import type { Rule } from "./types";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** A date at its precision, as the key coverage compares: a day is YYYY-MM-DD, a month YYYY-MM (stored YYYY-MM-01), a year YYYY (stored YYYY-01-01). */
export const precisionKey = (date: string, precision?: string | null): string => (precision === "month" ? date.slice(0, 7) : precision === "year" ? date.slice(0, 4) : date.slice(0, 10));
/** A month or year key written in a section: "June 2031" or "Jun 2031" (a month), the year as a word (a year). A day key goes through the register renderings. */
const statedAtPrecision = (body: string, key: string): boolean => {
  const text = body.toLowerCase();
  if (key.length === 4) return new RegExp(String.raw`b${key}b`).test(text);
  const name = MONTHS[Number(key.slice(5, 7)) - 1] ?? "";
  return text.includes(`${name} ${key.slice(0, 4)}`) || text.includes(`${name.slice(0, 3)} ${key.slice(0, 4)}`);
};

const rule: Rule = (b, i) => {
  const supplied = [...new Set((i.supplied_dates ?? []).map((d) => (d.length >= 10 ? d.slice(0, 10) : d)))];
  const events = new Set(b.events ?? []);
  const omitted = (b.omitted ?? []).filter((o) => o.reason.trim()).map((o) => o.date);
  const missing = supplied.filter((d) => !events.has(d) && !omitted.some((o) => o.startsWith(d)) && !(d.length === 10 ? stated(b.body, d) : statedAtPrecision(b.body, d)));
  return missing.length ? violation("forward-events-covered", `${missing.length} supplied forward event or timeline date(s) never appear in the brief (events block, a section, or omitted_events with a reason): ${missing.slice(0, 6).join(", ")}`, "") : null;
};
export default rule;
