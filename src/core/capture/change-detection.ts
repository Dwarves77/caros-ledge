// Ported from old_repo/src/app/api/worker/check-sources/logic.ts (lines 31-178)
// Ported from old_repo/src/lib/sources/content-change.mjs (lines 1-30)
// Ported from old_repo/src/app/api/worker/check-sources/route.ts (lines 83-147)
import { createHash } from "node:crypto";

import { urlIsRoot } from "@/core/fetch/classify-body";
import { fetchDirect, type FetchDeps } from "@/core/fetch/direct";
import { getScrapeState, scrapeWindowOpen } from "@/core/fetch/hold";
import { classifyReachability, decideSourceAssessment, REACH } from "@/core/fetch/reachability";
import { storageMaxChars } from "@/core/fetch/policy";
import { outcomeOf, type RunDeps, type RunResult } from "@/core/sources/run-result";

const MIN_FINGERPRINT_CHARS = 200;
/** Rendered text normalised for fingerprinting: whitespace collapsed, lower-cased. */
const normalizeForFingerprint = (text: unknown): string => String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
/** The sha256 fingerprint of rendered text, or null when the capture is too thin to fingerprint honestly (under 200 normalised characters: the error-page band). */
function contentFingerprint(text: string | null | undefined): string | null {
  const norm = normalizeForFingerprint(text);
  return norm.length < MIN_FINGERPRINT_CHARS ? null : createHash("sha256").update(norm).digest("hex");
}
/** A change only when both fingerprints exist and differ: a missing prior (first observation) or a missing current (thin or failed capture) is never a change. */
const isContentChange = (prevHash: string | null | undefined, nextHash: string | null | undefined): boolean => !!prevHash && !!nextHash && prevHash !== nextHash;

const DEFAULT_CHECK_LIMIT = 10;
const MAX_CHECK_LIMIT = 50;

/** A bounded batch size: an integer 1 to 50, default 10. */
export function validateCheckLimit(raw: unknown): { ok: true; limit: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, limit: DEFAULT_CHECK_LIMIT };
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_CHECK_LIMIT) return { ok: false, error: `limit must be an integer between 1 and ${MAX_CHECK_LIMIT} (got ${JSON.stringify(raw)})` };
  return { ok: true, limit: n };
}

/** The values the pass writes to monitoring_queue.last_result: exactly the column's CHECK vocabulary (a change is `updated`, a non-answer is `error`, a definitive dead is `inaccessible`). */
const MONITORING_RESULT = { changed: "updated", unchanged: "no_change", inconclusive: "error", dead: "inaccessible" } as const;

export interface CheckSourceRow {
  id: string;
  name: string;
  url: string;
  base_tier: number;
  status: string;
  consecutive_accessible: number | null;
  successful_checks: number | null;
  total_checks: number | null;
  last_content_hash: string | null;
}
export interface ChangeDetectionDeps extends RunDeps, Omit<FetchDeps, "now"> {
  /** Extract and persist portal deep links from a root portal's markup; returns the number recorded. Wired by the caller (the intake ledger is another slice). */
  harvestPortal?: (sourceId: string, html: string, url: string) => Promise<number>;
  /** Store the checked body as a snapshot when the content seeds or changes, so a later change has two captures to diff. */
  writeSnapshot?: (sourceId: string, snap: { html: string; status: number; isoDay: string }) => Promise<unknown>;
  /** The reconcile pass, run in process after the batch (rule 17): the queue rows this pass just wrote are consumed in the same run. */
  reconcile?: (input: { dry?: boolean }) => Promise<RunResult>;
}
export interface SourceAssessment {
  source: string;
  status: string;
  httpStatus: number;
  outcome: string;
  changeDetected: boolean;
  portalCandidates: number;
  errors: string[];
}

/**
 * Assess one source over the shared direct fetch (no metered render): reachability by the three-way classifier, so a non-answer never evicts and only a
 * definitive 404 or 410 with a zero streak may; the fingerprint of the decoded text, so a first observation only seeds the hash and a thin capture is never a change.
 * The three writes after the assessment read their errors; a failed write is reported on the result, never dropped.
 */
async function assessAndUpdateSource(deps: ChangeDetectionDeps, source: CheckSourceRow): Promise<SourceAssessment> {
  const errors: string[] = [];
  const now = deps.now();
  const res = await fetchDirect(source.url, deps, { max: storageMaxChars((deps.env ?? process.env) as Record<string, string | undefined>), keepHtml: true });
  const errored = res.status === 0 || res.refusal?.reason === "network";
  const httpStatus = res.status;
  const outcome = classifyReachability({ status: httpStatus || null, errored });
  const decision = decideSourceAssessment({ outcome, source: { status: source.status, consecutive_accessible: source.consecutive_accessible ?? undefined } });
  const newHash = decision.isAccessible ? contentFingerprint(res.text) : null;
  const changeDetected = isContentChange(source.last_content_hash, newHash);
  const stamp = now.toISOString();

  const updates: Record<string, unknown> = { last_checked: stamp, consecutive_accessible: decision.consecutive_accessible, total_checks: (source.total_checks ?? 0) + 1 };
  if (newHash) updates.last_content_hash = newHash;
  if (changeDetected) updates.last_content_changed_at = stamp;
  if (decision.isAccessible) {
    updates.last_accessible = stamp;
    updates.successful_checks = (source.successful_checks ?? 0) + 1;
    if (decision.reactivate) updates.status = "active";
  } else {
    updates.last_inaccessible = stamp;
    if (decision.evictEligible) updates.status = "inaccessible";
  }
  const upd = await deps.db.from("sources").update(updates).eq("id", source.id);
  if (upd.error) errors.push(`sources update failed: ${upd.error.message}`);
  const ev = await deps.db.from("source_trust_events").insert({ source_id: source.id, event_type: "accessibility_check", details: { type: "accessibility_check", success: decision.isAccessible, http_status: httpStatus, reachability: outcome, change_detected: changeDetected, content_hash: newHash }, created_by: "worker" });
  if (ev.error) errors.push(`source_trust_events insert failed: ${ev.error.message}`);
  const lastResult = decision.isAccessible ? (changeDetected ? MONITORING_RESULT.changed : MONITORING_RESULT.unchanged) : outcome === REACH.DEAD ? MONITORING_RESULT.dead : MONITORING_RESULT.inconclusive;
  const mq = await deps.db.from("monitoring_queue").insert({ source_id: source.id, scheduled_check: stamp, priority: "normal", last_result: lastResult, change_detected: changeDetected, checked_at: stamp, error_message: decision.isAccessible ? null : `${outcome} (HTTP ${httpStatus})` });
  if (mq.error) errors.push(`monitoring_queue insert failed: ${mq.error.message}`);

  if (deps.writeSnapshot && res.html && newHash && (changeDetected || !source.last_content_hash)) {
    try {
      await deps.writeSnapshot(source.id, { html: res.html, status: httpStatus, isoDay: stamp.slice(0, 10) });
    } catch (e) {
      errors.push(`snapshot write failed: ${(e as Error).message}`);
    }
  }
  let portalCandidates = 0;
  if (decision.isAccessible && res.html && deps.harvestPortal && urlIsRoot(source.url)) {
    try {
      portalCandidates = await deps.harvestPortal(source.id, res.html, source.url);
    } catch (e) {
      errors.push(`portal harvest failed: ${(e as Error).message}`);
    }
  }
  return { source: source.name, status: decision.isAccessible ? "accessible" : outcome, httpStatus, outcome, changeDetected, portalCandidates, errors };
}

/**
 * The check-sources pass. It exits with nothing checked while the cadence is off or the emergency stop is set (rule 16: an expected consequence, not a defect), and off a
 * scheduled scrape day. Otherwise it selects active, unpaused, auto-run sources not yet checked in this UTC day (base_tier order), assesses each, then runs the reconcile pass in
 * the same run. `dry` selects and counts without fetching. Every read and write reports its error.
 */
export async function runChangeDetection(deps: ChangeDetectionDeps, input: { limit?: number; dry?: boolean } = {}): Promise<RunResult<{ results: SourceAssessment[]; reconcile: RunResult | null }>> {
  const limit = input.limit ?? DEFAULT_CHECK_LIMIT;
  const state = await getScrapeState(deps.db);
  const empty = (note: string): RunResult<{ results: SourceAssessment[]; reconcile: RunResult | null }> => ({ counts: { checked: 0, changes_detected: 0, portal_candidates: 0, failed: 0 }, outcome: "ok", notes: [note], data: { results: [], reconcile: null } });
  if (state.cadence === "off" || state.emergencyPaused) return empty("scraping is off (cadence 'off' or emergency stop): 0 sources checked");
  if (!scrapeWindowOpen(state, deps.now())) return empty(`not a scheduled scrape day (cadence=${state.cadence}): 0 sources checked`);
  const t = deps.now();
  const windowStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())).toISOString();
  const due = await deps.db
    .from("sources")
    .select("id, name, url, base_tier, status, consecutive_accessible, successful_checks, total_checks, last_content_hash")
    .eq("status", "active")
    .eq("processing_paused", false)
    .eq("auto_run_enabled", true)
    .or(`last_checked.is.null,last_checked.lt.${windowStart}`)
    .order("base_tier", { ascending: true })
    .limit(limit);
  if (due.error) return { counts: { checked: 0, changes_detected: 0, portal_candidates: 0, failed: 1 }, outcome: "failed", notes: [`due-sources read failed: ${due.error.message}`] };
  const sources = (due.data ?? []) as CheckSourceRow[];
  if (input.dry) return { counts: { would_check: sources.length, checked: 0, changes_detected: 0, portal_candidates: 0, failed: 0 }, outcome: "ok", notes: ["dry: nothing fetched"], data: { results: [], reconcile: null } };
  const results: SourceAssessment[] = [];
  const notes: string[] = [];
  let failed = 0;
  for (const source of sources) {
    try {
      const r = await assessAndUpdateSource(deps, source);
      results.push(r);
      if (r.errors.length) failed++;
      notes.push(...r.errors.map((e) => `${source.name}: ${e}`));
    } catch (e) {
      failed++;
      notes.push(`${source.name}: ${(e as Error).message}`);
    }
  }
  const reconcile = deps.reconcile ? await deps.reconcile({}).catch((e: Error): RunResult => ({ counts: {}, outcome: "failed", notes: [`reconcile failed: ${e.message}`] })) : null;
  if (reconcile && reconcile.outcome !== "ok") notes.push(...reconcile.notes);
  return {
    counts: { checked: results.length, changes_detected: results.filter((r) => r.changeDetected).length, portal_candidates: results.reduce((n, r) => n + r.portalCandidates, 0), failed },
    outcome: reconcile?.outcome === "failed" ? "partial" : outcomeOf(sources.length, failed),
    notes,
    data: { results, reconcile },
  };
}
