// New in FWD-COVER-1: the coverage half of the no-vacuum rule (J17 keeps the interpretive half). Every dated forward event and timeline row the export supplied appears in the brief: the entry's events block carries its date, a section states it in a rendering of data/date-renderings.json, or the entry's omitted_events names the date with a reason. Dates only; no word matching (ADR-053).
import { violation } from "./_text";
import { stated } from "./stored-date-stated";
import type { Rule } from "./types";

const rule: Rule = (b, i) => {
  const supplied = [...new Set((i.supplied_dates ?? []).map((d) => d.slice(0, 10)))];
  const events = new Set((b.events ?? []).map((d) => d.slice(0, 10)));
  const omitted = new Set((b.omitted ?? []).filter((o) => o.reason.trim()).map((o) => o.date.slice(0, 10)));
  const missing = supplied.filter((d) => !events.has(d) && !omitted.has(d) && !stated(b.body, d));
  return missing.length ? violation("forward-events-covered", `${missing.length} supplied forward event or timeline date(s) never appear in the brief (events block, a section, or omitted_events with a reason): ${missing.slice(0, 6).join(", ")}`, "") : null;
};
export default rule;
