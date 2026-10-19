// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 2029-2225)
// The honest strip, opt-in: a figure no source in reach can prove is removed from the full brief, as its whole sentence, or, when the sentence carries another live figure,
// as the one isolable middle clause (the first and last clause are never guessed at). The plan is ACCEPTED only when Gate A then finds no orphan; otherwise nothing changes.
// The previous text comes back in the result (`previous`) so the strip is reversible; it is not assembled into a SQL string.
import { scanGateA } from "@/core/grounding";

const BOUNDARY = /(?<=[.!?])\s+(?=[A-Z0-9])|\n+/g;
const CLAUSE = /,\s+|;\s+/g;
export interface Span { start: number; end: number }

function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    spans.push({ start: cursor, end: m.index });
    cursor = m.index + m[0].length;
  }
  spans.push({ start: cursor, end: text.length });
  return spans;
}
function removeSpan(text: string, spans: Span[], i: number): string {
  const sp = spans[i];
  if (!sp) return text;
  const next = spans[i + 1];
  if (next) return text.slice(0, sp.start) + text.slice(next.start);
  const prev = spans[i - 1];
  return text.slice(0, prev ? prev.end : sp.start) + text.slice(sp.end);
}
/** Remove the middle clause carrying the token; null when the token sits in the first or last clause or the sentence has fewer than three clauses. */
export function stripClause(sentence: string, token: string): { rewritten: string; removed: string } | null {
  const at = sentence.toLowerCase().indexOf(token.toLowerCase());
  if (at === -1) return null;
  const parts: string[] = [];
  const seps: string[] = [];
  let last = 0;
  for (const m of sentence.matchAll(CLAUSE)) {
    parts.push(sentence.slice(last, m.index));
    seps.push(m[0]);
    last = m.index + m[0].length;
  }
  parts.push(sentence.slice(last));
  if (parts.length < 3) return null;
  let pos = 0;
  let clause = -1;
  for (let i = 0; i < parts.length; i += 1) {
    const end = pos + (parts[i]?.length ?? 0);
    if (at >= pos && at < end) { clause = i; break; }
    pos = end + (seps[i]?.length ?? 0);
  }
  if (clause <= 0 || clause >= parts.length - 1) return null;
  const keep = parts.filter((_, i) => i !== clause);
  const keepSeps = seps.filter((_, i) => i !== clause);
  return { rewritten: keep.reduce((acc, p, i) => (i === 0 ? p : acc + (keepSeps[i - 1] ?? "") + p), ""), removed: parts[clause] ?? "" };
}
function stripToken(brief: string, token: string, others: string[]): { ok: true; brief: string; how: "sentence" | "clause" } | { ok: false; reason: string } {
  const at = brief.toLowerCase().indexOf(token.toLowerCase());
  const spans = sentenceSpans(brief);
  const i = at === -1 ? -1 : spans.findIndex((s) => at >= s.start && at < s.end);
  const sp = spans[i];
  if (!sp) return { ok: false, reason: "token_not_found_in_full_brief" };
  const sentence = brief.slice(sp.start, sp.end);
  if (!others.some((t) => sentence.toLowerCase().includes(t.toLowerCase()))) return { ok: true, brief: removeSpan(brief, spans, i), how: "sentence" };
  const c = stripClause(sentence, token);
  return c ? { ok: true, brief: brief.slice(0, sp.start) + c.rewritten + brief.slice(sp.end), how: "clause" } : { ok: false, reason: "sentence_carries_other_live_token_no_isolable_clause" };
}

export type BriefHonestPlan =
  | { outcome: "no_op"; perToken: { token: string; outcome: string }[] }
  | { outcome: "rejected"; reason: string; orphanCount: number; perToken: { token: string; outcome: string }[] }
  | { outcome: "accepted"; newFullBrief: string; previous: string; perToken: { token: string; outcome: string }[] };
/** Strip every unprovable token that can be stripped safely, then accept only when Gate A on the result has zero orphans against the item's FACT claims. */
export function planBriefHonest(fullBrief: string | null, tokens: string[], factClaims: { claim_text: string; source_span: string | null }[], derivedCovered: Set<string> = new Set()): BriefHonestPlan {
  const list = [...new Set(tokens.filter(Boolean))];
  const previous = fullBrief ?? "";
  let working = previous;
  const perToken: { token: string; outcome: string }[] = [];
  for (const token of list) {
    const r = stripToken(working, token, list.filter((t) => t !== token));
    perToken.push({ token, outcome: r.ok ? r.how : `refused:${r.reason}` });
    if (r.ok) working = r.brief;
  }
  if (working === previous) return { outcome: "no_op", perToken };
  const scan = scanGateA(working, factClaims.map((c) => ({ claim_text: c.claim_text, source_span: c.source_span ?? "" })), derivedCovered);
  return scan.orphan_count === 0 ? { outcome: "accepted", newFullBrief: working, previous, perToken } : { outcome: "rejected", reason: "gate_a_still_has_orphans_after_strip", orphanCount: scan.orphan_count, perToken };
}
