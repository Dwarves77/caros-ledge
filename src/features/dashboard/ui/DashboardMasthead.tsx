// Ported from old_repo/src/components/dashboard/DashboardMasthead.tsx (lines 51-90)
import { formatNumber } from "@/core/shared";
import { ALL_SECTORS } from "@/core/workspace";
import { Absence, Masthead } from "@/ui";
import { ShellCommandBar } from "@/ui/shell";

import { deriveBriefTitle } from "../rows";

const SURFACES = 5;

/**
 * The personalised masthead: "<FIRST NAME>'S BRIEF", the item and jurisdiction counts, the workspace and its verticals, and the command bar. A count the read could not answer, or a workspace with
 * no name, draws the Absence convention and never a zero or a made-up name.
 */
export function DashboardMasthead({ firstName, orgName, sectors, itemCount, jurisdictionCount, dateLabel, nowIso }: { firstName: string | null; orgName: string; sectors: readonly string[]; itemCount: number | null; jurisdictionCount: number | null; dateLabel: string; nowIso: string }) {
  const verticals = sectors.flatMap((id) => ALL_SECTORS.find((s) => s.id === id)?.label ?? []);
  const dek = (
    <>
      <div>
        {itemCount === null ? <Absence reason="pending" /> : formatNumber(itemCount)} items across {SURFACES} surfaces · {jurisdictionCount === null ? <Absence reason="pending" /> : `${formatNumber(jurisdictionCount)} jurisdictions`} · scoped to {orgName || <Absence reason="not in primary source" />}
      </div>
      <div>Verticals: {verticals.length > 0 ? verticals.join(", ") : <Absence reason="not in primary source" />}</div>
    </>
  );
  return <Masthead title={deriveBriefTitle(firstName, orgName)} dateLabel={dateLabel} nowIso={nowIso} dek={dek} commandBar={<ShellCommandBar />} />;
}
