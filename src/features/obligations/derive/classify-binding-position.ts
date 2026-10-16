// Ported from old_repo/src/lib/obligations/classify-binding-position.mjs (lines 1-165)
// Ported from old_repo/scripts/obligations/derive-obligations.mjs (lines 48-94)
// binding_position (direct_duty, carrier_passthrough, customer_contract, monitoring_only) decided in a FIXED ORDER and never guessed: the instrument's own
// identity against the spec 01 section 1 rule table (16 rules, DATA in data/binding-rules.json); else the record-facts [binding_position] claim; else the
// title, where a generic phrase counts only where its rule allows (CBAM for an EU item, never PPWR); else monitoring_only when every known duty-holder class
// excludes the forwarder role; else null (not yet classified).
import { z } from "zod";

import { DUTY_HOLDER_CLASSES, isValid } from "@/core/contracts/vocabularies";
import { dutyHoldersExcludeForwarder } from "@/core/workspace";

import raw from "./data/binding-rules.json";

const DUTY_CLASSES = Object.fromEntries(Object.entries(DUTY_HOLDER_CLASSES).map(([k, v]) => [k, { label: v.label, orgRoles: v.orgRoles ?? [] }]));
const re = z.object({ source: z.string(), flags: z.string() });
const file = z.object({ rules: z.array(z.object({ position: z.string(), citation: z.string(), label: z.string(), test: re, generic: z.object({ phrase: re, acceptedForJurisdiction: z.enum(["EU", "any", "none"]) }).optional() })) }).parse(raw);

interface Rule {
  position: string;
  citation: string;
  label: string;
  test: RegExp;
  generic: { phrase: RegExp; acceptedFor: (item: { jurisdictionIso?: readonly string[] | null }) => boolean } | null;
}
const RULES: readonly Rule[] = file.rules.map((r) => ({
  position: r.position, citation: r.citation, label: r.label, test: new RegExp(r.test.source, r.test.flags),
  generic: r.generic ? { phrase: new RegExp(r.generic.phrase.source, r.generic.phrase.flags), acceptedFor: (item) => (r.generic?.acceptedForJurisdiction === "any" ? true : r.generic?.acceptedForJurisdiction === "EU" ? (item.jurisdictionIso ?? []).includes("EU") : false) } : null,
}));
/** The rule table as data (labels and citations), for a surface that explains a classification. */
export const BINDING_POSITION_RULES: readonly { position: string; citation: string; label: string }[] = RULES.map(({ position, citation, label }) => ({ position, citation, label }));

export interface Classified {
  position: string;
  citation: string;
}
function matchRules(haystack: string, item: { jurisdictionIso?: readonly string[] | null }): Classified | null {
  if (!haystack) return null;
  for (const rule of RULES) {
    let text = haystack;
    const accepted = rule.generic ? rule.generic.acceptedFor(item) : false;
    if (rule.generic && !accepted) text = haystack.replace(rule.generic.phrase, " ");
    if (rule.test.test(text)) return { position: rule.position, citation: rule.citation };
    if (rule.generic && accepted) {
      rule.generic.phrase.lastIndex = 0;
      if (rule.generic.phrase.test(haystack)) {
        rule.generic.phrase.lastIndex = 0;
        return { position: rule.position, citation: rule.citation };
      }
      rule.generic.phrase.lastIndex = 0;
    }
  }
  return null;
}
const joinLower = (parts: readonly unknown[]): string => parts.filter((s): s is string => typeof s === "string" && s.length > 0).join(" ").toLowerCase();

/** Identity first: the instrument's legal name, short name and identifiers against the table (no generic phrases, no title). */
export function classifyInstrumentIdentity(item: { legalInstrument?: string | null; shortName?: string | null; instrumentIdentifiers?: readonly (string | null | undefined)[] }): Classified | null {
  return matchRules(joinLower([item?.legalInstrument, item?.shortName, ...(Array.isArray(item?.instrumentIdentifiers) ? item.instrumentIdentifiers : [])]), {});
}
/** The title (and names) against the table, where a generic phrase is accepted only for the jurisdictions its rule names. */
export function classifyBindingPosition(item: { title?: string | null; legalInstrument?: string | null; shortName?: string | null; jurisdictionIso?: readonly string[] | null }): Classified | null {
  return matchRules(joinLower([item?.title, item?.legalInstrument, item?.shortName]), item);
}

export interface ItemForClassification {
  title?: string | null;
  jurisdiction_iso?: readonly string[] | null;
  instrument_identifier?: string | null;
  canonical_instrument_key?: string | null;
  legal_instrument?: string | null;
}
export interface ClassifyContext {
  recordFactsPosition?: string | null;
  dutyHolderClasses?: readonly string[];
}
export type ClassificationSource = "instrument_identity" | "record_facts" | "title" | "duty_holder_excludes_forwarder";

/** The text of the record-facts claims to the context the classifier reads: the [binding_position] claim's position and the Member-State addressee. */
export function contextFromClaims(claimTexts: readonly unknown[] | null | undefined): { recordFactsPosition: string | null; dutyHolderClasses: string[] } {
  let recordFactsPosition: string | null = null;
  const dutyHolderClasses: string[] = [];
  for (const t of claimTexts ?? []) {
    if (typeof t !== "string") continue;
    if (t.startsWith("[binding_position]") && !recordFactsPosition) {
      const m = t.match(/places this item at\s+[«"']?([a-z_]+)/);
      if (m && isValid("binding_position", m[1])) recordFactsPosition = m[1] as string;
    }
    if (t.startsWith("[jurisdictional_scope]") && /addressed to the member states/i.test(t) && !dutyHolderClasses.includes("member_state")) dutyHolderClasses.push("member_state");
  }
  return { recordFactsPosition, dutyHolderClasses };
}

/** The fixed order: identity, record-facts claim, title, duty holders that exclude the forwarder; else null. */
export function classifyItemBindingPosition(item: ItemForClassification | null | undefined, ctx: ClassifyContext = {}): (Classified & { source: ClassificationSource }) | null {
  const byIdentity = classifyInstrumentIdentity({ legalInstrument: item?.legal_instrument ?? null, instrumentIdentifiers: [item?.instrument_identifier, item?.canonical_instrument_key] });
  if (byIdentity) return { ...byIdentity, source: "instrument_identity" };
  if (ctx.recordFactsPosition && isValid("binding_position", ctx.recordFactsPosition)) return { position: ctx.recordFactsPosition, source: "record_facts", citation: "record-facts [binding_position] claim" };
  const byTitle = classifyBindingPosition({ title: item?.title ?? null, jurisdictionIso: item?.jurisdiction_iso ?? null });
  if (byTitle) return { ...byTitle, source: "title" };
  if (dutyHoldersExcludeForwarder(ctx.dutyHolderClasses, DUTY_CLASSES)) return { position: "monitoring_only", source: "duty_holder_excludes_forwarder", citation: "spec 01 section 3.2 duty_holder_class excludes every forwarder role" };
  return null;
}
