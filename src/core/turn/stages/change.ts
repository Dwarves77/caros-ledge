// Ported from old_repo/scripts/turns/run-change-detection.mjs (lines 57-85)
// Ported from old_repo/scripts/turns/run-change-detection.mjs (lines 177-339)
// Ported from old_repo/scripts/turns/run-change-detection.mjs (lines 389-448)
// Ported from old_repo/scripts/turns/run-change-detection.mjs (lines 629-645)
// Stage 3, change: the cadence gate, the check in process over the free fetch ladder (no render service, no hop to our own app), one reconcile, one drain of the staged updates it produced.
import { runChangeDetection } from "@/core/capture";
import type { ChangeDetectionDeps } from "@/core/capture/change-detection";
import type { FamilyCall } from "@/core/harness";
import type { RunResult } from "@/core/types/run-result";
import { leadWithFailures, worst } from "@/core/types/run-result";
import { drainChangeSweepUpdates, persistPortalCandidates } from "@/features/intake";
import { reconcileChanges, writeSnapshot } from "@/features/sources";
import { extractPortalLinks } from "@/features/sources/walkers/portal-links";

import type { BuiltDeps } from "../wiring";

const CHANGE_DEFAULT_LIMIT = 10;
const DRAIN_CALLER = "turn-change";

function planChange(input: Record<string, unknown>): { limit: number; drainLimit: number | undefined } {
  return { limit: typeof input.limit === "number" ? input.limit : CHANGE_DEFAULT_LIMIT, drainLimit: typeof input.drainLimit === "number" ? input.drainLimit : undefined };
}

/** One result from the check, the reconcile it ran and the drain after it. A failed read anywhere is a failed stage, never zero changes. Pure. */
export function shapeChange(check: RunResult, drain: RunResult, changedSourceIds: readonly string[]): RunResult {
  const recon = (check.data as { reconcile?: RunResult | null } | undefined)?.reconcile ?? null;
  const counts = { checked: check.counts.checked ?? 0, changes_detected: check.counts.changes_detected ?? 0, portal_candidates: check.counts.portal_candidates ?? 0, would_check: check.counts.would_check ?? 0, reconciled: recon?.counts.processed ?? 0, staged: recon?.counts.staged ?? 0, update_applied: drain.counts.approved ?? 0, update_rejected: drain.counts.rejected ?? 0, failed: (check.counts.failed ?? 0) + (drain.counts.stamp_failed ?? 0) };
  return { counts, outcome: worst(check.outcome, drain.outcome), notes: leadWithFailures([check, drain]), data: { ids: { changed_source_ids: [...changedSourceIds] } } };
}

export async function runChange(call: FamilyCall, d: BuiltDeps): Promise<RunResult> {
  const plan = planChange(call.input);
  const deps: ChangeDetectionDeps = {
    db: d.sb, now: d.now, env: d.env, resolveHost: null, ...(d.fetch.sleep ? { sleep: d.fetch.sleep } : {}), fetchImpl: d.fetch.fetchImpl ?? fetch,
    harvestPortal: async (sourceId, html, url) => (await persistPortalCandidates(d.sb, sourceId, extractPortalLinks(html, url), d.now().toISOString())).upserted,
    writeSnapshot: (sourceId, snap) => writeSnapshot(d.sb, sourceId, snap),
    reconcile: (i) => reconcileChanges({ db: d.sb, now: d.now }, i),
  };
  const started = d.now().toISOString();
  const check = await runChangeDetection(deps, { limit: plan.limit, dry: call.dry });
  const drain = await drainChangeSweepUpdates(d.intake, { caller: DRAIN_CALLER, dry: call.dry, ...(plan.drainLimit ? { limit: plan.drainLimit } : {}) });
  let changed: string[] = [];
  if (!call.dry && (check.counts.changes_detected ?? 0) > 0) {
    const q = await d.sb.from("monitoring_queue").select("source_id").eq("change_detected", true).gte("checked_at", started);
    if (q.error) return { ...shapeChange(check, drain, []), outcome: "failed", notes: [`changed-source read failed: ${q.error.message}`] };
    changed = [...new Set(((q.data ?? []) as { source_id: string }[]).map((r) => r.source_id))];
  }
  return shapeChange(check, drain, changed);
}
