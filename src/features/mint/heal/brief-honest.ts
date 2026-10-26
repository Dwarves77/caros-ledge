// Ported from old_repo/scripts/mint/heal-provenance.mjs (lines 2029-2225)
// The honest strip, opt-in, per sentence (ADR-050: code never rewrites or composes a sentence; a strip removes whole sentences or nothing). A sentence whose every live
// figure or date is unprovable is removed whole; a table row or list item is one assertion and goes whole whatever else it states (HEAL-1b). A sentence that also states a figure or date a source DOES prove is kept, and its unprovable tokens come back as RESIDUE with the sentence, for the reader (DIGEST-1 PR B).
// The strips are applied whether or not residue remains: the item is released only when Gate A then finds no orphan (the database criterion), so a residue item stays quarantined, named.
// The previous text comes back in the result (`previous`) so the strip is reversible; it is not assembled into a SQL string.
import { scanGateA, type FactClaim } from "@/core/grounding";

const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9])/g;
interface Unit { start: number; end: number; row: boolean }

/** The units a brief is made of: each table row or list item whole, else each sentence of the line. */
function unitsOf(text: string): Unit[] {
  const units: Unit[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    if (/^\s*(\||[-*]\s)/.test(line)) units.push({ start: at, end: at + line.length, row: true });
    else {
      let from = 0;
      for (const m of line.matchAll(SENTENCE_END)) { units.push({ start: at + from, end: at + m.index, row: false }); from = m.index + m[0].length; }
      if (line.slice(from).trim()) units.push({ start: at + from, end: at + line.length, row: false });
    }
    at += line.length + 1;
  }
  return units.filter((u) => u.end > u.start);
}
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

export interface Residue { token: string; sentence: string }
export interface PerToken { token: string; outcome: string; removed?: string[] }
export type BriefHonestPlan =
  | { outcome: "no_op"; perToken: PerToken[]; stripped: string[]; residue: Residue[] }
  | { outcome: "partial" | "accepted"; newFullBrief: string; previous: string; perToken: PerToken[]; stripped: string[]; residue: Residue[]; orphanCount: number };
/**
 * Remove every sentence whose live tokens are all unprovable; keep the rest and list the unprovable tokens they carry. "accepted" when Gate A then finds no orphan against the item's FACT claims, "partial" when residue
 * remains (the strips still stand: an unprovable sentence does not stay live), "no_op" when nothing could be removed whole.
 */
export function planBriefHonest(fullBrief: string | null, tokens: string[], factClaims: FactClaim[], derivedCovered: Set<string> = new Set()): BriefHonestPlan {
  const previous = fullBrief ?? "";
  const unprovable = new Set(tokens.filter(Boolean).map((t) => t.toLowerCase()));
  const perToken = new Map<string, PerToken>([...new Set(tokens.filter(Boolean))].map((t) => [t, { token: t, outcome: "refused:token_not_found_in_full_brief" }]));
  const stripped: string[] = [];
  const residue: Residue[] = [];
  const units = unitsOf(previous);
  const cut = new Set<number>();
  units.forEach((u, i) => {
    const sentence = previous.slice(u.start, u.end);
    const own = [...perToken.keys()].filter((t) => occurrence(sentence, t) !== -1);
    if (!own.length) return;
    const whole = u.row || !tokensIn(sentence).some((t) => !unprovable.has(t));
    if (whole) { cut.add(i); stripped.push(sentence); }
    for (const token of own) {
      const entry = perToken.get(token) as PerToken;
      if (whole) { if (!entry.outcome.startsWith("kept")) entry.outcome = "sentence"; entry.removed = [...(entry.removed ?? []), sentence]; }
      else { entry.outcome = "kept:sentence_states_a_proven_token"; residue.push({ token, sentence }); }
    }
  });
  const list = [...perToken.values()];
  if (!cut.size) return { outcome: "no_op", perToken: list, stripped, residue };
  let working = "";
  units.forEach((u, i) => {
    if (!cut.has(i)) working += (working || i === 0 ? previous.slice(units[i - 1]?.end ?? 0, u.start) : "") + previous.slice(u.start, u.end);
  });
  if (!cut.has(units.length - 1)) working += previous.slice(units[units.length - 1]?.end ?? 0);
  const scan = scanGateA(working, factClaims, derivedCovered);
  return { outcome: scan.orphan_count === 0 ? "accepted" : "partial", newFullBrief: working, previous, perToken: list, stripped, residue, orphanCount: scan.orphan_count };
}
