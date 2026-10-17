// Ported from old_repo/scripts/turns/apply-question-answers.mjs (lines 39-120)
// Ported from old_repo/src/app/api/ask/route.ts (lines 591-626)
// The free answer path (P2-08b): a question is an open flag per item, surface and product question; a session batch answers it with an INFERENCE record. The Assistant reads those records for the items it
// retrieved and shows each as an inference, with its status token, its confidence and the items it cites. Nothing is generated here and nothing is sent to a model.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import { rowsByIds } from "@/core/db/reads";
import { detailHref } from "@/core/lists";
import type { SuppressedClaim } from "@/features/corrections";
import { generateTriggerQuestions } from "@/features/learning";

import type { AskAnswer } from "../types";

interface InferenceRow {
  inference_id: string;
  trigger_question_ref: string;
  claim_text: string;
  status_token: string;
  confidence: number | null;
  cited_item_ids: string[] | null;
  supersedes: string | null;
  computed_at: string;
}
export interface HitRef {
  id: string;
  title: string;
  item_type: string | null;
  domain: number | null;
}

/** The answers on record for the retrieved items. `service` reads the platform-owned inference table; `db` (the caller's client) resolves the cited items under the customer read gate. An answer that quotes a suppressed claim is withheld. */
export async function readAnswers(service: Db, db: Db, hits: readonly HitRef[], suppressed: readonly SuppressedClaim[]): Promise<AskAnswer[]> {
  const asked = hits.flatMap((h) => generateTriggerQuestions({ id: h.id, title: h.title, domain: h.domain, item_type: h.item_type }).map((q) => ({ hit: h, q })));
  if (asked.length === 0) return [];
  const rows = (await rowsByIds<InferenceRow>(service, "inference_records", "inference_id, trigger_question_ref, claim_text, status_token, confidence, cited_item_ids, supersedes, computed_at, admissibility", asked.map((a) => a.q.subjectRef), "trigger_question_ref", "inference_id")).filter((r) => (r as { admissibility?: string }).admissibility !== "stale");
  const superseded = new Set(rows.map((r) => r.supersedes).filter(Boolean));
  const current = new Map<string, InferenceRow>();
  for (const r of rows.filter((x) => !superseded.has(x.inference_id))) if (!current.has(r.trigger_question_ref) || r.computed_at > (current.get(r.trigger_question_ref) as InferenceRow).computed_at) current.set(r.trigger_question_ref, r);
  const kept = asked.flatMap((a) => {
    const r = current.get(a.q.subjectRef);
    return r && !suppressed.some((c) => c.claim_text && r.claim_text.includes(c.claim_text)) ? [{ ...a, r }] : [];
  });
  const citedIds = [...new Set(kept.flatMap((k) => k.r.cited_item_ids ?? []))];
  const cited = new Map(
    (
      await fetchAllByIdChunks(citedIds, async (slice) => {
        const { data, error } = await db.from("intelligence_items").select("id, title, item_type, domain").eq("provenance_status", "verified").eq("is_archived", false).in("id", slice);
        if (error) throw new Error(`cited items read failed: ${error.message}`);
        return (data ?? []) as { id: string; title: string; item_type: string | null; domain: number | null }[];
      })
    ).map((i) => [i.id, { id: i.id, title: i.title, href: detailHref({ id: i.id, type: i.item_type, domain: i.domain }) }]),
  );
  return kept.map(({ hit, q, r }) => ({ itemId: hit.id, itemTitle: hit.title, question: q.questionText, text: r.claim_text, statusToken: r.status_token, confidence: r.confidence, cited: (r.cited_item_ids ?? []).flatMap((id) => cited.get(id) ?? []), computedAt: r.computed_at }));
}
