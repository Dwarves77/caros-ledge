// Ported from old_repo/src/components/dashboard/DashboardMasthead.tsx (lines 51-90)
import { refusalSentence } from "@/core/http/failure";
import { formatNumber } from "@/core/shared";
import { ALL_SECTORS } from "@/core/workspace/vocabulary";
import { Absence, Masthead } from "@/ui";
import { ShellCommandBar } from "@/ui/shell";

import { deriveBriefTitle, SURFACES } from "../rows";

/**
 * The personalised masthead: "<name>'s Brief", the item and jurisdiction counts, the workspace and its verticals, and the command bar. The item count is the sum of the rail card's four surface counts (the same
 * read, the same render) over the surfaces of the one list. A count the read could not answer (null) says so in words (the brief below carries the Retry); it is never a zero, "pending" or a constant. A reader with
 * no workspace has nothing to count: `noWorkspace` leaves the dek without a count.
 */
export function DashboardMasthead({ firstName, orgName, sectors, itemCount, jurisdictionCount, noWorkspace = false, dateLabel, nowIso }: { firstName: string | null; orgName: string; sectors: readonly string[]; itemCount: number | null; jurisdictionCount: number | null; noWorkspace?: boolean; dateLabel: string; nowIso: string }) {
  const verticals = sectors.flatMap((id) => ALL_SECTORS.find((s) => s.id === id)?.label ?? []);
  const dek = (
    <>
      <div>
        {noWorkspace ? null : `${itemCount === null ? refusalSentence("masthead_items_unavailable") : `${formatNumber(itemCount)} items across ${SURFACES.length} surfaces`} · ${jurisdictionCount === null ? refusalSentence("masthead_jurisdictions_unavailable") : `${formatNumber(jurisdictionCount)} jurisdictions`} · `}scoped to {orgName || <Absence reason="not in primary source" />}
      </div>
      <div>Verticals: {verticals.length > 0 ? verticals.join(", ") : <Absence reason="not in primary source" />}</div>
    </>
  );
  return <Masthead title={deriveBriefTitle(firstName)} dateLabel={dateLabel} nowIso={nowIso} dek={dek} commandBar={<ShellCommandBar />} />;
}
