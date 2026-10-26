// Ported from old_repo/scripts/turns/record-briefs/schema.mjs (lines 548-1051)
// R8 (V21), VALID-1: a claim's declared section is a key of the format and, for a FACT, holds the claim's span. This is mirror f of the item-briefs validator, moved here so the registry is its one owner.
import { isVerbatim } from "@/core/contracts/verbatim";

import { FORMATS } from "../contract";

import { violation } from "./_text";
import type { Rule } from "./types";

const rule: Rule = (b) => {
  const keys = new Set((FORMATS.find((f) => f.formatType === b.format)?.sections ?? []).map((s) => s.key));
  const msgs: string[] = [];
  b.claims.forEach((c, ci) => {
    if (!c.section) return;
    if (!keys.has(c.section)) msgs.push(`claims[${ci}]: section ${JSON.stringify(c.section)} is not a canonical section key for format_type ${JSON.stringify(b.format)} (valid: ${JSON.stringify([...keys])})`);
    else if (c.kind === "FACT" && c.span?.trim() && !isVerbatim(b.sections.get(c.section), c.span)) msgs.push(`claims[${ci}]: source_span is not present in section ${JSON.stringify(c.section)}'s own extracted text -- a claim's declared section must contain the sentence its source_span comes from`);
  });
  return msgs.length ? violation("fact-span-in-own-section", msgs.join("; "), msgs[0] as string) : null;
};
export default rule;
