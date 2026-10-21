// Ported from old_repo/src/lib/forward-events/kind-labels.mjs (lines 1-8)
// Ported from old_repo/src/lib/forward-events/read-upcoming.mjs (lines 1-10)
// The one holder of the forward-event vocabularies in code: the six kinds, the default kinds of a customer read (every kind but `other`), the labels and
// the three precisions. The database CHECKs of migrations 274 and 290 stay as the enforcement; the drift test compares them with these.
export const EVENT_KINDS = ["entry_into_force", "compliance_deadline", "review_or_report", "phase_step", "consultation_close", "other"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const DEFAULT_KINDS: readonly EventKind[] = EVENT_KINDS.filter((k) => k !== "other");
export const KIND_LABELS: Readonly<Record<EventKind, string>> = {
  entry_into_force: "Entry into force",
  compliance_deadline: "Compliance deadline",
  review_or_report: "Review / report",
  phase_step: "Phase step",
  consultation_close: "Consultation close",
  other: "Other",
};
export const PRECISIONS = ["day", "month", "year"] as const;
export type Precision = (typeof PRECISIONS)[number];

