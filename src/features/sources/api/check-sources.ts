// Ported from old_repo/src/app/api/worker/check-sources/route.ts (lines 36-81)
import { type ChangeDetectionDeps, runChangeDetection, validateCheckLimit } from "@/core/capture/change-detection";
import { serviceClient } from "@/core/db/clients";
import { route } from "@/core/http/errors";
import { workerAuthGuard } from "@/core/http/guard";
import { checkRateLimit } from "@/core/http/rate-limit";
import { isGloballyPaused } from "@/core/fetch/hold";

import { reconcileChanges } from "../change";
import { writeSnapshot } from "../snapshots";

const OFF = { checked: 0, sourcesChecked: 0, changesDetected: 0, portalCandidates: 0 };

/**
 * POST /api/worker/check-sources: the worker secret, then the shared limiter (one bucket for this route), then the optional limit (400 on a bad value, before any state check), then the hold
 * gate. While the cadence is off it exits with 0 checked (build mode, rule 16: an expected consequence, not a defect). Otherwise it runs the change-detection pass and the reconcile pass in process.
 * Portal-link harvesting is wired by the dispatcher that owns the intake ledger; this route runs without it.
 */
export const POST = route("/api/worker/check-sources", async (request) => {
  const denied = workerAuthGuard(request);
  if (denied) return denied;
  const limited = checkRateLimit("worker:/api/worker/check-sources");
  if (limited) return limited;
  let raw: unknown = new URL(request.url).searchParams.get("limit") ?? undefined;
  const body = await request.text();
  if (body.trim()) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && "limit" in parsed) raw = (parsed as { limit: unknown }).limit;
    } catch (e) {
      return Response.json({ error: `invalid JSON body: ${(e as Error).message}` }, { status: 400 });
    }
  }
  const limit = validateCheckLimit(raw);
  if (!limit.ok) return Response.json({ error: limit.error }, { status: 400 });
  const db = serviceClient();
  if (await isGloballyPaused(db)) return Response.json({ message: "Scraping is off (cadence 'off' or emergency stop); worker exiting", ...OFF });
  const deps: ChangeDetectionDeps = {
    db,
    now: () => new Date(),
    writeSnapshot: (sourceId, snap) => writeSnapshot(db, sourceId, snap),
    reconcile: (input) => reconcileChanges({ db, now: () => new Date() }, input),
  };
  const run = await runChangeDetection(deps, { limit: limit.limit });
  if (run.outcome === "failed") return Response.json({ error: run.notes.join("; ") || "change detection failed" }, { status: 500 });
  return Response.json({
    message: run.notes[0] && run.counts.checked === 0 ? run.notes[0] : `Checked ${run.counts.checked} sources`,
    checked: run.counts.checked,
    sourcesChecked: run.counts.checked,
    changesDetected: run.counts.changes_detected,
    portalCandidates: run.counts.portal_candidates,
    results: run.data?.results ?? [],
    reconcile: run.data?.reconcile ?? null,
    notes: run.notes,
  });
});
