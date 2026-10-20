// Ported from old_repo/src/lib/detail/inference-view.mjs (lines 1-169)
// Ported from old_repo/src/lib/supabase-server.ts (lines 4372-4393)
// What a customer sees of the inference records (INV-272, ADR-039(a), ADR-044 decision 3): only the allowlisted method, only the current row (no successor), only a claim whose every
// shown citation is an item the reader can open, at most five. Read per request, never cached with the item bundle, on the caller's own client.
import type { Db } from "@/core/db";
import { fetchAllByIdChunks } from "@/core/db";
import { detailHref } from "@/core/lists";

const CUSTOMER_INFERENCE_METHOD_IDS: readonly string[] = ["infer-from-question"];
const INFERENCE_READ_CAP = 20;
const MAX_VISIBLE_INFERENCES = 5;
/** The four product questions in the words a customer reads, keyed by the token a trigger-question ref ends in. */
const PRODUCT_QUESTION_WORDS: Readonly<Record<string, string>> = {
  what: "What changed?",
  affects_me: "Does this apply to me?",
  comply: "What must be done in response, and by when?",
  invest_wait_avoid: "Act now, wait, or take no action?",
};

export interface InferenceRow {
  inference_id: string;
  claim_text: string;
  status_token: string;
  confidence: number | string | null;
  cited_item_ids: string[] | null;
  origin_class: string | null;
  trigger_question_ref: string | null;
  method_id: string | null;
  admissibility: string | null;
  computed_at: string | null;
  supersedes?: string | null;
}
export interface InferenceClaimView {
  id: string;
  claimText: string;
  statusToken: string;
  confidence: number;
  citedItemIds: string[];
  originClass: string | null;
  questionText: string | null;
  computedAt: string | null;
}
export interface InferenceView {
  claims: InferenceClaimView[];
  titles: Record<string, string>;
  hrefs: Record<string, string>;
}

function questionInWords(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref.trim()) return null;
  const token = ref.trim().split(":").pop() ?? "";
  return PRODUCT_QUESTION_WORDS[token] ?? null;
}
const isCustomerInferenceMethod = (methodId: unknown): boolean => typeof methodId === "string" && CUSTOMER_INFERENCE_METHOD_IDS.includes(methodId);

/** Rows to views: current, admissible, allowlisted, cited, newest first, capped. */
function selectCurrentInferences(rows: readonly InferenceRow[] | null | undefined, supersededIds: ReadonlySet<string> = new Set()): InferenceClaimView[] {
  const out: InferenceClaimView[] = [];
  for (const r of rows ?? []) {
    if (!r || typeof r.inference_id !== "string" || typeof r.claim_text !== "string" || !r.claim_text.trim()) continue;
    if (r.admissibility !== "current" || supersededIds.has(r.inference_id) || !isCustomerInferenceMethod(r.method_id) || !Array.isArray(r.cited_item_ids)) continue;
    out.push({
      id: r.inference_id,
      claimText: r.claim_text.trim(),
      statusToken: r.status_token,
      confidence: Number(r.confidence),
      citedItemIds: r.cited_item_ids.filter((x): x is string => typeof x === "string"),
      originClass: r.origin_class,
      questionText: questionInWords(r.trigger_question_ref),
      computedAt: typeof r.computed_at === "string" ? r.computed_at : null,
    });
  }
  out.sort((a, b) => (b.computedAt ?? "").localeCompare(a.computedAt ?? "") || (a.id < b.id ? -1 : 1));
  return out.slice(0, INFERENCE_READ_CAP);
}

/** A claim keeps only the citations the reader can open (a title is known), and is dropped when none remain. */
function restrictToVisibleCitations(views: readonly InferenceClaimView[], titles: Record<string, string>): InferenceClaimView[] {
  return views.map((v) => ({ ...v, citedItemIds: v.citedItemIds.filter((id) => typeof titles[id] === "string" && titles[id].trim()) })).filter((v) => v.citedItemIds.length > 0);
}
export const pickVisibleInferences = <T>(views: readonly T[] | null | undefined, isAdmissible: (v: T) => boolean): T[] => (views ?? []).filter(isAdmissible).slice(0, MAX_VISIBLE_INFERENCES);

/**
 * The inferences that cite an item, as the customer may read them. Null is "nothing to show" ONLY for a successful read; a failed read throws (the page says so with Retry, INV-263).
 * The cited items are read through the reader's client, so an archived or unverified item is not a visible citation.
 */
export async function readCustomerInferences(db: Db, itemUuid: string): Promise<InferenceView | null> {
  const { data, error } = await db
    .from("inference_records")
    .select("inference_id, claim_text, status_token, confidence, cited_item_ids, origin_class, trigger_question_ref, method_id, admissibility, computed_at")
    .contains("cited_item_ids", [itemUuid])
    .eq("admissibility", "current")
    .in("method_id", [...CUSTOMER_INFERENCE_METHOD_IDS])
    .order("computed_at", { ascending: false })
    .order("inference_id", { ascending: true })
    .limit(INFERENCE_READ_CAP);
  if (error) throw new Error(`inference_records read failed: ${error.message}`);
  const rows = (data ?? []) as unknown as InferenceRow[];
  if (rows.length === 0) return null;
  const successors = await db.from("inference_records").select("supersedes").in("supersedes", rows.map((r) => r.inference_id));
  if (successors.error) throw new Error(`inference_records supersedes read failed: ${successors.error.message}`);
  const claims = selectCurrentInferences(rows, new Set(((successors.data ?? []) as Array<{ supersedes: string }>).map((r) => r.supersedes)));
  if (claims.length === 0) return null;
  const cited = await fetchAllByIdChunks(
    claims.flatMap((c) => c.citedItemIds),
    async (slice) => {
      const r = await db.from("intelligence_items").select("id, legacy_id, title, item_type, domain").eq("is_archived", false).eq("provenance_status", "verified").in("id", slice);
      if (r.error) throw new Error(`cited items read failed: ${r.error.message}`);
      return (r.data ?? []) as Array<{ id: string; legacy_id: string | null; title: string; item_type: string | null; domain: number | null }>;
    },
    { manyPerId: true },
  );
  const titles = Object.fromEntries(cited.map((c) => [c.id, c.title]));
  const hrefs = Object.fromEntries(cited.map((c) => [c.id, detailHref({ id: c.legacy_id || c.id, type: c.item_type, domain: c.domain })]));
  const visible = restrictToVisibleCitations(claims, titles);
  return visible.length > 0 ? { claims: visible, titles, hrefs } : null;
}
