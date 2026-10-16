// Ported from old_repo/scripts/obligations/derive-obligations.mjs (lines 203-213)
// Ported from old_repo/scripts/obligations/derive-obligations.mjs (lines 304-322)
// Ported from old_repo/scripts/maintenance/derive-obligations.mjs (lines 1-74)
// The derive job: the register derivation and the obligation-object producer in one run (rule 17: the object writer has its producer here). Dry by default at
// the caller. The outcome is the worst of the two parts; the counts carry both.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { worst } from "@/core/intake/result";
import type { RunResult } from "@/core/sources/run-result";

import { deriveObligationObjects, type Candidate } from "../derive/derive-objects";
import { deriveRegister } from "../derive/derive-register";

export interface DeriveJobInput {
  dry: boolean;
  /** Restrict to these items; every item with forward events or objects when absent. */
  itemIds?: readonly string[];
  /** Session-authored object candidates, written under the same rules as the produced ones. */
  extraCandidates?: readonly Candidate[];
}

export async function deriveObligationsJob(deps: { sb: Db }, input: DeriveJobInput): Promise<RunResult> {
  const register = await deriveRegister(deps.sb, { dry: input.dry, ...(input.itemIds ? { itemIds: input.itemIds } : {}) });
  let itemIds = input.itemIds;
  if (!itemIds) {
    const rows = await fetchAllRows<{ intelligence_item_id: string }>((from, to) => deps.sb.from("item_forward_events").select("intelligence_item_id").order("id", { ascending: true }).range(from, to), { cap: 2_000_000 });
    itemIds = [...new Set(rows.map((r) => r.intelligence_item_id))];
  }
  const objects = await deriveObligationObjects(deps.sb, { dry: input.dry, itemIds, ...(input.extraCandidates ? { extraCandidates: input.extraCandidates } : {}) });
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(register.counts)) counts[`register_${k}`] = v;
  for (const [k, v] of Object.entries(objects.counts)) counts[`objects_${k}`] = v;
  return { counts, outcome: worst(register.outcome, objects.outcome), notes: [...register.notes, ...objects.notes] };
}
