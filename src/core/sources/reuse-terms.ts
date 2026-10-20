// New in R2c: no old counterpart (the registry had a paywalled flag that nothing read and no rights verdict at all, register rows D:49 and the collection measurement).
// The rights verdict of a publisher. The class table fixes the verdict only where a terms page was read (data/reuse-terms.json); everything else is `unknown`. The verdict is stored on sources.reuse_terms; the reader that accepts a
// quotation (R2b) applies the cap an `unknown` or `prohibited` verdict carries.
import { z } from "zod";

import { hostOf } from "@/core/shared";

import raw from "./data/reuse-terms.json";

export const REUSE_TERMS = ["open_government", "eu_reuse", "public_domain", "licensed", "unknown", "prohibited"] as const;
export type ReuseTerms = (typeof REUSE_TERMS)[number];
const terms = z.enum(REUSE_TERMS);
const RULES = z.object({ rules: z.array(z.object({ pattern: z.string().transform((s) => new RegExp(s)), terms, read: z.string().min(10) })) }).parse(raw).rules;

/** The rights verdict the class table fixes for a host, `unknown` when it fixes none. */
export function reuseTermsForHost(urlOrHost: string | null | undefined): ReuseTerms {
  const host = hostOf(urlOrHost);
  return RULES.find((r) => r.pattern.test(host))?.terms ?? "unknown";
}
