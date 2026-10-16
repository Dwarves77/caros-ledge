// Ported from old_repo/scripts/turns/question-answers/data.mjs (lines 12-24)
// Ported from old_repo/scripts/turns/question-answers/data.mjs (lines 115-142)
// The need targets: a question that holdings cannot answer becomes ONE open holdings-need flag (the research walker reads it as a search input), and a term need has the same shape. One reader for both namespaces and
// the structured need of a flag. The namespaces and the action name are the flag grammar's (core/flywheel/flags); nothing here restates them.
import type { Db } from "@/core/db";
import { fetchAllRows } from "@/core/db";
import { createdBy, HOLDINGS_NEED_ACTION, HOLDINGS_NEED_NAMESPACE, TERM_NEED_NAMESPACE } from "@/core/flywheel/flags";

/** The recommended_actions action that records "the holdings cannot answer this" on a question flag. */
export const UNANSWERABLE_ACTION = "unanswerable_from_holdings";
/** The recommended_actions action that records an answered question's close-out (the pool it was answered against). */
export const ANSWERED_ACTION = "answered_from_holdings";
export const OPEN_STATUSES = ["open", "in_review"] as const;
export const FLAG_COLUMNS = "id, subject_ref, created_by, description, recommended_actions, status, created_at";

export interface NeedFlag { id: string; subject_ref: string; created_by: string; description: string | null; recommended_actions: unknown; status: string; created_at: string | null }
export interface NeedAction { action: string; need?: string; item_id?: string | null; surface?: string | null; product_question?: string | null; kind?: string | null; [k: string]: unknown }
export interface ParsedQuestionRef { itemId: string; surface: string; productQuestion: string }
export interface StructuredNeed { subject_ref: string; need: string; item_id: string | null; surface: string | null; product_question: string | null; namespace?: "term-need"; kind?: string }

const REF_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([a-z_]+):([a-z_]+)$/i;
/** Parse a question subject_ref (`<item id>:<surface>:<product question>`); null when it is not one. */
export function parseQuestionRef(subjectRef: unknown): ParsedQuestionRef | null {
  const m = REF_RE.exec(String(subjectRef ?? ""));
  return m ? { itemId: m[1] as string, surface: m[2] as string, productQuestion: m[3] as string } : null;
}

const actionsOf = (flag: { recommended_actions?: unknown } | null | undefined): NeedAction[] => (Array.isArray(flag?.recommended_actions) ? (flag?.recommended_actions as NeedAction[]).filter((a) => a && typeof a === "object") : []);

/** The structured need of a holdings-need or term-need target flag, or null when it carries none. */
export function needOfFlag(flag: Pick<NeedFlag, "subject_ref" | "created_by" | "recommended_actions"> | null | undefined): StructuredNeed | null {
  const a = actionsOf(flag).find((x) => x.action === HOLDINGS_NEED_ACTION && typeof x.need === "string" && x.need.trim());
  if (!a || !flag) return null;
  const base = { subject_ref: flag.subject_ref, need: a.need as string, item_id: a.item_id ?? null, surface: a.surface ?? null, product_question: a.product_question ?? null };
  return typeof flag.created_by === "string" && flag.created_by.startsWith(TERM_NEED_NAMESPACE) ? { ...base, namespace: "term-need", kind: a.kind ?? flag.created_by.slice(TERM_NEED_NAMESPACE.length) } : base;
}

/** The find-source action element of a holdings-need target. */
export const needAction = (entry: { subject_ref: string; missing: string; pool_hash: string }, parsed: ParsedQuestionRef, batch: string, nowIso: string): NeedAction => ({
  action: HOLDINGS_NEED_ACTION, need: entry.missing, item_id: parsed.itemId, surface: parsed.surface, product_question: parsed.productQuestion, pool_hash: entry.pool_hash, batch, recorded_at: nowIso,
  rationale: `held source text cannot answer ${entry.subject_ref}; a source stating the need in words is wanted`,
});

/** The holdings-need target for an unanswerable question: ONE open row per question subject_ref, carrying the need in words and its structured context. */
export const holdingsNeedRow = (entry: { subject_ref: string; missing: string; pool_hash: string }, parsed: ParsedQuestionRef, batch: string, nowIso: string) => ({
  category: "coverage_gap", subject_type: "item", subject_ref: entry.subject_ref, status: "open", created_by: createdBy(HOLDINGS_NEED_NAMESPACE, parsed.productQuestion),
  description: `Holdings need: ${entry.missing}`.slice(0, 480), recommended_actions: [needAction(entry, parsed, batch, nowIso)],
});

/** Every open need target: the holdings-need targets (what the answer apply step closes) and, with `includeTermNeeds`, the term-need targets too (what the research walker searches). A read error throws. */
export async function loadOpenNeedTargets(sb: Db, opts: { includeTermNeeds?: boolean } = {}): Promise<NeedFlag[]> {
  const namespaces = opts.includeTermNeeds ? [HOLDINGS_NEED_NAMESPACE, TERM_NEED_NAMESPACE] : [HOLDINGS_NEED_NAMESPACE];
  const out: NeedFlag[] = [];
  for (const ns of namespaces) out.push(...(await fetchAllRows<NeedFlag>((from, to) => sb.from("integrity_flags").select(FLAG_COLUMNS).like("created_by", `${ns}%`).in("status", [...OPEN_STATUSES]).order("id", { ascending: true }).range(from, to) as never, { cap: 100_000 })));
  return out;
}
