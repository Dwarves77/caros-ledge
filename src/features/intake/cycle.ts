// Ported from old_repo/src/lib/intake/run-intake-cycle.ts (lines 1-186)
// Ported from old_repo/src/lib/intake/run-intake-cycle.ts (lines 320-504)
// The intake cycle for a small candidate set: STAGE (transit-only), MINT through deps.mint (the one mint function; nothing here inserts an
// item), then either stop at record grade (the default: ONE pool row carries the captured text) or, when the caller supplies a session-
// authored brief through `briefFor`, run the brief workflow. PLAN mode is the same path in dry (no parallel planner). Every stamp and the
// pool-row insert are CHECKED. The change-sweep drain runs at the tail in the same invocation (rule 17). No wall clock but deps.now.
import { runResult, worst, type RunResult } from "@/core/intake/result";

import { drainChangeSweepUpdates } from "./change-sweep-drain";
import type { IntakeDeps } from "./deps";
import { applyStagedUpdate, stageCandidate, stampDisposition } from "./staged-transit";
import { assertPoolRowShape } from "./write-item";
import { startBriefWorkflow, type InjectedBrief } from "./workflow";

export type CycleMode = "plan" | "apply";
export const MANUAL_INTAKE_CALLER = "manual-intake-run";
export interface IntakeCandidate {
  title: string;
  source_url: string;
  item_type: string;
  /** The already-fetched text: carried to the pool row after a successful mint, NEVER staged (it is not a column). */
  capturedText?: string | null;
  [k: string]: unknown;
}
export type Disposition = "verified" | "rejected" | "ground_failed" | "stage_failed" | "would_mint" | "would_reject" | "record_only" | "pool_row_failed";
export interface CycleItemOutcome { title: string; source_url: string; stagedId: string | null; disposition: Disposition; gate?: string; reason?: string; itemId?: string | null; provenance?: string | null; evidence?: Record<string, string> }
export type CycleResult = RunResult & { mode: CycleMode; items: CycleItemOutcome[] };
export interface CycleInput {
  candidates: IntakeCandidate[];
  mode?: CycleMode;
  caller?: string;
  /** Default true: mint at record grade and stop. false means a brief is wanted and `briefFor` supplies it. */
  recordOnly?: boolean;
  /** The injected-brief seam: the session-authored brief for a freshly minted item, or null when none is authored (the item stays a record). */
  briefFor?: (candidate: IntakeCandidate, itemId: string) => Promise<InjectedBrief | null>;
  /** Drain budget for the change-sweep tail. */
  drainLimit?: number;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runIntakeCycle(deps: IntakeDeps, input: CycleInput): Promise<CycleResult> {
  const { sb, recorder } = deps;
  const mode = input.mode ?? "apply";
  const caller = input.caller ?? MANUAL_INTAKE_CALLER;
  const recordOnly = input.recordOnly !== false;
  const counts: Record<string, number> = { discovered: input.candidates.length, staged: 0, minted: 0, rejected: 0, verified: 0, record_only: 0, ground_failed: 0, stage_failed: 0, pool_row_failed: 0, would_mint: 0, would_reject: 0 };
  const bump = (k: string) => void (counts[k] = (counts[k] ?? 0) + 1);
  const notes: string[] = [];
  const items: CycleItemOutcome[] = [];

  // PLAN: the real mint path in dry (entity gate, congruence, dedup, relevance, source-link); stops before any write.
  if (mode === "plan") {
    for (const c of input.candidates) {
      const { capturedText: _t, ...fields } = c;
      void _t;
      const dry = await applyStagedUpdate(deps, { update_type: "new_item", item_id: null, proposed_changes: { ...fields } }, { dry: true });
      bump(dry.success ? "would_mint" : "would_reject");
      items.push({ title: c.title, source_url: c.source_url, stagedId: null, disposition: dry.success ? "would_mint" : "would_reject", ...(dry.success ? {} : { reason: dry.error ?? "rejected" }), evidence: { flags: (dry.flags ?? []).join(",") } });
    }
    return { ...runResult("ok", counts, notes), mode, items };
  }

  for (const c of input.candidates) {
    const nowIso = recorder.now().toISOString();
    const base: CycleItemOutcome = { title: c.title, source_url: c.source_url, stagedId: null, disposition: "stage_failed" };
    const st = await stageCandidate(sb, c, { recordOnly });
    if (st.error || !st.row || !st.id) {
      bump("stage_failed");
      items.push({ ...base, reason: st.error ?? "staged insert returned no row" });
      continue;
    }
    const stagedId = st.id;
    bump("staged");
    base.stagedId = stagedId;
    const mat = await applyStagedUpdate(deps, { id: stagedId, update_type: "new_item", item_id: null, proposed_changes: (st.row.proposed_changes ?? {}) as Record<string, unknown> });
    const stamp = async (patch: Record<string, unknown>) => {
      const s = await stampDisposition(sb, stagedId, patch);
      if (s.error) notes.push(`stamp failed for staged ${stagedId} (the row stays pending): ${s.error}`);
    };
    if (!mat.success || !mat.itemId) {
      await stamp({ status: "rejected", reviewed_by: caller, reviewed_at: nowIso, reviewer_notes: (mat.error ?? "machine-rejected").slice(0, 480) });
      bump("rejected");
      items.push({ ...base, disposition: "rejected", gate: mat.action ? `chokepoint:${mat.action}` : "entity-gate", reason: mat.error ?? "machine-rejected" });
      continue;
    }
    const itemId = mat.itemId;
    await stamp({ status: "approved", reviewed_by: caller, reviewed_at: nowIso, materialized_at: nowIso, materialized_item_id: itemId, materialization_error: null });
    bump("minted");
    const mint = `chokepoint:${mat.action ?? "minted"}${mat.flags?.length ? ` [${mat.flags.join(",")}]` : ""}`;

    // The captured text becomes the item's pool row (one checked insert), so the brief author reads it from the stored pool.
    if (c.capturedText) {
      const row = { intelligence_item_id: itemId, search_query: "canonical ground", result_url: c.source_url, result_title: "source", result_index: 0, result_content: c.capturedText, searched_at: nowIso };
      try {
        assertPoolRowShape(row);
        const ins = await sb.from("agent_run_searches").insert(row);
        if (ins.error) throw new Error(ins.error.message);
      } catch (e) {
        bump("pool_row_failed");
        notes.push(`pool row for ${itemId} NOT written: ${msg(e)}`);
        items.push({ ...base, disposition: "pool_row_failed", itemId, reason: msg(e), evidence: { mint } });
        continue;
      }
    }
    const injected = !recordOnly && input.briefFor ? await input.briefFor(c, itemId).catch((e: unknown) => (notes.push(`briefFor threw for ${itemId}: ${msg(e)}`), null)) : null;
    if (!injected) {
      bump("record_only");
      items.push({ ...base, disposition: "record_only", itemId, provenance: "record", reason: "record_only: the brief is authored later through the injected-brief seam; item_grade=record", evidence: { mint, workflow: "skipped(record_only)" } });
      continue;
    }
    const wf = await startBriefWorkflow(deps, { itemId, injected });
    const fin = await sb.from("intelligence_items").select("provenance_status").eq("id", itemId).maybeSingle();
    if (fin.error) notes.push(`provenance read-back failed for ${itemId}: ${fin.error.message}`);
    const provenance = (fin.data as { provenance_status?: string } | null)?.provenance_status ?? null;
    const evidence = { mint, workflow: wf.status, ...wf.steps };
    if (wf.status === "verified" && provenance === "verified") {
      bump("verified");
      items.push({ ...base, disposition: "verified", itemId, provenance, evidence });
    } else {
      bump("ground_failed");
      items.push({ ...base, disposition: "ground_failed", itemId, provenance, reason: `${wf.status}: ${wf.steps.ground ?? wf.steps.section ?? wf.steps.generate ?? ""}`, evidence });
    }
  }

  // The other half of the invocation (rule 17): drain pending change-sweep update rows, whether or not there were candidates.
  const drain = await drainChangeSweepUpdates(deps, { caller, ...(input.drainLimit ? { limit: input.drainLimit } : {}) });
  for (const [k, v] of Object.entries(drain.counts)) counts[`drain_${k}`] = v;
  notes.push(...drain.notes);
  const partial = (counts.stage_failed ?? 0) + (counts.pool_row_failed ?? 0) > 0 || notes.some((n) => n.includes("stamp failed"));
  return { ...runResult(worst(drain.outcome, partial ? "partial" : "ok"), counts, notes), mode, items };
}
