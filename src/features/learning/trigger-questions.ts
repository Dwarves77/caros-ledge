// Ported from old_repo/src/lib/learning/trigger-questions.mjs (lines 1-198)
// Ported from old_repo/src/lib/learning/constants.mjs (lines 1-67)
// Trigger questions (ADR-036 decision 1, $0 only): for a verified item whose domain routes to a surface, four product questions become four open integrity_flags rows under the
// `question:` namespace, deduplicated in the batch and against open flags on (subject_ref, created_by). They are answered from holdings by a session batch; nothing here
// calls a model, a fetch or a priced request (INV-247).
import { buildSubjectRef, createdBy, QUESTION_NAMESPACE } from "@/core/flywheel/flags";
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { MARKET_INTEL_DOMAINS, OPERATIONS_DOMAINS, REGULATIONS_DOMAINS, RESEARCH_DOMAINS } from "@/core/shared/domains";
import { runResult, type RunResult } from "@/core/intake/result";

const QUESTION_ACQUISITION = "holdings-session-batch";
const PRODUCT_QUESTIONS = Object.freeze(["what", "affects_me", "comply", "invest_wait_avoid"] as const);
export const TRIGGER_EVENT_TYPES = Object.freeze(["value_revised", "obligation_amended", "signpost_fired", "factor_superseded", "confidence_decayed", "source_frozen", "identity_revised"] as const);
export type ProductQuestion = (typeof PRODUCT_QUESTIONS)[number];
const MINTED_OR_TOUCHED = "item_minted_or_touched";

export interface QuestionItem { id: string; title?: string | null; domain?: number | null; item_type?: string | null; jurisdiction_iso?: string[] | string | null }
export interface TriggerQuestion { itemId: string; surface: string; productQuestion: ProductQuestion; eventType: string; eventId: string | number | null; questionText: string; subjectRef: string; createdBy: string }

/** The surface a domain routes to; a domain with none (5, null) routes to nothing, so no question is generated for it. */
function surfacesForDomain(domain: number | null | undefined): string[] {
  const d = domain as never;
  return REGULATIONS_DOMAINS.has(d) ? ["regulations"] : MARKET_INTEL_DOMAINS.has(d) ? ["market_intel"] : OPERATIONS_DOMAINS.has(d) ? ["operations"] : RESEARCH_DOMAINS.has(d) ? ["research"] : [];
}

type Ctx = { item: QuestionItem; surface: string; change: string | null };
const t = (i: QuestionItem) => i.title ?? "this item";
const BUILDERS: Record<ProductQuestion, (c: Ctx) => string> = {
  what: ({ item, change }) => (change ? `What changed: ${change}. What does that mean for "${t(item)}"?` : `What changed: ${t(item)}?`),
  affects_me: ({ item, surface, change }) => `${change ? `Following this change (${change}), does` : "Does"} "${t(item)}" apply to any portfolio holder scoped to its jurisdiction or corridor on ${surface}?`,
  comply: ({ item, change }) => `${change ? `Following this change (${change}), what` : "What"} must a reader do in response to "${t(item)}", and by when?`,
  invest_wait_avoid: ({ item, change }) => `Given "${t(item)}"${change ? ` and this change (${change})` : ""}, should a reader act now, wait for corroboration, or take no action?`,
};

/** Four questions per routed surface for an item. */
export function generateTriggerQuestions(item: QuestionItem | null | undefined, o: { eventType?: string; eventId?: string | number | null; change?: string | null } = {}): TriggerQuestion[] {
  if (!item?.id) return [];
  const out: TriggerQuestion[] = [];
  for (const surface of surfacesForDomain(item.domain)) {
    for (const pq of PRODUCT_QUESTIONS) {
      out.push({ itemId: item.id, surface, productQuestion: pq, eventType: o.eventType ?? MINTED_OR_TOUCHED, eventId: o.eventId ?? null, questionText: BUILDERS[pq]({ item, surface, change: o.change ?? null }), subjectRef: buildSubjectRef(item.id, surface, pq), createdBy: createdBy(QUESTION_NAMESPACE, pq) });
    }
  }
  return out;
}

/** The integrity_flags row of a question: an open coverage gap whose action is "answer from holdings", never a fetch or a priced request. */
function triggerQuestionFlagRow(q: TriggerQuestion) {
  return {
    category: "coverage_gap", subject_type: "item", subject_ref: q.subjectRef, status: "open", created_by: q.createdBy, description: q.questionText.slice(0, 480),
    recommended_actions: [{ action: "answer-seeking", rationale: `product_question=${q.productQuestion} surface=${q.surface} event_type=${q.eventType}${q.eventId != null ? ` event_id=${q.eventId}` : ""} - answered from holdings by a session batch, retrieval-first against held pools; a residual becomes a source search target (ADR-044 decisions 1 and 2, ${QUESTION_ACQUISITION}), never a fetch or a priced request.` }],
  };
}

export interface QuestionDeps { sb: Db; now(): Date }
/**
 * The question flag for (item, subjectRef), or null when that question is no longer generated: the LearningDeps member the propagation recompute reopens a question through.
 */
export function questionFlagRow(item: QuestionItem, subjectRef: string) {
  const q = generateTriggerQuestions(item).find((x) => x.subjectRef === subjectRef);
  return q ? triggerQuestionFlagRow(q) : null;
}

/** Write the questions: dedup within the batch, then against OPEN flags on (subject_ref, created_by); dry counts and writes nothing. A failed read or insert fails the run. */
export async function writeQuestions(deps: QuestionDeps, input: { dry?: boolean; questions: readonly TriggerQuestion[]; itemsConsidered?: number; step?: string }): Promise<RunResult> {
  const counts: Record<string, number> = { items_considered: input.itemsConsidered ?? 0, questions_generated: input.questions.length, deduped_in_batch: 0, already_open: 0, new: 0, written: 0 };
  if (!input.questions.length) return runResult("ok", counts, ["0 questions generated (no item routed to a surface this batch), nothing to write."]);
  const key = (q: { subjectRef: string; createdBy: string }) => `${q.subjectRef}\u0000${q.createdBy}`;
  const unique = [...new Map(input.questions.map((q) => [key(q), q])).values()];
  counts.deduped_in_batch = input.questions.length - unique.length;
  let open: Array<{ subject_ref: string; created_by: string }>;
  try {
    open = await fetchAllRows<{ subject_ref: string; created_by: string }>((a, b) => deps.sb.from("integrity_flags").select("subject_ref, created_by").eq("status", "open").like("created_by", `${QUESTION_NAMESPACE}%`).order("id", { ascending: true }).range(a, b) as never, { cap: 500_000 });
  } catch (e) {
    return runResult("failed", counts, [`reading open question flags failed: ${(e as Error).message}`]);
  }
  const have = new Set(open.map((r) => `${r.subject_ref}\u0000${r.created_by}`));
  const fresh = unique.filter((q) => !have.has(key(q)));
  counts.already_open = unique.length - fresh.length;
  counts.new = fresh.length;
  if (input.dry !== false || !fresh.length) return runResult("ok", counts, [input.dry !== false ? `dry run: would insert ${fresh.length} new question flag(s), skip ${counts.already_open} already open` : "nothing new to insert (every generated question already has an open flag)"]);
  const { error } = await deps.sb.from("integrity_flags").insert(fresh.map(triggerQuestionFlagRow) as never);
  if (error) return runResult("failed", counts, [`inserting question flags failed: ${error.message}`]);
  counts.written = fresh.length;
  return runResult("ok", counts);
}

/** Mint-time questions for a batch of verified items. */
export const triggerQuestionsForItem = (deps: QuestionDeps, input: { dry?: boolean; items: readonly QuestionItem[] }): Promise<RunResult> =>
  writeQuestions(deps, { dry: input.dry ?? true, questions: input.items.flatMap((i) => generateTriggerQuestions(i)), itemsConsidered: input.items.length, step: "trigger-questions" });
