// Ported from old_repo/src/components/ui/Absence.tsx (lines 166-207)
import { ABSENCE_DASH, NEEDS_PHRASE, type AbsenceReason } from "./absence-reason";

/** `reason` draws the needs-phrase, or `text` when the data names the exact input the value is waiting for (IMPACT-1: "No obligations extracted yet"); `dash` (a cell too narrow for the phrase) draws the dash with the phrase on the title and on aria-label, which `label` replaces when the cell's own name is the better one (the impact cell). */
export function Absence({ reason, variant = "reason", label, text }: { reason: AbsenceReason; variant?: "reason" | "dash"; label?: string; text?: string | null | undefined }) {
  const phrase = text ?? NEEDS_PHRASE[reason];
  if (variant === "dash") {
    return (
      <span className="cl-absence-dash" data-absence="dash" data-part="absence" data-part-variant="dash" aria-label={label ?? phrase} title={phrase}>
        {ABSENCE_DASH}
      </span>
    );
  }
  return (
    <span className="cl-absence" data-absence="needs" data-part="absence" data-part-variant="reason">
      {phrase}
    </span>
  );
}
