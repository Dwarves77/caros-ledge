// Ported from old_repo/src/workflows/generate-brief.ts (lines 60-78)
// Ported from old_repo/src/workflows/generate-brief.ts (lines 90-143)
// Ported from old_repo/src/workflows/generate-brief.ts (lines 176-187)
// Ported from old_repo/src/workflows/generate-brief.ts (lines 266-331)
// Ported from old_repo/src/workflows/generate-brief.ts (lines 364-431)
// Ported from old_repo/src/workflows/generate-brief.ts (lines 522-616)
// The brief workflow, free: the metered generate step is the injected-brief seam (a session authors the body, metadata and claim ledger
// against the stored pool). Steps: preflight (the data-audit block, fail closed), audit baseline, generate-from-injected, register,
// section, ground with the retry ladder, grow, link (the flywheel participation steps, rule 17), the cross-item audit gate, and
// research-or-erase. Every step writes its agent_runs row and every insert is CHECKED: a run whose ledger rows could not be written says
// so, and the workflow never claims a record was kept after a throw (the old record step swallowed its own insert failure).
import { crossItemAuditGate, hasValidWaiver, hostTierViolationCount, readAllSources, readOpenDataAuditBlock } from "@/core/grounding/audit-gate";
import { openFlagOnce } from "@/core/grounding/flags";
import { eraseClaimWithProof, groundRetryPlan, type ClaimRow } from "@/core/grounding/ledger";
import { fetchAllRows } from "@/core/db";
import { runResult, worst, type RunOutcome, type RunResult } from "@/core/intake/result";
import { hostOf } from "@/core/shared/url";

import type { IntakeDeps } from "./deps";
import { runParticipation } from "./flywheel-participation";
import { groundInjectedLedger, growSources, injectBrief, registerBriefSources, sectionBrief, type InjectInput } from "./pipeline";
import { cheapReverify } from "./quarantine/resolver";

export interface InjectedBrief extends Omit<InjectInput, "itemId" | "dry"> {
  /** The author's claim ledger (records validated by validateClaimRecords). */
  ledger: unknown;
  confirmations?: Record<string, { span: string; url: string }>;
}
export interface WorkflowInput {
  itemId: string;
  /** The first authoring pass. Without it (and without a stored brief to re-verify) the run stops at generate. */
  injected?: InjectedBrief;
  /** The second authoring pass for research-or-erase: authored against the WIDENED pool. Absent: a failed ground erases. */
  reresearch?: InjectedBrief;
  dry?: boolean;
}
export type WorkflowStatus = "verified" | "generate_failed" | "section_failed" | "grounding_frozen_held" | "structural_held_for_resource" | "reresearch_failed_held" | "audit_gate_failed_quarantined" | "preflight_blocked" | "dry";
export type WorkflowResult = RunResult & { itemId: string; status: WorkflowStatus; steps: Record<string, string> };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function startBriefWorkflow(deps: IntakeDeps, input: WorkflowInput): Promise<WorkflowResult> {
  const { sb, recorder } = deps;
  const { itemId } = input;
  const dry = input.dry === true;
  const counts: Record<string, number> = { steps_run: 0, steps_failed: 0, record_failed: 0 };
  const notes: string[] = [];
  const steps: Record<string, string> = {};
  const outcomes: RunOutcome[] = [];

  /** The step's agent_runs row (status trail; cost is always 0: nothing here is metered). A failed insert is counted and reported. */
  const record = async (label: string, ok: boolean, detail: string): Promise<void> => {
    steps[label] = `${ok ? "ok" : "failed"}: ${detail}`.slice(0, 300);
    counts.steps_run = (counts.steps_run ?? 0) + 1;
    if (!ok) counts.steps_failed = (counts.steps_failed ?? 0) + 1;
    if (dry) return;
    const it = await sb.from("intelligence_items").select("source_id, source_url").eq("id", itemId).maybeSingle();
    if (it.error) notes.push(`agent_runs ${label}: item read failed, null source attribution: ${it.error.message}`);
    const row = it.data as { source_id: string | null; source_url: string | null } | null;
    const ins = await sb.from("agent_runs").insert({ intelligence_item_id: itemId, source_id: row?.source_id ?? null, source_url: row?.source_url ?? null, fetch_method: `canonical:${label}`, status: ok ? "success" : "error", cost_usd_estimated: 0, ended_at: recorder.now().toISOString(), errors: ok ? [] : [{ step: label, detail }] });
    if (ins.error) {
      counts.record_failed = (counts.record_failed ?? 0) + 1;
      notes.push(`agent_runs row for ${label} NOT written: ${ins.error.message}`);
    }
  };
  const finish = async (status: WorkflowStatus): Promise<WorkflowResult> => {
    const outcome = status === "verified" || status === "dry" ? worst(...outcomes, (counts.record_failed ?? 0) > 0 ? "partial" : "ok") : worst("failed", ...outcomes);
    const result: WorkflowResult = { ...runResult(outcome, counts, notes), itemId, status, steps };
    if (!dry) {
      const rec = await recorder.recordRun({ family: "brief-workflow", itemId, outcome, counts, notes: [`status=${status}`, ...notes] });
      if (rec.error) result.notes.push(`run ledger row not written: ${rec.error}`);
    }
    return result;
  };
  const step = async <T>(label: string, run: () => Promise<T>, judge: (v: T) => { ok: boolean; detail: string }): Promise<T | null> => {
    try {
      const v = await run();
      const j = judge(v);
      await record(label, j.ok, j.detail);
      return v;
    } catch (e) {
      await record(label, false, `threw: ${message(e)}`);
      outcomes.push("partial");
      return null;
    }
  };
  const asStep = (r: RunResult & { detail?: string }) => ({ ok: r.outcome !== "failed", detail: r.detail ?? (r.notes.join("; ").slice(0, 200) || r.outcome) });

  // PREFLIGHT: generation halts while the data-audit lane is RED with no current dated waiver. A block that cannot be read halts too (fail closed).
  let baseline = 0;
  try {
    const block = await readOpenDataAuditBlock(sb);
    if (block && !hasValidWaiver(block, recorder.now())) {
      await record("preflight", false, `generation blocked: data-audit lane is RED with no current disposition (integrity_flags ${block.id}); clear it by fixing to green or record a dated waiver`);
      return finish("preflight_blocked");
    }
    const sources = await readAllSources(sb);
    baseline = await hostTierViolationCount(sources, (u) => deps.sources.resolveSource(u));
    await record("preflight", true, `data-audit block clear; ${baseline} standing host-tier violation(s) at baseline`);
  } catch (e) {
    await record("preflight", false, `halted failing closed: ${message(e)}`);
    return finish("preflight_blocked");
  }

  // GENERATE-FROM-INJECTED: validate and write the session-authored brief, or (no injection) require a stored brief to ground.
  if (input.injected) {
    const { ledger: _l, confirmations: _c, ...brief } = input.injected;
    void _l; void _c;
    const g = await step("generate", () => injectBrief(deps, { itemId, ...brief, ...(dry ? { dry: true } : {}) }), (r) => ({ ok: r.ok, detail: r.detail }));
    if (!g?.ok) return finish("generate_failed");
  } else {
    const has = await sb.from("intelligence_items").select("full_brief").eq("id", itemId).maybeSingle();
    const body = (has.data as { full_brief: string | null } | null)?.full_brief;
    if (has.error || !body) {
      await record("generate", false, has.error ? `item read failed: ${has.error.message}` : "no injected brief and no stored brief: an author must supply one");
      return finish("generate_failed");
    }
    await record("generate", true, "no new injection: grounding the stored brief");
  }
  if (dry) {
    await step("ground", () => groundInjectedLedger(deps, { itemId, ledger: input.injected?.ledger ?? [], dry: true, ...(input.injected?.confirmations ? { confirmations: input.injected.confirmations } : {}) }), (r) => ({ ok: r.valid, detail: r.detail }));
    return finish("dry");
  }

  await step("register", () => registerBriefSources(deps, itemId), (r) => ({ ok: true, detail: r.notes.join("; ").slice(0, 200) || "registered" }));
  const sec = await step("section", () => sectionBrief(deps, itemId), (r) => asStep(r));
  if (!sec || sec.outcome === "failed") return finish("section_failed");

  /** Ground: the author's ledger through the gates, or (no ledger authored) the $0 re-verify of what the item already holds. */
  const ground = async (label: string, inj: InjectedBrief | undefined): Promise<{ ok: boolean; detail: string }> => {
    const r = await step(label, async () => {
      if (inj?.ledger !== undefined) return groundInjectedLedger(deps, { itemId, ledger: inj.ledger, replaceLedger: true, ...(inj.confirmations ? { confirmations: inj.confirmations } : {}) }).then((g) => ({ ok: g.ok, detail: g.detail }));
      const d = await cheapReverify(sb, itemId);
      if (d.outcome !== "verified_cheap") return { ok: false, detail: `grounding_frozen: ${d.reason}: a session-authored ledger resolves it (never fetched)` };
      const rpc = await sb.rpc("validate_item_provenance", { p_item_id: itemId });
      return rpc.error ? { ok: false, detail: `validate_item_provenance failed: ${rpc.error.message}` } : { ok: true, detail: `verified via stored-capture re-verify ($0): ${d.reason}` };
    }, (v) => v);
    return r ?? { ok: false, detail: steps[label] ?? "ground threw" };
  };
  let g = await ground("ground", input.injected);
  if (!g.ok && g.detail.startsWith("grounding_frozen")) return finish("grounding_frozen_held");
  if (!g.ok) {
    const plan = groundRetryPlan(g.detail);
    if (plan === "structural_hold") {
      const e = await eraseStep(deps, itemId, "structural_no_source", notes);
      await record("erase", e.ok, e.detail);
      return finish("structural_held_for_resource");
    }
    const again = plan === "reground" ? await ground("reground", input.injected) : null;
    if (again?.ok) g = again;
    else {
      // research-or-erase: ONE widened second pass, authored against the widened pool; absent or failed, the brief is nulled and the item held.
      let ok = false;
      if (input.reresearch) {
        const { ledger: _l, confirmations: _c, ...brief } = input.reresearch;
        void _l; void _c;
        const rg = await step("reresearch", () => injectBrief(deps, { itemId, ...brief, allowBriefOverwrite: true }), (r) => ({ ok: r.ok, detail: r.detail }));
        const rs = rg?.ok ? await sectionBrief(deps, itemId) : null;
        ok = !!rs && rs.outcome !== "failed" && (await ground("reground-widened", input.reresearch)).ok;
      } else await record("reresearch", false, "no widened second pass was authored: erasing");
      if (!ok) {
        const e = await eraseStep(deps, itemId, "reresearch_failed", notes);
        await record("erase", e.ok, e.detail);
        return finish("reresearch_failed_held");
      }
    }
  }

  await step("grow", () => growSources(deps, itemId), (r) => asStep(r));
  // LINK (rule 17): the downstream of a brief is the flywheel participation steps, run in the same run.
  await step("link", () => runParticipation({ sb, connect: deps.connect, now: () => recorder.now() }, { itemId, context: "update", changed: ["full_brief", "jurisdiction_iso"] }), (r) => ({ ok: r.outcome !== "failed", detail: r.flags.join(",") || r.notes.join("; ").slice(0, 160) || "no new links" }));

  // CROSS-ITEM AUDIT GATE: non-optional, fail closed. On a failure the write does not stand: the brief is erased and the cause recorded.
  const gate = await step("audit-gate", () => crossItemAuditGate(sb, itemId, baseline, (u) => deps.sources.resolveSource(u), hostOf), (r) => ({ ok: r.ok, detail: r.detail }));
  if (!gate || !gate.ok) {
    const cause = gate?.detail ?? "cross-item audit threw";
    const e = await eraseStep(deps, itemId, "reresearch_failed", notes);
    await record("erase", e.ok, e.detail);
    const flagNote = await openFlagOnce(sb, { category: "data_integrity", subject_type: "item", subject_ref: itemId, created_by: "audit-gate", description: `Cross-item audit gate failed on the generation write; brief erased and item quarantined. ${cause}`, recommended_actions: [{ action: "investigate_cross_item_failure", rationale: cause }] });
    if (flagNote) {
      counts.record_failed = (counts.record_failed ?? 0) + 1;
      notes.push(`audit-gate quarantine reason NOT recorded: ${flagNote}`);
    }
    return finish("audit_gate_failed_quarantined");
  }
  return finish("verified");
}

/**
 * Brief-nulled-held: the ungroundable brief body, its sections, claims and harvested timeline are removed and the item stays quarantined
 * for re-source (it is never archived). Claims go through eraseClaimWithProof (archived first). Each delete is CHECKED and the first failure ends the erase with ok:false (a silently failed erase
 * left bad-host FACT spans in the corpus tally). The explanatory flag is its own distinct row; other producers' flags are untouched.
 */
async function eraseStep(deps: Pick<IntakeDeps, "sb" | "recorder">, itemId: string, kind: "reresearch_failed" | "structural_no_source", notes: string[] = []): Promise<{ ok: boolean; detail: string }> {
  const { sb, recorder } = deps;
  const fail = (what: string, error: { message: string }) => ({ ok: false, detail: `erase ${what} FAILED for ${itemId}: ${error.message}` });
  // RD-45: a claim is erased only through eraseClaimWithProof (its final state archived to claim_versions FIRST, the delete after).
  let claims: ClaimRow[];
  try {
    claims = await fetchAllRows<ClaimRow>((from, to) => sb.from("section_claim_provenance").select("id, section_row_id, claim_text, claim_kind, source_span, source_id, search_result_id, source_tier_at_grounding, mint_hold_reason").eq("intelligence_item_id", itemId).order("id", { ascending: true }).range(from, to), { cap: 20_000 });
  } catch (e) {
    return { ok: false, detail: `erase claim read FAILED for ${itemId}: ${message(e)}` };
  }
  for (const c of claims) {
    try {
      await eraseClaimWithProof(sb, c, itemId, { reason: `brief nulled and item held (${kind}): the ungroundable brief does not stand`, kind }, { nowIso: recorder.now().toISOString() });
    } catch (e) {
      return { ok: false, detail: `erase claim ${c.id} FAILED for ${itemId}: ${message(e)}` };
    }
  }
  const secs = await sb.from("intelligence_item_sections").delete().eq("item_id", itemId);
  if (secs.error) return fail("sections delete", secs.error);
  const tl = await sb.from("item_timelines").delete().eq("item_id", itemId);
  if (tl.error) return fail("timeline delete", tl.error);
  const nulled = await sb.from("intelligence_items").update({ full_brief: null, updated_at: recorder.now().toISOString() }).eq("id", itemId);
  if (nulled.error) return fail("full_brief null", nulled.error);
  const flag = kind === "structural_no_source"
    ? { category: "source_issue", created_by: "source-link-repair", description: "Brief nulled, item HELD quarantined for re-source: grounding hit a STRUCTURAL wall (no linked source). Not re-researched: widening the pool cannot conjure a source link.", recommended_actions: [{ action: "register_and_link_source", rationale: "the item has no source_id; register the source_url in the sources registry and link it, then re-ground" }] }
    : { category: "data_quality", created_by: "research-or-erase", description: "Brief nulled, item HELD quarantined for re-source: re-research failed grounding; ungroundable content removed. The item stays quarantined pending re-source.", recommended_actions: [{ action: "brief_nulled_held", rationale: "re-research failed grounding; ungroundable content removed; item held for re-source" }] };
  const n = await openFlagOnce(sb, { subject_type: "item", subject_ref: itemId, ...flag });
  if (n) notes.push(n);
  return { ok: true, detail: `brief-nulled-held (${kind}): ungroundable brief removed, item held quarantined for re-source` };
}
