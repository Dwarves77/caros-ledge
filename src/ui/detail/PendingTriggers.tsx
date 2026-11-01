// New in CTX-5 (ADR-050): the pending regulatory triggers of an item as a list of what the database holds, never a sentence about them: the date, the kind's label from the page's own table, the event's verbatim obligation text,
// and the verbatim span the date was read from (the source pinpoint). One component for the regulation and research pages; nothing here is composed from the item.
import { formatDate } from "@/core/shared";

export interface PendingEvent {
  id?: string;
  /** The instrument the mandate is filed under (item_forward_events.intelligence_item_id); drawn as data-instrument-item so the live gate compares ids, not text. */
  intelligence_item_id?: string;
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
      <p className="cl-summary-subcard-title">
        <span>Pending regulatory triggers</span>
        <span className="cl-trigger-count">{events.length} {events.length === 1 ? "mandate" : "mandates"}</span>
      </p>
      <div className="cl-trigger-rows">
        {events.map((ev, i) => (
          <div key={ev.id ?? i} className="cl-trigger-row" data-instrument-item={ev.intelligence_item_id}>
            <div className="cl-trigger-meta">
              <span className="cl-trigger-date">{ev.event_date ? formatDate(ev.event_date) : "Unscheduled"}</span>
              <span className="cl-trigger-kind">{kindLabels[ev.event_kind] ?? ev.event_kind.replace(/_/g, " ")}</span>
            </div>
            <p className="cl-trigger-text">{ev.obligation_text ?? "Rulemaking mandate scheduled in primary instrument."}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
