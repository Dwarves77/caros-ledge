// New in CTX-5 (ADR-050): the pending regulatory triggers of an item as a list of what the database holds, never a sentence about them: the date, the kind's label from the page's own table, the event's verbatim obligation text,
// and the verbatim span the date was read from (the source pinpoint). One component for the regulation and research pages; nothing here is composed from the item.
import { formatDate } from "@/core/shared";

export interface PendingEvent {
  id?: string;
  event_date: string | null;
  event_kind: string;
  obligation_text?: string | null;
  source_span?: string | null;
}
/** The forward-event kinds that name an act or guidance still to come (the regulator's trigger), as opposed to a dated duty. */
const PENDING_REGULATORY_KINDS: ReadonlySet<string> = new Set(["implementing_act_due", "delegated_act_due", "guidance_expected"]);
export const pendingTriggers = <E extends { event_kind: string }>(events: readonly E[] | undefined): E[] => (events ?? []).filter((e) => PENDING_REGULATORY_KINDS.has(e.event_kind));

export function PendingTriggers({ events, kindLabels = {} }: { events: readonly PendingEvent[]; kindLabels?: Readonly<Record<string, string>> }) {
  if (events.length === 0) return null;
  return (
    <div className="cl-summary-subcard cl-summary-subcard--pending">
      <p className="cl-summary-subcard-title">Pending regulatory triggers</p>
      <ul className="cl-trigger-list">
        {events.map((ev, i) => (
          <li key={ev.id ?? i}>
            <span style={{ fontWeight: 600, color: "var(--ink)" }}>{ev.event_date ? formatDate(ev.event_date) : "No date on file"}</span> · {kindLabels[ev.event_kind] ?? ev.event_kind}
            {ev.obligation_text ? ` · ${ev.obligation_text}` : ""}
            {ev.source_span ? <span className="cl-trigger-source">Source text: “{ev.source_span}”</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
