// Ported from old_repo/scripts/turns/apply-question-answers.mjs (lines 39-224)
// Ported from old_repo/scripts/turns/export-questions-for-answers.mjs (lines 19-166)
// Question answers applied (ADR-044): an answered question is written as an INFERENCE record through the one registration function (never a fact), the question flag is closed naming the inference and the pool it was
// answered against; an unanswerable one records that outcome on the flag and raises (or refreshes) ONE holdings-need target the research walker reads. A re-apply of the same batch writes nothing new; a changed
// held pool re-opens the question for a re-answer (the supersedes chain keeps the history). The answered items' cache is flushed in the same run.
import type { Db } from "@/core/db";
import { holdingsNeedRow, loadOpenNeedTargets, needAction, needOfFlag, parseQuestionRef, type NeedFlag, type ParsedQuestionRef } from "@/core/flags/need-targets";
import { registerFirstInference } from "@/core/propagation";
import { itemTag } from "@/core/cache";
import { runResult } from "@/core/types/run-result";
import { rowsByIds } from "@/core/db";

import { applyEntries, isObj, type ApplyOpts, type BatchDeps, type BatchExport, type EntrySpec, type Obj } from "../../kit/session-batch";

import { buildQuestionBundle, buildQuestionContext, currentInference, MAX_CONNECTED, loadInferencesByRef, loadQuestionFlags, loadQuestionMaterial, questionContexts, recordedAnswer, recordedOutcome, withAnsweredOutcome, withUnanswerableOutcome, type InferenceRow, type QuestionContext } from "./material";
import { validateAnswerEntry, type QaLive } from "./validate";

const DEFAULT_CHAR_BUDGET = 200_000;
const RESOLVED_BY = "apply-question-answers";
const LIVE = ["open", "in_review"];
const buildResolutionNote = (inferenceId: string, entry: { status_token: unknown; pool_hash: unknown }, batch: string): string => `answered by inference ${inferenceId} (batch ${batch}; status ${String(entry.status_token)}; pool_hash ${String(entry.pool_hash)})`;

interface QaState extends QaLive { flags: Map<string, { flag: NeedFlag; state: "open" | "answered" }>; ctx: Map<string, QuestionContext>; inferences: Map<string, InferenceRow[]>; needs: Map<string, NeedFlag> }
interface Plan { outcome: string; ref: string }

async function update(sb: Db, id: string, patch: Record<string, unknown>, statuses: readonly string[]): Promise<number> {
  const { data, error } = await sb.from("integrity_flags").update(patch).eq("id", id).in("status", [...statuses]).select("id");
  if (error) throw new Error(`integrity_flags update failed: ${error.message}`);
  return (data ?? []).length;
}

const questionAnswersSpec: EntrySpec<QaState, Plan> = {
  kind: "question-answers",
  batchRe: /^question-answers-[A-Za-z0-9._-]+$/,
  keyOf: (e) => (typeof e.subject_ref === "string" ? e.subject_ref : null),
  async load(deps, file) {
    const refs = new Set((file.entries as unknown[]).map((e) => (isObj(e) && typeof e.subject_ref === "string" ? e.subject_ref : "")).filter(Boolean));
    const found = await loadQuestionFlags(deps.sb);
    const flags: QaState["flags"] = new Map();
    for (const f of found.open) if (refs.has(f.subject_ref) && !flags.has(f.subject_ref)) flags.set(f.subject_ref, { flag: f, state: "open" });
    for (const f of found.answered) if (refs.has(f.subject_ref) && !flags.has(f.subject_ref)) flags.set(f.subject_ref, { flag: f, state: "answered" });
    const ctx = await questionContexts(deps.sb, new Map([...flags].map(([k, v]) => [k, v.flag])));
    const inferences = await loadInferencesByRef(deps.sb, [...refs]);
    const needs = new Map<string, NeedFlag>();
    for (const f of await loadOpenNeedTargets(deps.sb)) if (refs.has(f.subject_ref) && !needs.has(f.subject_ref)) needs.set(f.subject_ref, f);
    const questions: QaLive["questions"] = new Map();
    for (const [ref, c] of ctx) {
      const named = flags.get(ref) as { flag: NeedFlag; state: "open" | "answered" };
      // An answered question may be answered again only when the held pool differs from the one it was answered against.
      const open = named.state === "open" || recordedAnswer(named.flag)?.pool_hash !== c.pool_hash;
      questions.set(ref, { open, answered: named.state === "answered", questionText: c.questionText, itemUnusable: c.itemUnusable, pool_hash: c.pool_hash, members: c.members, unusable: c.unusable });
    }
    const done = (entry: Record<string, unknown>): boolean => {
      const named = flags.get(String(entry.subject_ref));
      if (!named) return false;
      if (entry.outcome === "unanswerable_from_holdings") return named.state === "open" && recordedOutcome(named.flag)?.pool_hash === entry.pool_hash && needs.has(String(entry.subject_ref));
      return entry.outcome === "answered" && named.state === "answered" && recordedAnswer(named.flag)?.pool_hash === entry.pool_hash && (inferences.get(String(entry.subject_ref)) ?? []).some((r) => r.claim_text === entry.answer);
    };
    return { questions, done, flags, ctx, inferences, needs };
  },
  entry: (e, i, live) => validateAnswerEntry(e, i, live),
  async write(deps, live, item, batch) {
    const { entry } = item;
    const ref = String(entry.subject_ref);
    const named = live.flags.get(ref) as { flag: NeedFlag; state: string };
    const parsed = parseQuestionRef(ref) as ParsedQuestionRef;
    const c = live.ctx.get(ref) as QuestionContext;
    const nowIso = deps.now().toISOString();
    const counts: Record<string, number> = {};
    if (entry.outcome === "answered") {
      const existing = currentInference(live.inferences.get(ref));
      let inferenceId: string;
      if (existing && existing.claim_text === entry.answer) inferenceId = existing.inference_id; // crash recovery or an unchanged answer: no second inference
      else {
        inferenceId = await registerFirstInference(deps.sb, { subjectId: c.item?.instrument_entity_id ?? null, claimText: String(entry.answer), statusToken: entry.status_token as "HYPOTHESIS" | "CONFIRMED", confidence: Number(entry.confidence), citedItemIds: entry.cited_item_ids as string[], triggerQuestionRef: ref, batch, supersedes: existing?.inference_id ?? null });
        counts.inferences_written = 1;
      }
      counts.questions_closed = await update(deps.sb, named.flag.id, { status: "resolved", resolved_at: nowIso, resolved_by: RESOLVED_BY, resolution_note: buildResolutionNote(inferenceId, entry as never, batch), recommended_actions: withAnsweredOutcome(named.flag.recommended_actions, { inferenceId, poolHash: String(entry.pool_hash), batch, nowIso }) }, [...LIVE, "resolved"]);
      const target = live.needs.get(ref);
      if (target) counts.search_targets_closed = await update(deps.sb, target.id, { status: "resolved", resolved_at: nowIso, resolved_by: RESOLVED_BY, resolution_note: `the question was answered by inference ${inferenceId} (batch ${batch})` }, LIVE);
      return { ref: `${named.flag.id}|${inferenceId}|${target?.id ?? ""}`, counts };
    }
    const spec = { subject_ref: ref, missing: String(entry.missing), pool_hash: String(entry.pool_hash) };
    await update(deps.sb, named.flag.id, { recommended_actions: withUnanswerableOutcome(named.flag.recommended_actions, { missing: spec.missing, poolHash: spec.pool_hash, batch, nowIso }) }, LIVE);
    counts.outcomes_recorded = 1;
    const existingTarget = live.needs.get(ref);
    if (existingTarget) {
      // One open target per question: a fresh need replaces the stale one in place.
      await update(deps.sb, existingTarget.id, { description: holdingsNeedRow(spec, parsed, batch, nowIso).description, recommended_actions: [needAction(spec, parsed, batch, nowIso)] }, LIVE);
      counts.search_targets_refreshed = 1;
    } else {
      const { error } = await deps.sb.from("integrity_flags").insert(holdingsNeedRow(spec, parsed, batch, nowIso));
      if (error) throw new Error(`holdings-need target not raised: ${error.message}`);
      counts.search_targets_raised = 1;
    }
    return { ref: `${named.flag.id}||`, counts };
  },
  async readBack(deps, _live, written) {
    const ids = written.map((w) => w.ref.split("|")[0] as string);
    const back = new Map((await rowsByIds<NeedFlag & { resolution_note: string | null }>(deps.sb, "integrity_flags", "id, subject_ref, created_by, description, recommended_actions, status, created_at, resolution_note", ids)).map((r) => [r.id, r]));
    const needs = new Map((await loadOpenNeedTargets(deps.sb)).map((r) => [r.subject_ref, r]));
    const bad: string[] = [];
    for (const w of written) {
      const [flagId, inferenceId] = w.ref.split("|") as [string, string];
      const f = back.get(flagId);
      const pool = String(w.entry.pool_hash);
      const ok = w.entry.outcome === "answered"
        ? !!f && f.status === "resolved" && String(f.resolution_note ?? "").includes(inferenceId) && recordedAnswer(f)?.pool_hash === pool && recordedAnswer(f)?.inference_id === inferenceId
        : !!f && f.status !== "resolved" && recordedOutcome(f)?.pool_hash === pool && needOfFlag(needs.get(String(w.entry.subject_ref)))?.need === w.entry.missing;
      if (!ok) bad.push(String(w.entry.subject_ref));
    }
    return bad;
  },
  async downstream(deps, _live, written) {
    const items = [...new Set(written.filter((w) => w.entry.outcome === "answered").map((w) => parseQuestionRef(w.entry.subject_ref)?.itemId).filter((x): x is string => !!x))];
    if (!items.length) return null;
    if (!deps.flushCache) return runResult("partial", {}, ["cache flush owed: no flush is wired in this run"]);
    const f = await deps.flushCache(items.map(itemTag));
    return f.error ? runResult("partial", {}, [`cache flush: ${f.error}`]) : runResult("ok", { cache_flushed: items.length });
  },
};

export const applyQuestionAnswers = (deps: BatchDeps, file: unknown, o: ApplyOpts) => applyEntries(questionAnswersSpec, deps, file, o);

const CHUNK = 25;
/**
 * The export half: every open question, and each answered one whose held pool may have moved, with its bundle under the character budget. A question whose item cannot be cited, whose unanswerable outcome or answer
 * was recorded against the SAME pool, or that is not a `<item>:<surface>:<question>` ref is not exported, and each skip is counted. One exporter: the drain's queue and the bundle file are this.
 */
export function questionExporter(sb: Db, o: { charBudget?: number } = {}) {
  return async ({ limit }: { limit: number }): Promise<BatchExport> => {
    try {
      const found = await loadQuestionFlags(sb);
      const flags = [...found.open, ...found.answered].sort((a, b) => a.subject_ref.localeCompare(b.subject_ref));
      const counts: Record<string, number> = { open_questions: found.open.length, answered_questions_checked: found.answered.length, unparseable: 0, skipped_item_unavailable: 0, skipped_unanswerable_unchanged: 0, skipped_answered_unchanged: 0, listed_unanswered: 0, listed_reasked: 0, listed_reanswer: 0, not_examined_over_limit: 0 };
      const residue: { subject_ref: string; reason: string }[] = [];
      const unavailable: Record<string, number> = {};
      const bundles: Obj[] = [];
      const parsedFlags = flags.flatMap((f) => {
        const parsed = parseQuestionRef(f.subject_ref);
        if (!parsed) {
          counts.unparseable = (counts.unparseable as number) + 1;
          residue.push({ subject_ref: f.subject_ref, reason: "subject_ref is not <item>:<surface>:<question>" });
        }
        return parsed ? [{ flag: f, parsed }] : [];
      });
      for (let i = 0; i < parsedFlags.length; i += CHUNK) {
        if (bundles.length >= limit) {
          counts.not_examined_over_limit = parsedFlags.length - i;
          break;
        }
        const chunk = parsedFlags.slice(i, i + CHUNK);
        const material = await loadQuestionMaterial(sb, chunk.map((c) => c.parsed.itemId));
        for (const { flag, parsed } of chunk) {
          if (bundles.length >= limit) {
            counts.not_examined_over_limit = (counts.not_examined_over_limit as number) + 1;
            continue;
          }
          const ctx = await buildQuestionContext(flag, parsed, material);
          const bump = (k: string) => void (counts[k] = (counts[k] as number) + 1);
          if (ctx.itemUnusable) {
            bump("skipped_item_unavailable");
            unavailable[ctx.itemUnusable] = (unavailable[ctx.itemUnusable] ?? 0) + 1;
            continue;
          }
          const answeredAs = recordedAnswer(flag);
          const outcome = recordedOutcome(flag);
          if (answeredAs) {
            if (answeredAs.pool_hash === ctx.pool_hash) { bump("skipped_answered_unchanged"); continue; }
            bump("listed_reanswer");
          } else if (outcome && outcome.pool_hash === ctx.pool_hash) { bump("skipped_unanswerable_unchanged"); continue; }
          else bump(outcome ? "listed_reasked" : "listed_unanswered");
          bundles.push(buildQuestionBundle(ctx, material, { charBudget: o.charBudget ?? DEFAULT_CHAR_BUDGET }));
        }
      }
      const sum = (k: string) => bundles.reduce((a, b) => a + Number(((b.truncation as Obj)[k] as number) ?? 0), 0);
      return { ok: true, items: bundles, source: { type: "table", table: "integrity_flags" }, residue, summary: { ...counts, questions_exported: bundles.length, skipped_item_unavailable_by_reason: unavailable, connected_cap: MAX_CONNECTED, items_omitted: sum("items_omitted"), claims_omitted: sum("claims_omitted"), forward_events_omitted: sum("forward_events_omitted"), pool_chars_omitted: sum("pool_chars_omitted") } };
    } catch (e) {
      return { ok: false, items: [], error: (e as Error).message };
    }
  };
}
