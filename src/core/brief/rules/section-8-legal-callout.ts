// New in AUTHOR-FIX-1: R35: section 8 of a regulatory fact document carries the legal callout (LEGAL_CALLOUT followed by non-empty text): the obligations there name the question for counsel (J13).
import { LEGAL_CALLOUT } from "../vocab";

import { violation } from "./_text";
import type { Rule } from "./types";

const rule: Rule = (b) => {
  const s = b.sections.get("8");
  if (s === undefined) return null;
  const at = s.indexOf(LEGAL_CALLOUT);
  return at >= 0 && s.slice(at + LEGAL_CALLOUT.length).trim() !== "" ? null : violation("section-8-legal-callout", `section 8 carries no ${LEGAL_CALLOUT} line naming the question for counsel`, s);
};
export default rule;
