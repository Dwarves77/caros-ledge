// Ported from old_repo/src/lib/agent/slot-prompt.mjs (lines 5-57)
// Ported from old_repo/src/lib/agent/slot-forcing.mjs (lines 7-72)
// Required slots (item_type_required_slots, read from the table: migration 299 is folded into the schema, no JSON copy). A slot is
// covered by a cited FACT or an explicit GAP; the AUTHOR is the confirmer of a slot FACT: this module only offers verbatim
// candidates, and a FACT exists only when the author confirms one (INV-160, never a forced or paraphrased one).
import { boundedRead, type Db } from "@/core/db";
import { LookupError } from "@/core/http/errors";
import { contentWords, hasWord } from "@/core/parse";

import { GROUND_CONFIG } from "./config";

export interface SlotRow { slot_key: string; description?: string | null }
export interface Nomination { span: string; url: string }
export interface SlotDecision { kind: "FACT" | "GAP" | "RELABEL"; slot_key: string; source_span?: string; source_url?: string; reason: string }

/** The item type's required slots; a failed read fails loud (it was once swallowed into "enforce nothing"). */
export async function readRequiredSlots(sb: Db, itemType: string): Promise<SlotRow[]> {
  const r = await boundedRead<SlotRow>((limit) => sb.from("item_type_required_slots").select("slot_key, description").eq("item_type", itemType).order("slot_key", { ascending: true }).limit(limit), { limit: 100 });
  if (r.error) throw new LookupError("item_type_required_slots", r.error);
  return r.data;
}

/** The slot's distinctive words (stop words removed: "with" and "that" name no topic). */
const wantWords = (s: SlotRow): Set<string> => contentWords(String(s.description || s.slot_key));

/**
 * Does the prose speak to the slot: its bracketed key or key phrase, or ONE sentence that carries at least two of the slot's distinctive words (one when the slot has only one),
 * each as a whole word? A slot with no distinctive word at all is not covered: it cannot be shown to be.
 */
function slotCovered(body: string, slot: SlotRow): boolean {
  const text = String(body ?? "").toLowerCase();
  const key = slot.slot_key.toLowerCase();
  if (text.includes(`[${key}]`) || hasWord(text, key.replace(/_/g, " "))) return true;
  const want = [...wantWords(slot)];
  const need = Math.min(2, want.length);
  return need > 0 && text.split(/(?<=[.!?])\s+/).some((sent) => want.filter((w) => hasWord(sent, w)).length >= need);
}
/** The required slots the brief covers neither topically nor as an explicit GAP: the refusal reason of a silently uncovered slot. */
export const uncoveredSlots = (body: string, slots: SlotRow[] | null | undefined): SlotRow[] => (slots ?? []).filter((s) => !slotCovered(body, s));

// Clause delimiters in source text, including the HTML whitespace ENTITIES legislation.gov.uk leaves un-decoded: splitting on them keeps
// every clause a verbatim substring of the source.
const CLAUSE_DELIM = /(?:&#x0*(?:d|a|9);)|(?:&#0*(?:13|10|9);)|[\r\n]+|(?<=[.!?;:])\s+/gi;

/** Verbatim clause candidates for a slot from the pool, best topic overlap first. Floor-first is the caller's contract: pass the FLOOR pool for a FACT. */
export function nominateForSlot(slotDescription: string | null | undefined, pool: { url: string; text: string }[], slotKey = ""): Nomination[] {
  const want = contentWords(`${slotDescription ?? ""} ${slotKey}`);
  const cands: { span: string; url: string; score: number }[] = [];
  const seen = new Set<string>();
  for (const src of pool ?? []) {
    for (const raw of String(src.text ?? "").split(CLAUSE_DELIM)) {
      const clause = (raw ?? "").trim();
      if (clause.length < GROUND_CONFIG.MIN_SPAN_CHARS || clause.length > GROUND_CONFIG.MAX_NOMINATION_SPAN) continue;
      const lc = clause.toLowerCase();
      const hits = [...want].filter((w) => hasWord(lc, w)).length;
      const key = `${src.url}\u0000${clause}`;
      if (hits === 0 || seen.has(key)) continue;
      seen.add(key);
      cands.push({ span: clause, url: src.url, score: hits });
    }
  }
  return cands.sort((a, b) => b.score - a.score).map(({ span, url }) => ({ span, url }));
}

/**
 * One uncovered slot's claim. The ONLY path to a FACT is a confirmation by the author of a REAL nomination; with none, the slot is a
 * GAP (the prose does not cover it) or a RELABEL (the prose covers it but no span is confirmed as a binding FACT).
 */
export function decideSlotClaim(a: { slotKey: string; nomination: Nomination | null; confirmed: boolean; proseCovers: boolean }): SlotDecision {
  if (a.nomination && a.confirmed) return { kind: "FACT", slot_key: a.slotKey, source_span: a.nomination.span, source_url: a.nomination.url, reason: "author-confirmed verbatim span supports the assertion" };
  if (!a.proseCovers) return { kind: "GAP", slot_key: a.slotKey, reason: "slot genuinely not covered in prose or pool: honest GAP" };
  return { kind: "RELABEL", slot_key: a.slotKey, reason: "prose covers it but no span is confirmed as a binding FACT: grounded analysis, never a forced FACT" };
}
