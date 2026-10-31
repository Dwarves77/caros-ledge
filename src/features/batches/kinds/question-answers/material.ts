// Ported from old_repo/scripts/turns/question-answers/data.mjs (lines 1-11)
// Ported from old_repo/scripts/turns/question-answers/data.mjs (lines 26-114)
// Ported from old_repo/scripts/turns/question-answers/data.mjs (lines 143-399)
// Ported from old_repo/scripts/turns/export-questions-for-answers.mjs (lines 19-166)
// The material a question is answered from: the question flags (open, and answered ones whose held pool may have moved), the inference chain of each, the question's item and the items connected to it (ranked, capped, split
// into citable and not), their grounded FACT claims, forward events and held pools, read once for the union. The held pool identity is the pool hash INV-207 binds an answer to. One bundle per question within a character
// budget, every cut counted. A question item may be cited only when verified, not archived and not Community-sourced (ADR-041).
import type { Db } from "@/core/db";
import { heldPoolHash, queryHeldPools, type HeldPoolHit, type PoolCapture } from "@/core/fetch/candidates";
import { CANDIDATE_ORIGIN, evidenceOf, type BasisEntry } from "@/core/flywheel/discover";
import { QUESTION_NAMESPACE } from "@/core/flywheel/flags";
import { ANSWERED_ACTION, FLAG_COLUMNS, OPEN_STATUSES, parseQuestionRef, UNANSWERABLE_ACTION, type NeedFlag, type ParsedQuestionRef } from "@/core/flags/need-targets";
import { usableCaptures, poolHash } from "@/core/grounding";
import { surfaceOf } from "@/core/routing";
import { allRows, rowsByIds } from "@/core/db";

/** The most connected items one question reaches. */
export const MAX_CONNECTED = 8;
const STRUCTURE_SHARE = 0.4;

interface ItemRow { id: string; title: string | null; item_type: string | null; domain: number | null; jurisdiction_iso: string[] | null; summary: string | null; provenance_status: string | null; is_archived: boolean | null; origin_class: string | null; instrument_entity_id: string | null }
interface EdgeRow { source_item_id: string; target_item_id: string; relationship: string | null; origin: string | null; basis: unknown; score: number | null }
interface ClaimRow { id: string; intelligence_item_id: string; claim_kind: string; claim_text: string; source_id: string | null }
interface EventRow { id: string; intelligence_item_id: string; event_date: string; date_precision: string; event_kind: string; obligation_text: string; source_span: string | null; confidence: string | null }
export interface InferenceRow { inference_id: string; trigger_question_ref: string; claim_text: string; supersedes: string | null; computed_at: string }
export interface RecordedAction { action: string; pool_hash?: string; rationale?: string; batch?: string; recorded_at?: string; inference_id?: string }
export interface Edge { other: string; relationship: string | null; origin: string | null; score: number | null; basis: BasisEntry[]; typed: boolean }
export interface Material { items: Map<string, ItemRow>; connected: Map<string, { connected: Edge[]; unusable: Map<string, string>; candidates: number }>; claimsByItem: Map<string, ClaimRow[]>; eventsByItem: Map<string, EventRow[]>; poolsByItem: Map<string, PoolCapture[]> }
export interface QuestionContext {
  flag: NeedFlag; parsed: ParsedQuestionRef; item: ItemRow | null; itemUnusable: string | null; questionText: string; connectedEdges: Edge[]; unusable: Map<string, string>; connectedCandidates: number;
  hits: HeldPoolHit[]; pool_hash: string; members: Map<string, { title: string | null; claim_ids: Set<string>; poolText: string }>;
}

const actionsOf = (flag: Pick<NeedFlag, "recommended_actions"> | null | undefined): RecordedAction[] => (Array.isArray(flag?.recommended_actions) ? (flag?.recommended_actions as RecordedAction[]).filter((a) => a && typeof a === "object") : []);
export const recordedOutcome = (flag: Pick<NeedFlag, "recommended_actions">): RecordedAction | null => actionsOf(flag).find((a) => a.action === UNANSWERABLE_ACTION && typeof a.pool_hash === "string") ?? null;
export const recordedAnswer = (flag: Pick<NeedFlag, "recommended_actions">): RecordedAction | null => actionsOf(flag).find((a) => a.action === ANSWERED_ACTION && typeof a.pool_hash === "string") ?? null;
/** The recommended_actions after recording an answered close-out: an earlier answered or unanswerable element is replaced, the generator's own is kept. */
export const withAnsweredOutcome = (actions: unknown, a: { inferenceId: string; poolHash: string; batch: string; nowIso: string }): unknown[] => [...(Array.isArray(actions) ? actions : []).filter((x) => !(x && (x.action === ANSWERED_ACTION || x.action === UNANSWERABLE_ACTION))), { action: ANSWERED_ACTION, rationale: `answered by inference ${a.inferenceId}`, inference_id: a.inferenceId, pool_hash: a.poolHash, batch: a.batch, recorded_at: a.nowIso }];
/** The recommended_actions after recording an unanswerable outcome (the same replacement rule). */
export const withUnanswerableOutcome = (actions: unknown, a: { missing: string; poolHash: string; batch: string; nowIso: string }): unknown[] => [...(Array.isArray(actions) ? actions : []).filter((x) => !(x && (x.action === ANSWERED_ACTION || x.action === UNANSWERABLE_ACTION))), { action: UNANSWERABLE_ACTION, rationale: a.missing, pool_hash: a.poolHash, batch: a.batch, recorded_at: a.nowIso }];

/** Why an item may not be cited, or null when it may: archived, not verified, or sourced only from Community (ADR-041). */
function itemUnusableReason(item: Pick<ItemRow, "is_archived" | "provenance_status" | "origin_class"> | null | undefined): string | null {
  if (!item) return "item not found";
  if (item.is_archived) return "archived";
  if (item.provenance_status !== "verified") return `not verified (provenance_status ${item.provenance_status ?? "null"})`;
  return item.origin_class === "community" || item.origin_class === "community-corroborated" ? "sourced only from Community (ADR-041)" : null;
}
/** The inference of a ref's chain that no other row supersedes, newest first, or null. */
export function currentInference(rows: readonly InferenceRow[] | undefined): InferenceRow | null {
  const superseded = new Set((rows ?? []).map((r) => r.supersedes).filter(Boolean));
  return [...(rows ?? [])].filter((r) => !superseded.has(r.inference_id)).sort((a, b) => String(b.computed_at).localeCompare(String(a.computed_at)))[0] ?? null;
}
/** The event type the generator recorded in the flag's own rationale, when it did. */
function eventContextOf(flag: Pick<NeedFlag, "recommended_actions">): { event_type: string } | null {
  for (const a of actionsOf(flag)) {
    const m = /event_type=([A-Za-z_]+)/.exec(String(a.rationale ?? ""));
    if (m) return { event_type: m[1] as string };
  }
  return null;
}

/** Question flags: the open ones, and the resolved ones carrying an answered close-out (candidates for a re-answer). */
export async function loadQuestionFlags(sb: Db): Promise<{ open: NeedFlag[]; answered: NeedFlag[] }> {
  const rows = (status: readonly string[]) => allRows<NeedFlag>(sb, "integrity_flags", `${FLAG_COLUMNS}, resolution_note`, { where: (q) => q.like("created_by", `${QUESTION_NAMESPACE}%`).in("status", status) });
  return { open: await rows(OPEN_STATUSES), answered: (await rows(["resolved"])).filter((r) => recordedAnswer(r)) };
}
/** Inference rows already written for the given question refs, keyed by ref. */
export async function loadInferencesByRef(sb: Db, refs: readonly string[]): Promise<Map<string, InferenceRow[]>> {
  const out = new Map<string, InferenceRow[]>();
  if (!refs.length) return out;
  const rows = await rowsByIds<InferenceRow>(sb, "inference_records", "inference_id, trigger_question_ref, claim_text, supersedes, computed_at", refs, "trigger_question_ref", "inference_id");
  for (const r of rows) out.set(r.trigger_question_ref, [...(out.get(r.trigger_question_ref) ?? []), r]);
  return out;
}

const cmpEdge = (a: Edge, b: Edge): number => (a.typed !== b.typed ? (a.typed ? -1 : 1) : (b.score ?? 0) !== (a.score ?? 0) ? (b.score ?? 0) - (a.score ?? 0) : a.other < b.other ? -1 : a.other > b.other ? 1 : 0);
const group = <T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
  return m;
};

/** The material the given question item ids are answered from, read once for the union. */
export async function loadQuestionMaterial(sb: Db, questionItemIds: readonly string[]): Promise<Material> {
  const ids = [...new Set(questionItemIds)].sort();
  const m: Material = { items: new Map(), connected: new Map(), claimsByItem: new Map(), eventsByItem: new Map(), poolsByItem: new Map() };
  if (!ids.length) return m;
  const ITEM_COLUMNS = "id, title, item_type, domain, jurisdiction_iso, summary, provenance_status, is_archived, origin_class, instrument_entity_id";
  for (const it of await rowsByIds<ItemRow>(sb, "intelligence_items", ITEM_COLUMNS, ids)) m.items.set(it.id, it);
  const EDGES = "source_item_id, target_item_id, relationship, origin, basis, score";
  const [out, inn] = [await rowsByIds<EdgeRow>(sb, "item_cross_references", EDGES, ids, "source_item_id"), await rowsByIds<EdgeRow>(sb, "item_cross_references", EDGES, ids, "target_item_id")];
  const candidates = new Map(ids.map((id) => [id, new Map<string, Edge>()]));
  const consider = (own: string, other: string, e: EdgeRow) => {
    if (own === other || !candidates.has(own) || e.origin === CANDIDATE_ORIGIN) return;
    const cand: Edge = { other, relationship: e.relationship ?? null, origin: e.origin ?? null, score: e.score ?? null, basis: evidenceOf(e.basis), typed: !!e.relationship && e.relationship !== "related" };
    const prior = candidates.get(own)?.get(other);
    if (!prior || cmpEdge(cand, prior) < 0) candidates.get(own)?.set(other, cand);
  };
  for (const e of out) consider(e.source_item_id, e.target_item_id, e);
  for (const e of inn) consider(e.target_item_id, e.source_item_id, e);
  const others = [...new Set([...candidates.values()].flatMap((c) => [...c.keys()]))].filter((id) => !m.items.has(id)).sort();
  for (const it of await rowsByIds<ItemRow>(sb, "intelligence_items", ITEM_COLUMNS, others)) m.items.set(it.id, it);
  for (const id of ids) {
    const usable: Edge[] = [];
    const unusable = new Map<string, string>();
    const ranked = [...(candidates.get(id)?.values() ?? [])].sort(cmpEdge);
    for (const c of ranked) {
      const why = itemUnusableReason(m.items.get(c.other));
      if (why) unusable.set(c.other, why);
      else if (usable.length < MAX_CONNECTED) usable.push(c);
    }
    m.connected.set(id, { connected: usable, unusable, candidates: ranked.length });
  }
  const involved = [...new Set([...ids, ...[...m.connected.values()].flatMap((c) => c.connected.map((e) => e.other))])].sort();
  for (const [k, rows] of group((await rowsByIds<ClaimRow>(sb, "section_claim_provenance", "id, intelligence_item_id, claim_kind, claim_text, source_id", involved, "intelligence_item_id")).filter((c) => c.claim_kind === "FACT"), (c) => c.intelligence_item_id)) m.claimsByItem.set(k, rows);
  for (const [k, rows] of group(await rowsByIds<EventRow>(sb, "item_forward_events", "id, intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_span, confidence", involved, "intelligence_item_id"), (e) => e.intelligence_item_id)) m.eventsByItem.set(k, rows);
  const pool = await rowsByIds<{ id: string; intelligence_item_id: string; result_content: string | null; result_url: string | null; result_index: number | null }>(sb, "agent_run_searches", "id, intelligence_item_id, result_content, result_url, result_index", involved, "intelligence_item_id");
  for (const [k, rows] of group(pool, (r) => r.intelligence_item_id)) m.poolsByItem.set(k, usableCaptures(rows.filter((r) => typeof r.result_url === "string").map((r) => ({ id: r.id, url: r.result_url as string, text: r.result_content ?? "", index: r.result_index ?? 0 }))).map((r) => ({ url: r.url, text: r.text })));
  return m;
}

/** One question's context over loaded material: its item, the connected set, the held pool and the live pool identity (the hash an answer is bound to). */
export async function buildQuestionContext(flag: NeedFlag, parsed: ParsedQuestionRef, m: Material): Promise<QuestionContext> {
  const item = m.items.get(parsed.itemId) ?? null;
  const conn = m.connected.get(parsed.itemId) ?? { connected: [], unusable: new Map<string, string>(), candidates: 0 };
  const hits = await queryHeldPools({ itemId: parsed.itemId }, { readConnectedItemIds: () => conn.connected.map((c) => c.other), readPools: (idList) => new Map(idList.map((id) => [id, m.poolsByItem.get(id) ?? []])), hashSourcePool: poolHash });
  const members = new Map<string, { title: string | null; claim_ids: Set<string>; poolText: string }>();
  for (const id of [parsed.itemId, ...conn.connected.map((c) => c.other)]) members.set(id, { title: m.items.get(id)?.title ?? null, claim_ids: new Set((m.claimsByItem.get(id) ?? []).map((c) => c.id)), poolText: (hits.find((h) => h.item_id === id)?.pool ?? []).map((c) => c.text).join("\u0000") });
  return { flag, parsed, item, itemUnusable: itemUnusableReason(item), questionText: flag.description ?? "", connectedEdges: conn.connected, unusable: conn.unusable, connectedCandidates: conn.candidates, hits, pool_hash: heldPoolHash(hits, poolHash), members };
}

/** The question contexts for refs the batch names (read in chunks: held pools are stored whole). */
export async function questionContexts(sb: Db, flags: ReadonlyMap<string, NeedFlag>, chunk = 25): Promise<Map<string, QuestionContext>> {
  const refs = [...flags.keys()].filter((r) => parseQuestionRef(r));
  const out = new Map<string, QuestionContext>();
  for (let i = 0; i < refs.length; i += chunk) {
    const slice = refs.slice(i, i + chunk);
    const material = await loadQuestionMaterial(sb, slice.map((r) => (parseQuestionRef(r) as ParsedQuestionRef).itemId));
    for (const ref of slice) out.set(ref, await buildQuestionContext(flags.get(ref) as NeedFlag, parseQuestionRef(ref) as ParsedQuestionRef, material));
  }
  return out;
}

const size = (x: unknown): number => JSON.stringify(x).length;
/** One question's export bundle within a character budget: structure (records, claims, events) takes up to 40 percent, the held pool text shares the rest (half to the question's own item), every cut counted in `truncation`. */
export function buildQuestionBundle(ctx: QuestionContext, m: Material, opts: { charBudget: number }) {
  const { flag, parsed } = ctx;
  const answered = recordedAnswer(flag);
  const outcome = recordedOutcome(flag);
  const head = {
    subject_ref: flag.subject_ref, pool_hash: ctx.pool_hash, item_id: parsed.itemId, surface: parsed.surface, product_question: parsed.productQuestion, question: flag.description ?? "", event_context: eventContextOf(flag),
    needs: answered ? "reanswer_after_new_holdings" : outcome ? "reasked_after_new_holdings" : "unanswered",
    prior_outcome: outcome ? { outcome: UNANSWERABLE_ACTION, missing: outcome.rationale ?? null, batch: outcome.batch ?? null, recorded_at: outcome.recorded_at ?? null } : null,
    prior_inference_id: answered?.inference_id ?? null,
  };
  let used = size(head);
  const cap = Math.floor(opts.charBudget * STRUCTURE_SHARE);
  const records: { item_id: string; relation: string; claims: unknown[]; forward_events: unknown[]; pool: { url: string; text: string; chars_total: number; chars_included: number }[]; [k: string]: unknown }[] = [];
  const omitted: { item_id: string; title: string | null }[] = [];
  const cut = { claimsTotal: 0, claimsOmitted: 0, eventsTotal: 0, eventsOmitted: 0 };
  for (const o of [{ id: parsed.itemId, relation: "self", edge: null as Edge | null }, ...ctx.connectedEdges.map((c) => ({ id: c.other, relation: "connected", edge: c as Edge | null }))]) {
    const it = m.items.get(o.id);
    const claims = (m.claimsByItem.get(o.id) ?? []).map((c) => ({ claim_id: c.id, kind: c.claim_kind, claim_text: c.claim_text, source_id: c.source_id ?? null }));
    const events = (m.eventsByItem.get(o.id) ?? []).map((e) => ({ event_id: e.id, event_date: e.event_date, date_precision: e.date_precision, event_kind: e.event_kind, obligation_text: e.obligation_text, source_span: e.source_span, confidence: e.confidence }));
    cut.claimsTotal += claims.length;
    cut.eventsTotal += events.length;
    const rec = {
      item_id: o.id, relation: o.relation, title: it?.title ?? null, item_type: it?.item_type ?? null, surface: it ? surfaceOf(it.item_type, it.domain) : "uncategorized", jurisdictions: it?.jurisdiction_iso ?? [], summary: it?.summary ?? null,
      edge: o.edge ? { relationship: o.edge.relationship, origin: o.edge.origin, score: o.edge.score, basis_signals: o.edge.basis.map((b) => ({ signal: b?.signal ?? null, detail: b?.detail ?? null })) } : null,
      claims: [] as unknown[], forward_events: [] as unknown[], item_pool_hash: ctx.hits.find((h) => h.item_id === o.id)?.item_pool_hash ?? null, pool: [] as { url: string; text: string; chars_total: number; chars_included: number }[],
    };
    if (used + size(rec) > cap && o.relation !== "self") {
      omitted.push({ item_id: o.id, title: it?.title ?? null });
      cut.claimsOmitted += claims.length;
      cut.eventsOmitted += events.length;
      continue;
    }
    used += size(rec);
    for (const ev of events) {
      if (used + size(ev) > cap) cut.eventsOmitted += 1;
      else {
        rec.forward_events.push(ev);
        used += size(ev);
      }
    }
    for (const c of claims) {
      if (used + size(c) > cap) cut.claimsOmitted += 1;
      else {
        rec.claims.push(c);
        used += size(c);
      }
    }
    records.push(rec);
  }
  const remaining = Math.max(0, opts.charBudget - used);
  const connectedCount = records.filter((r) => r.relation === "connected").length;
  const selfShare = connectedCount ? Math.floor(remaining / 2) : remaining;
  const connShare = connectedCount ? Math.floor((remaining - selfShare) / connectedCount) : 0;
  let poolTotal = 0;
  let poolIncluded = 0;
  for (const rec of records) {
    let left = rec.relation === "self" ? selfShare : connShare;
    for (const c of ctx.hits.find((h) => h.item_id === rec.item_id)?.pool ?? []) {
      const take = Math.min(c.text.length, left);
      rec.pool.push({ url: c.url, text: c.text.slice(0, take), chars_total: c.text.length, chars_included: take });
      poolTotal += c.text.length;
      poolIncluded += take;
      left -= take;
      used += take;
    }
  }
  for (const o of omitted) for (const c of ctx.hits.find((h) => h.item_id === o.item_id)?.pool ?? []) poolTotal += c.text.length;
  return {
    ...head, items: records,
    truncation: { char_budget: opts.charBudget, chars_used: used, connected_cap: MAX_CONNECTED, connected_candidates: ctx.connectedCandidates, connected_not_citable: ctx.unusable.size, items_included: records.length, items_omitted: omitted.length, omitted_items: omitted, claims_total: cut.claimsTotal, claims_omitted: cut.claimsOmitted, forward_events_total: cut.eventsTotal, forward_events_omitted: cut.eventsOmitted, pool_chars_total: poolTotal, pool_chars_included: poolIncluded, pool_chars_omitted: poolTotal - poolIncluded },
  };
}
