// Ported from old_repo/src/lib/propagation/methods/infer-from-question.ts (lines 148-289)
// Re-opening the question an inference answered once the inference was recomputed against moved holdings (ADR-044: the learning loop has no gate,
// the recomputed answer simply asks again). The question generator is the learning slice's (P2-07); it arrives through `LearningDeps`.
import type { Db } from "@/core/db";

export interface QuestionFlagRow {
  subject_ref: string;
  created_by: string;
  [k: string]: unknown;
}
export interface ItemForQuestions {
  id: string;
  title?: string | null;
  domain?: number | null;
  item_type?: string | null;
  jurisdiction_iso?: string[] | string | null;
}
/** What the learning slice supplies: the flag row the question for (item, subjectRef) would be, or null when it is no longer generated. */
export interface LearningDeps {
  questionFlagRow(item: ItemForQuestions, subjectRef: string): QuestionFlagRow | null;
}

/** `<item>:<surface>:<question>` to the item id; null for any other shape. */
export function itemIdOfQuestionRef(subjectRef: string): string | null {
  const parts = String(subjectRef ?? "").split(":");
  return parts.length === 3 && parts[0] ? parts[0] : null;
}

/** Re-open one question as an open flag, once: a missing ref, item or generated question, or an already-open flag, is a reported no-op. Reads and the insert throw on error. */
export async function reopenQuestionForRecompute(sb: Db, learning: LearningDeps, subjectRef: string | null | undefined): Promise<{ reopened: boolean; reason: string }> {
  if (!subjectRef) return { reopened: false, reason: "the inference carries no trigger_question_ref" };
  const itemId = itemIdOfQuestionRef(subjectRef);
  if (!itemId) return { reopened: false, reason: `trigger_question_ref ${JSON.stringify(subjectRef)} is not an <item>:<surface>:<question> reference` };
  const itemRes = await sb.from("intelligence_items").select("id,title,domain,item_type,jurisdiction_iso").eq("id", itemId).maybeSingle();
  if (itemRes.error) throw new Error(`reopen question: reading item ${itemId} failed: ${itemRes.error.message}`);
  if (!itemRes.data) return { reopened: false, reason: "the question's item no longer exists" };
  const row = learning.questionFlagRow(itemRes.data as ItemForQuestions, subjectRef);
  if (!row) return { reopened: false, reason: "the question is no longer generated for this item" };
  const open = await sb.from("integrity_flags").select("id").eq("subject_ref", row.subject_ref).eq("created_by", row.created_by).eq("status", "open").limit(1);
  if (open.error) throw new Error(`reopen question: reading open flags failed: ${open.error.message}`);
  if ((open.data ?? []).length) return { reopened: false, reason: "an open flag for this question already exists" };
  const ins = await sb.from("integrity_flags").insert(row);
  if (ins.error) throw new Error(`reopen question: inserting the flag failed: ${ins.error.message}`);
  return { reopened: true, reason: "re-opened: the recomputed answer rests on moved holdings" };
}

/** The `reopenQuestion` the drain takes, bound to a client and the learning slice. */
export const reopener = (sb: Db, learning: LearningDeps) => (subjectRef: string) => reopenQuestionForRecompute(sb, learning, subjectRef);
