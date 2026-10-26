// New in VALID-1: R12 (V19): every non-conditional section of the format has a row. An omission note is no row.
import { FORMATS } from "../contract";

import { violation } from "./_text";
import type { Rule } from "./types";

const rule: Rule = (b) => {
  const missing = (FORMATS.find((f) => f.formatType === b.format)?.sections ?? []).filter((s) => !s.conditional && !b.sections.has(s.key)).map((s) => s.key);
  return missing.length ? violation("required-sections-present", `${b.format} has no section ${missing.join(", ")}`, missing.join(", ")) : null;
};
export default rule;
