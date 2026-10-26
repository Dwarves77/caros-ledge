// New in VALID-1: R17 (V04): severity is null or one of the five ADR-052 tokens.
import { TOKENS } from "./_sev";
import { violation } from "./_text";
import type { Rule } from "./types";

const rule: Rule = (_b, i) => (i.severity === null || TOKENS.includes(i.severity) ? null : violation("severity-in-vocabulary", `severity ${JSON.stringify(i.severity)} is not one of ${TOKENS.join(", ")}`, i.severity));
export default rule;
