// Ported from old_repo/src/lib/intake/flywheel-steps.mjs (lines 1-107)
// Ported from old_repo/src/lib/intake/mint-enrichment.ts (lines 33-64)
// Ported from old_repo/src/lib/intake/flywheel-defect.ts (lines 8-67)
// Ported from old_repo/src/lib/intake/apply-staged-update.ts (lines 114-192)
// Ported from old_repo/src/lib/intake/mint-item.ts (lines 269-445)
// ONE step list for a mint and for a substantive update (the two used to disagree: the mint path inserted every extracted forward event
// with no dedupe key and wrote lineage and a timeline row, the update path deduped and flagged stale events and did neither). Every
// step is independent: a failure is a RECORDED rule-16(d) defect flag (deduped on item and step), never a silent skip, and the write of
// that flag is itself checked. A step that does not apply to the context is skipped, not run empty.
import { deriveTimeline, derivedTimelineRow } from "@/core/brief/timeline";
import { runResult, type RunResult } from "@/core/intake/result";
import { openFlagOnce } from "@/core/grounding/flags";
import type { Db } from "@/core/db";

import type { ConnectDeps } from "./deps";

export type ParticipationContext = "mint" | "update";
export interface ParticipationInput {
  itemId: string;
  context: ParticipationContext;
  /** The columns an update changed (decides whether entities are re-linked). */
  changed?: readonly string[];
  /** What the mint decided, for the steps that act on it. */
  mint?: { title?: string | null; sourceUrl?: string | null; linkTargetItemId?: string | null; seekStudy?: boolean; lowRelevance?: number | null };
  dry?: boolean;
}
export interface ParticipationDeps { sb: Db; connect: ConnectDeps; now: () => Date }
export type ParticipationResult = RunResult & { flags: string[] };

const DEFECT_STEP: Record<string, string> = {
  lineage: "entities",
  discovery: "discovery",
  "forward-events": "forward-events",
  "stale-events": "stale-events",
  "compliance-deadline": "compliance-deadline",
  obligations: "obligations",
  entities: "entities",
  timeline: "timeline",
};
const STEP_LABEL: Record<string, string> = {
  discovery: "(a) connection discovery",
  "forward-events": "(b) forward-event extraction",
  "stale-events": "(b) forward-event staleness",
  "compliance-deadline": "(b) compliance_deadline sync",
  obligations: "(b) obligation derivation",
  entities: "(e) entity references and lineage",
  timeline: "(f) timeline title-derivation",
};

/** Rule 16(d): a failure (or a staleness finding) is an open integrity flag, deduped on (item, step). Returns a note if the flag itself could not be written. */
async function recordDefect(sb: Db, itemId: string, step: string, message: string, context: ParticipationContext): Promise<string | null> {
  const sub = DEFECT_STEP[step] ?? step;
  const stale = sub === "stale-events";
  const label = STEP_LABEL[sub] ?? sub;
  return openFlagOnce(sb, {
    category: "data_quality", subject_type: "item", subject_ref: itemId, created_by: `flywheel-defect:${sub}`,
    description: `rule 16 ${label} ${stale ? "flagged" : "failed"} at ${context} for item ${itemId}: ${message}`,
    recommended_actions: [stale
      ? { action: "review-stale-events", rationale: `${label}: existing item_forward_events row(s) reference a claim or section that no longer exists: review whether the events are still valid; never auto-deleted` }
      : { action: "investigate", rationale: `${label} did not run for this item: the write proceeded (non-fatal by design) but the flywheel step never completed and must be re-run or diagnosed` }],
  });
}

const UPDATE_RELINK = new Set(["jurisdiction_iso", "canonical_instrument_key"]);

/** Run the participation steps for a mint or a substantive update. Never throws. */
export async function runParticipation(deps: ParticipationDeps, input: ParticipationInput): Promise<ParticipationResult> {
  const { sb, connect } = deps;
  const { itemId, context } = input;
  const flags: string[] = [];
  const notes: string[] = [];
  const counts: Record<string, number> = { steps_run: 0, steps_failed: 0 };
  if (input.dry) return { ...runResult("ok", counts, ["dry: no step run"]), flags };

  const step = async (id: string, when: boolean, run: () => Promise<void>) => {
    if (!when) return;
    counts.steps_run = (counts.steps_run ?? 0) + 1;
    try {
      await run();
    } catch (e) {
      counts.steps_failed = (counts.steps_failed ?? 0) + 1;
      flags.push(`${id}-failed`);
      const n = await recordDefect(sb, itemId, id, e instanceof Error ? e.message : String(e), context);
      notes.push(`${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      if (n) notes.push(n);
    }
  };
  const mint = input.mint;
  const isMint = context === "mint";

  await step("lineage", isMint && !!mint?.linkTargetItemId && mint.linkTargetItemId !== itemId, async () => {
    // "related" is the CHECK-legal relationship (the old "references" was CHECK-illegal and its error swallowed, so no dedup:linked edge was ever written).
    const { error } = await sb.from("item_cross_references").upsert({ source_item_id: itemId, target_item_id: mint?.linkTargetItemId, relationship: "related", origin: "entity_extraction" }, { onConflict: "source_item_id,target_item_id", ignoreDuplicates: true });
    if (error) throw new Error(`item_cross_references upsert failed: ${error.message}`);
    flags.push("lineage:1");
  });
  await step("discovery", true, async () => {
    const { written } = await connect.connect(itemId);
    if (written > 0) flags.push(`discovery:${written}`);
  });
  await step("forward-events", true, async () => {
    const r = await connect.extractAndInsertForwardEvents(itemId);
    if (r.staleIds.length) {
      const n = await recordDefect(sb, itemId, "stale-events", `${r.staleIds.length} existing item_forward_events row(s) reference a claim/section no longer present: ${r.staleIds.join(", ")}`, context);
      if (n) notes.push(n);
      flags.push(`stale-events:${r.staleIds.length}`);
    }
    if (r.attempted > 0) flags.push(r.collision ? "forward-events:0" : `forward-events:${r.inserted}`);
    if (r.complianceDeadline?.changed) flags.push(`compliance-deadline:${r.complianceDeadline.value}`);
  });
  await step("obligations", true, async () => {
    const r = await connect.deriveObligations(itemId);
    if (r.derived > 0) flags.push(`obligations:${r.derived}`);
  });
  await step("entities", isMint || (input.changed ?? []).some((c) => UPDATE_RELINK.has(c)), async () => {
    const r = await connect.linkEntities(itemId);
    if (r.refs > 0 || r.instrumentEntityId) flags.push(`entities:${r.refs}${r.instrumentEntityId ? "+instrument" : ""}`);
  });
  // ADR-030: a record item born without a timeline row gets the title-derived row, verified verbatim against the item's own capture.
  // Usually a no-op at mint (captures arrive later); never fabricates.
  await step("timeline", isMint, async () => {
    const have = await sb.from("item_timelines").select("id").eq("item_id", itemId).limit(1);
    if (have.error) throw new Error(`item_timelines read failed: ${have.error.message}`);
    if ((have.data ?? []).length) return;
    const caps = await sb.from("agent_run_searches").select("result_content, searched_at").eq("intelligence_item_id", itemId);
    if (caps.error) throw new Error(`agent_run_searches read failed: ${caps.error.message}`);
    const rows = (caps.data ?? []) as { result_content: string | null; searched_at: string | null }[];
    const best = rows.filter((r) => (r.result_content ?? "").trim().length > 200).sort((a, b) => (b.result_content ?? "").length - (a.result_content ?? "").length)[0];
    const d = deriveTimeline({ title: mint?.title ?? null, capturedText: best?.result_content ?? null });
    if (d.result?.source !== "title") return;
    const row = derivedTimelineRow(d.result, deps.now().toISOString().slice(0, 10));
    const ins = await sb.from("item_timelines").insert({ ...row, item_id: itemId });
    if (ins.error) throw new Error(`item_timelines insert failed: ${ins.error.message}`);
    flags.push("timeline:title");
  });
  if (isMint && mint?.seekStudy) {
    const n = await openFlagOnce(sb, { category: "data_quality", subject_type: "item", subject_ref: itemId, created_by: "intake-seek-study", description: `research_finding minted on a news/press source (${mint.sourceUrl ?? "unknown"}). The press release is a lead/corroborator: seek the study/report as the primary source and re-ground. (phase-intake-gate 1b)`, recommended_actions: [{ action: "Find the underlying study/report and re-source as primary", rationale: "a research_finding's primary must be the study, not a press release" }] });
    if (n) notes.push(n);
  }
  if (isMint && mint?.lowRelevance != null) {
    const n = await openFlagOnce(sb, { category: "data_quality", subject_type: "item", subject_ref: itemId, created_by: "intake-relevance", description: `Low freight-sustainability relevance (${mint.lowRelevance}) at intake for ${mint.sourceUrl ?? "unknown"}. Minted anyway (surface-only gate, Fork-4). Resolver: confirm on-vertical to keep; confirm off-vertical to archive off_domain via the gate.`, recommended_actions: [{ action: "keep", rationale: "confirmed on-vertical despite low score: relevance is fail-open by design" }, { action: "archive_off_domain", rationale: "confirmed off-vertical: archive via the eligibility gate (reversible, snapshot and cite)" }] });
    if (n) notes.push(n);
  }
  const outcome = (counts.steps_failed ?? 0) > 0 ? "partial" : "ok";
  return { ...runResult(outcome, counts, notes), flags };
}
