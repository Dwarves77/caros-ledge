// New in AUTHOR-FIX-1: R34: a do-now sentence that only restates a GAP claim of the same brief (the same sentence once case, marks and spacing are normalised) is gap narration written as an action; the gap belongs in the gaps, never in do-now.
import { sectionWithRole } from "../sections";

import { LABELS } from "./_sev";
import { violation } from "./_text";
import type { Rule } from "./types";

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const LEAD = new RegExp(`^\s*(?:[-*]\s*)?(?:${LABELS.join("|")})\s*:?\s*`);
const rule: Rule = (b) => {
  const gaps = new Set(b.claims.filter((c) => c.kind === "GAP").map((c) => norm(c.text.replace(/^\s*\[[^\]]*\]\s*/, ""))).filter(Boolean));
  if (!gaps.size) return null;
  for (const { key } of sectionWithRole(b.format, "do_now")) {
    for (const line of (b.sections.get(key) ?? "").split(/(?<=[.!?])\s+|\n+/)) {
      if (gaps.has(norm(line.replace(LEAD, "")))) return violation("do-now-restates-gap", `do-now section ${key} restates a gap as an action`, line.trim());
    }
  }
  return null;
};
export default rule;
