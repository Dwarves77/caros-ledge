// Ported from old_repo/src/app/api/admin/b2-progress/route.ts (lines 26-98)
import { CONTRACT_VERSION } from "@/core/brief";
import { allRows } from "@/core/db";

import { adminRoute, reply } from "./shared";

export interface ProgressRow {
  id: string;
  legacy_id: string | null;
  regeneration_skill_version: string | null;
  source_url: string | null;
}

/** Brief regeneration progress against the current contract: eligible live items with a source, those at the contract, those at an older one, those never regenerated. Pure. */
function progressOf(rows: readonly ProgressRow[]) {
  const eligible = rows.filter((r) => r.source_url && !(r.legacy_id ?? "").startsWith("ss") && !(r.legacy_id ?? "").startsWith("arc"));
  const atCurrent = eligible.filter((r) => r.regeneration_skill_version === CONTRACT_VERSION).length;
  const never = eligible.filter((r) => !r.regeneration_skill_version).length;
  return { contract_version: CONTRACT_VERSION, total_eligible: eligible.length, at_current: atCurrent, at_older_version: eligible.length - atCurrent - never, never_regenerated: never, pct_complete: eligible.length === 0 ? 0 : Math.round((atCurrent / eligible.length) * 100) };
}

export const GET = adminRoute("/api/admin/b2-progress", async (admin) => {
  const rows = await allRows<ProgressRow>(admin.service(), "intelligence_items", "id, legacy_id, regeneration_skill_version, source_url", { where: (q) => q.eq("is_archived", false) });
  return reply(admin, progressOf(rows));
});
