// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 2029-2225)
// The honest strip, opt-in: a figure no source in reach can prove is removed from the full brief at every place it stands, as its whole sentence, or, when the sentence carries a figure or date that is NOT being removed,
// as the one isolable middle clause (the first and last clause are never guessed at). The plan is ACCEPTED only when Gate A then finds no orphan; otherwise nothing changes.
// The previous text comes back in the result (`previous`) so the strip is reversible; it is not assembled into a SQL string.
import { scanGateA, type FactClaim } from "@/core/grounding";
import { indexOfInsensitive } from "@/core/parse";

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
function stripClause(sentence: string, token: string): { rewritten: string; removed: string } | null {
  const found = indexOfInsensitive(sentence, token);
  if (!found) return null;
  const at = found.index;
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
const MAX_OCCURRENCES = 200;
const escapeRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The first place the token stands as itself: not inside a longer word or number (`€15` is not in `€150`), and a month-year not inside a dated day (`March 2026` is not in `31 March 2026`). -1 when there is none. */
function occurrence(text: string, token: string): number {
  const re = new RegExp(escapeRe(token), "giu");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text.slice(0, m.index);
    const after = text[m.index + m[0].length] ?? "";
    if (/[\p{L}\p{N}]$/u.test(before) || (/\p{N}$/u.test(m[0]) && /^\p{N}/u.test(after)) || (/^\p{L}/u.test(m[0]) && /\d{1,2}\s+$/.test(before))) continue;
    return m.index;
  }
  return -1;
}
/** The figures and dates a sentence states, as the Gate A harvest reads them (every one is an orphan when no claim is given). */
const tokensIn = (sentence: string): string[] => scanGateA(sentence, []).orphans.map((o) => o.token.toLowerCase());
type Strip = { ok: true; brief: string; how: "sentence" | "clause"; removed: string } | { ok: false; reason: string };
/** One cut: the table row or list item of the first occurrence, whole; else its sentence, whole, unless it also states a figure or date this strip is NOT removing (a live one): then the one isolable middle clause, or a refusal. Sibling unprovable tokens do not protect a sentence. */
function stripOnce(brief: string, token: string, unprovable: ReadonlySet<string>): Strip {
  const at = occurrence(brief, token);
  if (at !== -1) {
    // A table row or a list item is one assertion: it goes whole, whatever else it states.
    const from = brief.lastIndexOf("\n", at - 1) + 1;
    const to = brief.indexOf("\n", at);
    const line = brief.slice(from, to === -1 ? brief.length : to);
    if (/^\s*(\||[-*]\s)/.test(line)) return { ok: true, brief: brief.slice(0, from) + (to === -1 ? "" : brief.slice(to + 1)), how: "sentence", removed: line };
  }
  const spans = sentenceSpans(brief);
  const i = at === -1 ? -1 : spans.findIndex((s) => at >= s.start && at < s.end);
  const sp = spans[i];
  if (!sp) return { ok: false, reason: "token_not_found_in_full_brief" };
  const sentence = brief.slice(sp.start, sp.end);
  if (!tokensIn(sentence).some((t) => !unprovable.has(t))) return { ok: true, brief: removeSpan(brief, spans, i), how: "sentence", removed: sentence };
  const c = stripClause(sentence, token);
  return c ? { ok: true, brief: brief.slice(0, sp.start) + c.rewritten + brief.slice(sp.end), how: "clause", removed: c.removed } : { ok: false, reason: "sentence_carries_other_live_token_no_isolable_clause" };
}
/** Every standing occurrence of the token is cut (a token is uncovered wherever it stands, so one cut would leave the orphan). */
function stripToken(brief: string, token: string, unprovable: ReadonlySet<string>): { ok: true; brief: string; how: "sentence" | "clause"; removed: string[] } | { ok: false; reason: string } {
  let working = brief;
  const removed: string[] = [];
  let how: "sentence" | "clause" = "sentence";
  while (occurrence(working, token) !== -1) {
    if (removed.length >= MAX_OCCURRENCES) return { ok: false, reason: "too_many_occurrences" };
    const r = stripOnce(working, token, unprovable);
    if (!r.ok) return r;
    working = r.brief;
    removed.push(r.removed);
    if (r.how === "clause") how = "clause";
  }
  return removed.length ? { ok: true, brief: working, how, removed } : { ok: false, reason: "token_not_found_in_full_brief" };
}

export type BriefHonestPlan =
  | { outcome: "no_op"; perToken: { token: string; outcome: string; removed?: string[] }[] }
  | { outcome: "rejected"; reason: string; orphanCount: number; perToken: { token: string; outcome: string; removed?: string[] }[] }
  | { outcome: "accepted"; newFullBrief: string; previous: string; perToken: { token: string; outcome: string; removed?: string[] }[] };
/** Strip every unprovable token that can be stripped safely, then accept only when Gate A on the result has zero orphans against the item's FACT claims. */
export function planBriefHonest(fullBrief: string | null, tokens: string[], factClaims: FactClaim[], derivedCovered: Set<string> = new Set()): BriefHonestPlan {
  const list = [...new Set(tokens.filter(Boolean))];
  const previous = fullBrief ?? "";
  let working = previous;
  const perToken: { token: string; outcome: string; removed?: string[] }[] = [];
  const unprovable = new Set(list.map((t) => t.toLowerCase()));
  for (const token of list) {
    const r = stripToken(working, token, unprovable);
    perToken.push({ token, outcome: r.ok ? r.how : `refused:${r.reason}`, ...(r.ok ? { removed: r.removed } : {}) });
    if (r.ok) working = r.brief;
  }
  if (working === previous) return { outcome: "no_op", perToken };
  const scan = scanGateA(working, factClaims, derivedCovered);
  return scan.orphan_count === 0 ? { outcome: "accepted", newFullBrief: working, previous, perToken } : { outcome: "rejected", reason: "gate_a_still_has_orphans_after_strip", orphanCount: scan.orphan_count, perToken };
}
