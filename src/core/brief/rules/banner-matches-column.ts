// New in VALID-1: R20 (V07): the SET of severity labels in the banner (the first 600 characters) equals the label of the severity token; a body with no banner passes.
import { LABELS, LABEL_OF } from "./_sev";
import { limitOf, violation } from "./_text";
import type { Rule } from "./types";

const LABEL_RE = new RegExp(LABELS.join("|"), "g");
const rule: Rule = (b, i) => {
  const head = b.body.slice(0, limitOf("banner").window ?? 600);
  const found = [...new Set(head.match(LABEL_RE) ?? [])];
  const want = i.severity === null ? undefined : LABEL_OF[i.severity];
  return found.length === 0 || (found.length === 1 && found[0] === want) ? null : violation("banner-matches-column", `banner ${found.join(" | ")} against severity ${String(i.severity)}`, head);
};
export default rule;
