// New in VALID-1: R27 (V27): why_matters and what_is_it are not null or blank.
import { violation } from "./_text";
import type { Rule } from "./types";

const rule: Rule = (_b, i) => {
  const blank = (["why_matters", "what_is_it"] as const).filter((k) => !i[k]?.trim());
  return blank.length ? violation("summary-fields-non-blank", `${blank.join(" and ")} blank`, "") : null;
};
export default rule;
