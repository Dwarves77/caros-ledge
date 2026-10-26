// New in VALID-1: R19 (V06): the priority is the locked map's priority for the severity token.
import { PRIORITY_OF } from "./_sev";
import { violation } from "./_text";
import type { Rule } from "./types";

const rule: Rule = (_b, i) => {
  const want = i.severity === null ? undefined : PRIORITY_OF[i.severity];
  return want === undefined || want === i.priority ? null : violation("priority-follows-map", `severity ${i.severity} locks priority ${want}, the column holds ${String(i.priority)}`, String(i.priority));
};
export default rule;
