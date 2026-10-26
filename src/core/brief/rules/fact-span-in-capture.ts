// New in VALID-1: R16 (V34): a FACT span is verbatim in its attributed capture (the item pool for a batch entry, the claim's search result for a stored row). Wraps assertVerbatim, the JavaScript twin of public.is_verbatim.
import { assertVerbatim } from "@/core/contracts/verbatim";

import { violation } from "./_text";
import type { Rule } from "./types";

const rule: Rule = (b) => {
  const msgs: string[] = [];
  b.claims.forEach((c, ci) => {
    if (c.kind !== "FACT" || !c.span?.trim()) return;
    try {
      assertVerbatim(c.capture, c.span);
    } catch (e) {
      msgs.push(`claims[${ci}]: source_span is not a verbatim substring of the item's pool text (${(e as Error).message})`);
    }
  });
  return msgs.length ? violation("fact-span-in-capture", msgs.join("; "), msgs[0] as string) : null;
};
export default rule;
