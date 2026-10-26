// New in VALID-1: R18 (V05): severity is set on the four formats whose skill makes it mandatory (the registry row names them).
import { violation } from "./_text";
import type { Rule } from "./types";

const rule: Rule = (b, i) => (i.severity === null ? violation("severity-present", `severity is null on a ${b.format}`, "") : null);
export default rule;
