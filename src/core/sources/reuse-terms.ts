// New in R2c: no old counterpart (the registry had a paywalled flag that nothing read and no rights verdict at all, register rows D:49 and the collection measurement).
// The rights verdict of a publisher and the quotation rule it drives. The class table fixes the verdict only where a terms page was read (data/reuse-terms.json); everything else is `unknown`. A span from an unknown or prohibited
// source is capped at the length the config names (data/quotation.json) and carries the attribution the registry holds; every other verdict is quoted in full.
import { z } from "zod";

import { hostOf } from "@/core/shared";

import quotation from "./data/quotation.json";
import raw from "./data/reuse-terms.json";

export const REUSE_TERMS = ["open_government", "eu_reuse", "public_domain", "licensed", "unknown", "prohibited"] as const;
export type ReuseTerms = (typeof REUSE_TERMS)[number];
const terms = z.enum(REUSE_TERMS);
const RULES = z.object({ rules: z.array(z.object({ pattern: z.string().transform((s) => new RegExp(s)), terms, read: z.string().min(10) })) }).parse(raw).rules;
const CAPS = z.object({ maxChars: z.object({ unknown: z.number().int().positive(), prohibited: z.number().int().positive() }) }).parse(quotation).maxChars;

/** The rights verdict the class table fixes for a host, `unknown` when it fixes none. */
export function reuseTermsForHost(urlOrHost: string | null | undefined): ReuseTerms {
  const host = hostOf(urlOrHost);
  return RULES.find((r) => r.pattern.test(host))?.terms ?? "unknown";
}

/** The most characters of one span a verdict allows, or null for none (quoted in full). */
export const quotationLimit = (verdict: ReuseTerms | null | undefined): number | null => (verdict === "prohibited" ? CAPS.prohibited : !verdict || verdict === "unknown" ? CAPS.unknown : null);

export interface QuotedSpan {
  text: string;
  truncated: boolean;
  /** The attribution the registry holds for the source, carried with a capped span; null when the span is quoted in full. */
  attribution: string | null;
}
/** Apply the quotation rule to one span. A capped span is cut at the limit on a word boundary, and says so. */
export function capQuotation(span: string, verdict: ReuseTerms | null | undefined, source: { name: string; url: string }): QuotedSpan {
  const limit = quotationLimit(verdict);
  if (limit === null) return { text: span, truncated: false, attribution: null };
  const attribution = `${source.name} (${source.url})`;
  if (span.length <= limit) return { text: span, truncated: false, attribution };
  const cut = span.slice(0, limit);
  const word = cut.lastIndexOf(" ");
  return { text: `${(word > limit * 0.6 ? cut.slice(0, word) : cut).trimEnd()}…`, truncated: true, attribution };
}
