// Ported from old_repo/scripts/obligations/derive-obligations.mjs (lines 203-213)
// Ported from old_repo/scripts/obligations/derive-obligations.mjs (lines 304-322)
// Ported from old_repo/scripts/maintenance/derive-obligations.mjs (lines 1-74)
// The derive job, the operator's REPLAY of what the connect stage does a bounded batch at a time (scan-backlog.ts is the primary path): the register derivation and the obligation-object producer in one run (rule 17: the object writer has its producer here),
// over every verified live item unless ids are named, in batches of items (a capture is a whole document). Dry by default at the caller. The outcome is the worst of the batches; the counts carry both parts, summed.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { worst } from "@/core/intake/result";
import type { RunResult } from "@/core/sources/run-result";

import { deriveObligationObjects, type Candidate } from "../derive/derive-objects";
import { deriveRegister } from "../derive/derive-register";

/** Items per derivation read. */
const BATCH = 20;

export interface DeriveJobInput {
  dry: boolean;
  /** Restrict to these items; every verified live item when absent. */
  itemIds?: readonly string[];
  /** Session-authored object candidates, written under the same rules as the produced ones. */
  extraCandidates?: readonly Candidate[];
}

export async function deriveObligationsJob(deps: { sb: Db }, input: DeriveJobInput): Promise<RunResult> {
  const ids = input.itemIds ?? (await fetchAllRows<{ id: string }>((from, to) => deps.sb.from("intelligence_items").select("id").eq("provenance_status", "verified").eq("is_archived", false).order("id", { ascending: true }).range(from, to), { cap: 100_000 })).map((r) => r.id);
  const counts: Record<string, number> = {};
  const notes: string[] = [];
  const outcomes: RunResult["outcome"][] = [];
  const add = (prefix: string, r: RunResult) => {
    for (const [k, v] of Object.entries(r.counts)) counts[`${prefix}_${k}`] = (counts[`${prefix}_${k}`] ?? 0) + v;
    notes.push(...r.notes);
    outcomes.push(r.outcome);
  };
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    add("register", await deriveRegister(deps.sb, { dry: input.dry, itemIds: slice }));
    add("objects", await deriveObligationObjects(deps.sb, { dry: input.dry, itemIds: slice }));
  }
  if (input.extraCandidates?.length) add("objects", await deriveObligationObjects(deps.sb, { dry: input.dry, itemIds: [], extraCandidates: input.extraCandidates }));
  return { counts, outcome: worst("ok", ...outcomes), notes: [...new Set(notes)] };
}
