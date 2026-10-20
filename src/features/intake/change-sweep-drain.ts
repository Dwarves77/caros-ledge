// Ported from old_repo/src/lib/intake/run-intake-cycle.ts (lines 187-319)
// Drain pending change-sweep `update_item` staged rows (marked by CHANGE_SWEEP_STAGED_MARKER). Per row: APPLY (an empty patch writes
// nothing and is not an apply: the sweep never proposes replacement content), RE-VERIFY at $0 (cheapReverify over the stored captures),
// re-run the validation RPC on a verified_cheap outcome, then STAMP. Every stamp and read is checked: a failed stamp leaves the row
// pending and is reported (it was `await`ed and dropped, B-0062), and a failed read is a failed drain, never "nothing pending".
import { boundedRead } from "@/core/db";
import { runResult, type RunResult } from "@/core/intake/result";

import { type IntakeDeps } from "./deps";
import { cheapReverify } from "./quarantine/resolver";
import { applyStagedUpdate, CHANGE_SWEEP_STAGED_MARKER, stampDisposition, type StagedUpdateRow } from "./staged-transit";

const UPDATE_DRAIN_LIMIT = 5;
export interface DrainOutcome { stagedId: string; itemId: string | null; disposition: "update_applied" | "update_rejected"; reason: string; evidence?: Record<string, string> }
export type DrainResult = RunResult & { items: DrainOutcome[]; notDrained: number };

interface StagedRow extends StagedUpdateRow { id: string; source_url: string | null }

export async function drainChangeSweepUpdates(deps: IntakeDeps, input: { caller: string; limit?: number; dry?: boolean }): Promise<DrainResult> {
  const { sb } = deps;
  const limit = input.limit ?? UPDATE_DRAIN_LIMIT;
  const counts: Record<string, number> = { drained: 0, approved: 0, rejected: 0, not_drained: 0, stamp_failed: 0 };
  const notes: string[] = [];
  const items: DrainOutcome[] = [];
  const read = await boundedRead<StagedRow>((n) => sb.from("staged_updates").select("*").eq("update_type", "update_item").eq("status", "pending").like("reason", `${CHANGE_SWEEP_STAGED_MARKER}%`).order("created_at", { ascending: true }).limit(n), { limit: Math.min(200, limit + 1) });
  if (read.error) return { ...runResult("failed", counts, [`staged_updates read failed: ${read.error.message}`]), items, notDrained: 0 };
  const take = read.data.slice(0, limit);
  counts.not_drained = Math.max(0, read.data.length - limit);
  const now = deps.recorder.now().toISOString();
  const stamp = async (row: StagedRow, patch: Record<string, unknown>) => {
    if (input.dry) return;
    const s = await stampDisposition(sb, row.id, patch);
    if (s.error) {
      counts.stamp_failed = (counts.stamp_failed ?? 0) + 1;
      notes.push(`stamp failed for staged ${row.id} (the row stays pending): ${s.error}`);
    }
  };
  for (const row of take) {
    counts.drained = (counts.drained ?? 0) + 1;
    const itemId = row.item_id ?? null;
    const reject = async (reason: string) => {
      await stamp(row, { status: "rejected", reviewed_by: input.caller, reviewed_at: now, reviewer_notes: reason.slice(0, 480) });
      counts.rejected = (counts.rejected ?? 0) + 1;
      items.push({ stagedId: row.id, itemId, disposition: "update_rejected", reason });
    };
    if (!itemId) {
      await reject("change-sweep drain: staged row has no item_id: cannot apply or re-verify");
      continue;
    }
    const empty = Object.keys(row.proposed_changes ?? {}).length === 0;
    const applied = empty ? { success: true, flags: [] as string[] } : await applyStagedUpdate(deps, row, { dry: input.dry === true });
    if (!applied.success) {
      await reject(applied.error ?? "machine-rejected");
      continue;
    }
    let verdict: string;
    try {
      const d = await cheapReverify(sb, itemId);
      if (d.outcome === "verified_cheap" && !input.dry) {
        const rpc = await sb.rpc("validate_item_provenance", { p_item_id: itemId });
        const fin = await sb.from("intelligence_items").select("provenance_status").eq("id", itemId).maybeSingle();
        verdict = rpc.error ? `verified_cheap ($0): validate_item_provenance failed: ${rpc.error.message}` : fin.error ? `verified_cheap ($0): provenance read-back failed: ${fin.error.message}` : `verified_cheap ($0): validate_item_provenance re-run; provenance now '${(fin.data as { provenance_status?: string } | null)?.provenance_status ?? "unknown"}'`;
      } else verdict = `${d.outcome}: ${d.reason}${d.outcome === "needs_acquire" ? " (held: a session-authored ledger resolves it, never fetched)" : ""}`;
    } catch (e) {
      verdict = `re-verify failed: ${e instanceof Error ? e.message : String(e)}`;
      notes.push(verdict);
    }
    await stamp(row, { status: "approved", reviewed_by: input.caller, reviewed_at: now, materialized_at: now, materialization_error: null, reviewer_notes: `change-sweep re-verify: ${verdict}`.slice(0, 480) });
    counts.approved = (counts.approved ?? 0) + 1;
    items.push({ stagedId: row.id, itemId, disposition: "update_applied", reason: verdict, evidence: { apply: empty ? "no-op patch (nothing to write)" : `applied [${(applied.flags ?? []).join(",")}]` } });
  }
  return { ...runResult((counts.stamp_failed ?? 0) > 0 ? "partial" : "ok", counts, notes), items, notDrained: counts.not_drained ?? 0 };
}
