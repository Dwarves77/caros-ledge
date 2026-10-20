// Ported from old_repo/scripts/turns/question-answers/schema.mjs (lines 1-189)
// The answers validator. An answer from holdings is an INFERENCE record, never a fact (INV-208): CONFIRMED only when every sentence is a quotation of an evidence span that is verbatim in the cited item's held pool,
// otherwise HYPOTHESIS. Cited items are verified, not archived, not Community-only and inside the export's reach; `cited_item_ids` equals the evidence item set; a figure in the answer comes from an evidence span, the
// question or a cited title. An unanswerable entry says what holding would answer the question and nothing else. An answer authored against a stale held pool is refused (INV-207).
import { figureTokens } from "@/core/briefs/theme-brief-contract";
import { assertVerbatim } from "@/core/contracts/verbatim";

import { isObj, nonEmpty, poolHashError, type EntryResult } from "../../kit/session-batch";

const OUTCOMES = ["answered", "unanswerable_from_holdings"] as const;
/** The status tokens an ANSWER may carry. REFUTED is not an answer to a question. */
const ANSWER_STATUS_TOKENS = ["HYPOTHESIS", "CONFIRMED"];
const CEILINGS = { answer: 1500, missing: 600, source_span: 600, evidence_entries: 8 } as const;
/** A span shorter than this is not evidence of anything. */
const MIN_SPAN_CHARS = 20;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const absent = (x: unknown): boolean => x === undefined || x === null || x === "" || (Array.isArray(x) && x.length === 0);
const normalise = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export interface QuestionLive {
  open: boolean;
  answered: boolean;
  questionText: string;
  itemUnusable: string | null;
  pool_hash: string;
  members: Map<string, { title?: string | null; claim_ids: Set<string>; poolText: string }>;
  unusable: Map<string, string>;
}
export interface QaLive { questions: Map<string, QuestionLive>; done(entry: Record<string, unknown>): boolean }

/** The sentences of an answer, closing punctuation and quote marks stripped, blank ones dropped. An abbreviation splits too, which only makes the quotation test finer, never looser. */
function sentencesOf(text: string): string[] {
  return String(text ?? "").split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim().replace(/^[\s"'(\[]+|[\s"')\].!?;:,]+$/g, "")).filter((s) => s.length > 0);
}
/** The CONFIRMED rule: the sentences that are NOT a (whitespace-collapsed, case-folded) substring of some evidence span; empty means CONFIRMED is allowed. A paraphrase is never CONFIRMED however faithful. */
function unquotedSentences(answer: string, spans: readonly string[]): string[] {
  const hay = spans.map(normalise);
  return sentencesOf(answer).filter((sent) => !hay.some((h) => h.includes(normalise(sent))));
}

/** Validate ONE entry: the refusal reasons, or `done` when the work is already recorded. */
export function validateAnswerEntry(entry: unknown, i: number, live: QaLive): EntryResult<{ outcome: string; ref: string }> {
  const where = `entry ${i}`;
  if (!isObj(entry)) return { errors: [`${where}: not an object`] };
  if (!nonEmpty(entry.subject_ref)) return { errors: [`${where}: subject_ref is missing`] };
  if (live.done(entry)) return { errors: [], done: true };
  const tag = `${where} (question ${entry.subject_ref})`;
  const q = live.questions.get(entry.subject_ref);
  if (!q) return { errors: [`${tag}: unknown question (no question flag with this subject_ref)`] };
  if (!q.open) return { errors: [`${tag}: the question is no longer open`] };
  const errs: string[] = [];
  if (q.itemUnusable) errs.push(`${tag}: the question's own item is not citable (${q.itemUnusable}); the question is not answered from it`);
  const stale = poolHashError(tag, entry.pool_hash, q.pool_hash);
  if (stale) errs.push(stale);
  if (!(OUTCOMES as readonly unknown[]).includes(entry.outcome)) return { errors: [...errs, `${tag}: outcome must be one of ${OUTCOMES.join(", ")} (got ${JSON.stringify(entry.outcome)})`] };

  if (entry.outcome === "unanswerable_from_holdings") {
    if (q.answered) errs.push(`${tag}: the question was answered earlier; a changed held pool is re-answered, never marked unanswerable`);
    for (const k of ["answer", "status_token", "confidence", "cited_item_ids", "evidence"]) if (!absent(entry[k])) errs.push(`${tag}: an unanswerable entry carries no ${k} (it says what holding would answer the question, nothing else)`);
    if (!nonEmpty(entry.missing)) errs.push(`${tag}: an unanswerable entry needs "missing": in plain words, what kind of source about what would answer it`);
    else if (entry.missing.length > CEILINGS.missing) errs.push(`${tag}: missing is ${entry.missing.length} characters, ceiling ${CEILINGS.missing}`);
    else if (UUID_RE.test(entry.missing)) errs.push(`${tag}: missing carries an id; say what the missing source is in words`);
    return { errors: errs, plan: { outcome: "unanswerable_from_holdings", ref: entry.subject_ref } };
  }

  if (!absent(entry.missing)) errs.push(`${tag}: an answered entry carries no "missing"`);
  if (!ANSWER_STATUS_TOKENS.includes(String(entry.status_token))) errs.push(`${tag}: status_token must be one of ${ANSWER_STATUS_TOKENS.join(", ")} (got ${JSON.stringify(entry.status_token)})`);
  if (typeof entry.confidence !== "number" || !Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1) errs.push(`${tag}: confidence must be a number from 0 to 1 (got ${JSON.stringify(entry.confidence)})`);
  if (!nonEmpty(entry.answer)) errs.push(`${tag}: an answered entry needs "answer"`);
  else {
    if (entry.answer.length > CEILINGS.answer) errs.push(`${tag}: answer is ${entry.answer.length} characters, ceiling ${CEILINGS.answer}`);
    if (UUID_RE.test(entry.answer)) errs.push(`${tag}: answer carries an id; cite items by title, never by id`);
  }
  const evidence = Array.isArray(entry.evidence) ? (entry.evidence as unknown[]) : null;
  if (!evidence?.length) return { errors: [...errs, `${tag}: an answered entry needs at least one evidence record`] };
  if (evidence.length > CEILINGS.evidence_entries) errs.push(`${tag}: ${evidence.length} evidence records, ceiling ${CEILINGS.evidence_entries}`);
  const spans: string[] = [];
  const evidenceItems = new Set<string>();
  evidence.forEach((ev, ei) => {
    const et = `${tag} evidence[${ei}]`;
    if (!isObj(ev)) return void errs.push(`${et}: not an object`);
    if (!nonEmpty(ev.item_id)) return void errs.push(`${et}: item_id is missing`);
    evidenceItems.add(ev.item_id);
    const why = q.unusable.get(ev.item_id);
    if (why) return void errs.push(`${et}: cited item is not citable (${why})`);
    const member = q.members.get(ev.item_id);
    if (!member) return void errs.push(`${et}: item is neither the question's own item nor an item connected to it in the export`);
    if (!Array.isArray(ev.claim_ids)) errs.push(`${et}: claim_ids must be an array (empty when no grounded claim backs the span)`);
    else for (const id of ev.claim_ids) if (typeof id !== "string" || !member.claim_ids.has(id)) errs.push(`${et}: claim id ${JSON.stringify(id)} is not a grounded claim of the cited item`);
    if (!nonEmpty(ev.source_span)) return void errs.push(`${et}: source_span is missing`);
    if (ev.source_span.length > CEILINGS.source_span) errs.push(`${et}: source_span is ${ev.source_span.length} characters, ceiling ${CEILINGS.source_span}`);
    else if (ev.source_span.trim().length < MIN_SPAN_CHARS) errs.push(`${et}: source_span is under ${MIN_SPAN_CHARS} characters, too short to be evidence`);
    else {
      try {
        assertVerbatim(member.poolText, ev.source_span);
        spans.push(ev.source_span);
      } catch {
        errs.push(`${et}: source_span is not a verbatim substring of the held pool text of the cited item`);
      }
    }
  });
  if (!Array.isArray(entry.cited_item_ids) || entry.cited_item_ids.length === 0) errs.push(`${tag}: cited_item_ids must be a non-empty array`);
  else {
    const cited = new Set(entry.cited_item_ids as string[]);
    if (cited.size !== entry.cited_item_ids.length) errs.push(`${tag}: cited_item_ids has a duplicate`);
    if (!(cited.size === evidenceItems.size && [...cited].every((id) => evidenceItems.has(id)))) errs.push(`${tag}: cited_item_ids must equal the set of evidence item ids`);
  }
  if (nonEmpty(entry.answer)) {
    const allowed = new Set([...figureTokens(spans.join(" ")), ...figureTokens(q.questionText)]);
    for (const id of evidenceItems) for (const tk of figureTokens(q.members.get(id)?.title ?? "")) allowed.add(tk);
    const loose = [...figureTokens(entry.answer)].filter((tk) => !allowed.has(tk));
    if (loose.length) errs.push(`${tag}: answer states ${loose.slice(0, 6).map((t) => JSON.stringify(t)).join(", ")}${loose.length > 6 ? " and more" : ""} that no evidence span, the question or a cited title carries`);
    if (entry.status_token === "CONFIRMED") {
      const bad = unquotedSentences(entry.answer, spans);
      if (bad.length) errs.push(`${tag}: status_token CONFIRMED needs every sentence quoted from an evidence span; ${bad.length} sentence(s) are not, e.g. ${JSON.stringify((bad[0] as string).slice(0, 80))}; use HYPOTHESIS for a paraphrase`);
    }
  }
  return { errors: errs, plan: { outcome: "answered", ref: entry.subject_ref } };
}
