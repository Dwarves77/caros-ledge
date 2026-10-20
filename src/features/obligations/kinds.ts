// Ported from old_repo/src/lib/forward-events/kind-labels.mjs (lines 1-8)
// Ported from old_repo/src/lib/forward-events/read-upcoming.mjs (lines 1-10)
// The one holder of the forward-event vocabularies in code: the seven kinds, the default kinds of a customer read (every kind but `other` and `target`), the labels and
// the three precisions. The database CHECKs of migrations 0113 stay as the enforcement; the drift test compares them with these.
export const EVENT_KINDS = ["entry_into_force", "compliance_deadline", "review_or_report", "phase_step", "consultation_close", "target", "other"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const DEFAULT_KINDS: readonly EventKind[] = EVENT_KINDS.filter((k) => k !== "other" && k !== "target");
export const KIND_LABELS: Readonly<Record<EventKind, string>> = {
  entry_into_force: "Entry into force",
  compliance_deadline: "Compliance deadline",
  review_or_report: "Review / report",
  phase_step: "Phase step",
  consultation_close: "Consultation close",
  target: "Target",
  other: "Other",
};
export const PRECISIONS = ["day", "month", "year"] as const;
export type Precision = (typeof PRECISIONS)[number];

const BINDING_INSTRUMENT_TYPES = new Set([
  "regulation",
  "directive",
  "standard",
  "guidance",
  "framework",
]);

export function isBindingInstrumentType(itemType: string | null | undefined): boolean {
  return typeof itemType === "string" && BINDING_INSTRUMENT_TYPES.has(itemType);
}
