// Ported from old_repo/src/components/ui/Masthead.tsx (lines 44-50)
import { isoWeek } from "@/core/shared";

/** The ISO week of the calendar day `nowIso` names in UTC, the same on the server and in any browser timezone. */
export function weekOfIso(nowIso: string): number {
  const d = new Date(nowIso);
  return isoWeek(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
