// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 14-25)
// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 205-321)
// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 346-394)
// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 431-737)
// Ported from old_repo/src/lib/intake/record-facts.mjs (lines 746-837)
// Ported from old_repo/src/lib/intake/record-facts-research.mjs (lines 106-190)
// The deterministic record-grade extractor: ONE walker over a trigger table, ONE claim constructor, and one claim per slot (INV-171).
// A FACT is emitted only after the span passes the database's verbatim rule (core/contracts isVerbatim, via assertVerbatim). The
// structured side-fields the old extractor lifted onto the payload (binding_position, due_date, date_precision, corridor_identity,
// research_credibility) are NOT computed here (coordinator ruling 2): no column holds them, and binding position and dates are
// derived from forward events downstream.
import { GAP_MARKER } from "@/core/brief/regulation-sections";
import { assertVerbatim } from "@/core/contracts/verbatim";
import { VOCABULARIES, normaliseMode } from "@/core/contracts/vocabularies";

import { BINDING_PRIORITY, BINDING_TRIGGERS, DUE_DATE_TRIGGERS, EU_ACT_SLOTS, FAMILY_SLOTS, MARKET_FAMILY, REGULATION_FAMILY, SLOT_TRIGGERS, URL_BEARING_SLOTS } from "./triggers";

export interface RecordClaim {
  section_key: "identity" | "record_facts";
  claim_kind: "FACT" | "GAP";
  claim_text: string;
  source_span: string | null;
  source_url: string | null;
  slot_key: string;
}
export interface Ctx { capturedText: string; sourceUrl: string | null }

// PROSE GUARD: a trigger is a keyword and a captured page is not only the instrument's text. A slot FACT must be a clause: at least
// four alphabetic words, no run of four identical punctuation characters (rules, borders), no HTML entity or tag fragment, and, for a
// slot where a bare domain IS the located fact, not a "see the website at <domain>" pointer.
const MIN_SPAN_WORDS = 4;
const HTML_ENTITY = /&(?:#\d+|#x[0-9a-f]+|[a-z]+);?/i;
const PUNCT_RUN = /([^\p{L}\p{N}\s])\1{3,}/u;
const HTML_TAG_FRAGMENT = /<\/?[a-zA-Z]/;

/** True when every URL in the span is a bare host with no path, query or hash: it cites "the website", never a document. */
export function hasOnlyBareDomainUrls(span: string): boolean {
  const urls = String(span ?? "").match(/https?:\/\/\S+/g);
  return !!urls && urls.every((raw) => {
    try {
      const u = new URL(raw);
      return (u.pathname === "" || u.pathname === "/") && u.search === "" && u.hash === "";
    } catch {
      return false;
    }
  });
}
export function isProseSpan(span: string, opts: { slotKey?: string } = {}): boolean {
  const s = String(span ?? "");
  if (PUNCT_RUN.test(s) || HTML_ENTITY.test(s) || HTML_TAG_FRAGMENT.test(s)) return false;
  if ((opts.slotKey === undefined || URL_BEARING_SLOTS.has(opts.slotKey)) && hasOnlyBareDomainUrls(s)) return false;
  return (s.match(/\p{L}{2,}/gu) ?? []).length >= MIN_SPAN_WORDS;
}

/** THE walker: the first trigger match, over every match of every trigger in order, whose span qualifies. */
function walk(triggers: readonly RegExp[], text: string, accept: (span: string) => boolean): { span: string; index: number } | null {
  for (const re of triggers) {
    for (const m of text.matchAll(re)) {
      const span = (m[0] ?? "").trim();
      if (span && accept(span)) return { span, index: m.index ?? 0 };
    }
  }
  return null;
}

// Span delimiters are guillemets, never straight quotes: the unicode-integrity scan reads a straight quote against a curly one as a transcription slip.
const slotWords = (slotKey: string) => slotKey.replace(/_/g, " ");
/** THE claim constructor: a FACT (span verified verbatim first) or an honest GAP; nothing else builds a claim. */
export function claim(slotKey: string, section: RecordClaim["section_key"], ctx: Ctx, found: { span: string; text: string } | null, gapText?: string): RecordClaim {
  if (found) {
    assertVerbatim(ctx.capturedText, found.span);
    return { section_key: section, claim_kind: "FACT", claim_text: `[${slotKey}] ${found.text}`, source_span: found.span, source_url: ctx.sourceUrl, slot_key: slotKey };
  }
  return { section_key: section, claim_kind: "GAP", claim_text: `[${slotKey}] ${gapText ?? `No verbatim ${slotWords(slotKey)} statement was located in the captured source text for this record-grade item.`} ${GAP_MARKER}`, source_span: null, source_url: null, slot_key: slotKey };
}
const stated = (span: string) => `The captured source states, verbatim: «${span}»`;

/** The identity FACT: the item's own title located verbatim in the captured text (case-insensitive; the span is cut from the SOURCE so its casing is the source's own). */
export function extractIdentityFact(a: { title: string | null | undefined; capturedText: string | null | undefined; sourceUrl: string | null }): RecordClaim | null {
  if (!a.title || !a.capturedText) return null;
  const idx = a.capturedText.toLowerCase().indexOf(a.title.toLowerCase());
  if (idx === -1) return null;
  const span = a.capturedText.slice(idx, idx + a.title.length);
  return claim("title", "identity", { capturedText: a.capturedText, sourceUrl: a.sourceUrl }, { span, text: `The captured source's own text carries this item's title verbatim: «${span}»` });
}

/** Binding position from applicability language: the strongest true statement first (direct duty ... monitoring only). */
const bindingClaim = (ctx: Ctx): RecordClaim => {
  for (const code of BINDING_PRIORITY) {
    const label = VOCABULARIES.binding_position?.[code]?.label;
    const hit = label ? walk(BINDING_TRIGGERS[code] ?? [], ctx.capturedText, (s) => isProseSpan(s, { slotKey: "binding_position" })) : null;
    if (hit) return claim("binding_position", "record_facts", ctx, { span: hit.span, text: `The captured source's own applicability language places this item at «${code}» (${label}), from the passage: «${hit.span}»` });
  }
  return claim("binding_position", "record_facts", ctx, null, "No verbatim applicability language naming a duty-holder class was located in the captured source text for this record-grade item.");
};

const LOCODE_PAIR = /\b([A-Z]{2}[A-Z0-9]{3})\s?(?:[-–—]|to|>)\s?([A-Z]{2}[A-Z0-9]{3})\b/g;
const MODE_WORD = /\b(ocean|sea|maritime|water|vessel|marine|road|truck|lorry|hgv|rail|air|freighter|airfreight|inland[- ]waterway|barge|iww)\b/i;
/** A literal UN/LOCODE pair with a transport-mode word in its neighbourhood; a port NAME is never geocoded into a code. */
const corridorClaim = (ctx: Ctx): RecordClaim => {
  const text = ctx.capturedText;
  for (const m of text.matchAll(LOCODE_PAIR)) {
    const start = Math.max(0, (m.index ?? 0) - 80);
    const window = text.slice(start, Math.min(text.length, (m.index ?? 0) + m[0].length + 80));
    const mode = normaliseMode(MODE_WORD.exec(window)?.[0]);
    if (mode) return claim("corridor_identity", "record_facts", ctx, { span: window.trim(), text: `The captured source names a lane between «${m[1]}» and «${m[2]}» by ${mode}, verbatim: «${window.trim()}»` });
  }
  return claim("corridor_identity", "record_facts", ctx, null, "No verbatim UN/LOCODE port-pair and mode were located together in the captured source text, so no corridor is stated.");
};

// The EUR-Lex legal-status widget. A bare scan for "no longer in force" misfires on recital prose and the site-wide filter label, so the
// only safe anchor is the indicator's own paragraph; it survives only in a raw HTML capture, so most captures honestly fall to GAP.
const FORCE_INDICATOR = /<p[^>]*class="[^"]*\bforceIndicator\b[^"]*"[^>]*>[\s\S]{0,300}?<\/span>\s*([^<]{1,200})/i;
const inForceClaim = (ctx: Ctx): RecordClaim => {
  const m = FORCE_INDICATOR.exec(ctx.capturedText);
  const status = m?.[1]?.trim();
  return m && status ? claim("in_force_status", "record_facts", ctx, { span: m[0], text: `The EUR-Lex page's own legal-status indicator states, verbatim: «${status}»` }) : claim("in_force_status", "record_facts", ctx, null, "No EUR-Lex legal-status indicator markup was located in the captured source text.");
};

const dueClaim = (ctx: Ctx): RecordClaim => {
  const hit = walk(DUE_DATE_TRIGGERS, ctx.capturedText, (s) => isProseSpan(s));
  return claim("due_date", "record_facts", ctx, hit ? { span: hit.span, text: `The captured source states a due date, verbatim: «${hit.span}»` } : null, "No verbatim due-date statement was located in the captured source text for this record-grade item.");
};

/** One required-slot claim: a specialised extractor where one exists, else the trigger table, else an honest GAP. */
export function buildRecordSlotClaim(slotKey: string, ctx: Ctx): RecordClaim {
  switch (slotKey) {
    case "binding_position": return bindingClaim(ctx);
    case "due_date": return dueClaim(ctx);
    case "corridor_identity": return corridorClaim(ctx);
    case "in_force_status": return inForceClaim(ctx);
    default: {
      const hit = walk(SLOT_TRIGGERS[slotKey] ?? [], ctx.capturedText, (s) => isProseSpan(s, { slotKey }));
      return claim(slotKey, "record_facts", ctx, hit ? { span: hit.span, text: stated(hit.span) } : null);
    }
  }
}

/** True when the URL's host is eur-lex.europa.eu or a subdomain: the gate for the EU-act self-description slots, independent of (possibly mis-bucketed) item_type. */
export function isEurlexHost(sourceUrl: string | null | undefined): boolean {
  try {
    const host = new URL(String(sourceUrl ?? "")).hostname.toLowerCase();
    return host === "eur-lex.europa.eu" || host.endsWith(".eur-lex.europa.eu");
  } catch {
    return false;
  }
}

/**
 * Every claim a record-grade payload needs: the identity FACT when locatable, then ONE claim per slot, in order: the required slots, the
 * item family's additions (binding position and due date for the regulation family, corridor identity for the market family, the three
 * research signals for research_finding) and, for an EUR-Lex source, the EU-act self-description slots. A slot named twice is built once.
 */
export function buildRecordFacts(a: { title: string | null | undefined; sourceUrl: string | null; capturedText: string; requiredSlots?: readonly string[]; itemType?: string | null }): RecordClaim[] {
  const ctx: Ctx = { capturedText: a.capturedText, sourceUrl: a.sourceUrl };
  const slots: string[] = [...(a.requiredSlots ?? [])];
  const family = REGULATION_FAMILY.has(String(a.itemType)) ? "regulation" : MARKET_FAMILY.has(String(a.itemType)) ? "market" : String(a.itemType);
  slots.push(...(FAMILY_SLOTS[family] ?? []));
  if (isEurlexHost(a.sourceUrl)) slots.push(...EU_ACT_SLOTS);
  const identity = extractIdentityFact({ title: a.title, capturedText: a.capturedText, sourceUrl: a.sourceUrl });
  return [...(identity ? [identity] : []), ...[...new Set(slots)].map((s) => buildRecordSlotClaim(s, ctx))];
}
