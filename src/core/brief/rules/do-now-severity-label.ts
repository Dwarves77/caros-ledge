// New in VALID-1: R9 (V08): each do-now section the brief has (regulatory 3 and 11, technology 7, market 7) carries one of the five severity labels, in the space-separated form rendered from the tokens (ADR-052).
import { sectionWithRole } from "../sections";

import { LABELS } from "./_sev";
import { violation } from "./_text";
import type { Rule } from "./types";

const LABEL_RE = new RegExp(LABELS.join("|"));
const rule: Rule = (b) => {
  const bare = sectionWithRole(b.format, "do_now").map((s) => s.key).filter((k) => b.sections.has(k) && !LABEL_RE.test(b.sections.get(k) as string));
  return bare.length ? violation("do-now-severity-label", `do-now section ${bare.join(", ")} carries no severity label (${LABELS.join(", ")})`, b.sections.get(bare[0] as string) as string) : null;
};
export default rule;
