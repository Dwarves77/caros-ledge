// Ported from old_repo/src/components/ui/Absence.tsx (lines 166-207)
import { ABSENCE_DASH, NEEDS_PHRASE, type AbsenceReason } from "./absence-reason";

/** `reason` draws the needs-phrase; `dash` (a cell too narrow for the phrase) draws the dash with the phrase on aria-label and title. */
export function Absence({ reason, variant = "reason" }: { reason: AbsenceReason; variant?: "reason" | "dash" }) {
  if (variant === "dash") {
    return (
      <span className="cl-absence-dash" data-absence="dash" data-part="absence" data-part-variant="dash" aria-label={NEEDS_PHRASE[reason]} title={NEEDS_PHRASE[reason]}>
        {ABSENCE_DASH}
      </span>
    );
  }
  return (
    <span className="cl-absence" data-absence="needs" data-part="absence" data-part-variant="reason">
      {NEEDS_PHRASE[reason]}
    </span>
  );
}
