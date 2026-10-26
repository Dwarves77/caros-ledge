// New in VALID-1: R29 (V31): a market signal brief carries its signal_band and a research summary its theme.
import { violation } from "./_text";
import type { Rule } from "./types";

const rule: Rule = (b, i) => {
  const field = b.format === "market_signal_brief" ? "signal_band" : "theme";
  return i[field] ? null : violation("band-or-theme-present", `${field} is missing on a ${b.format}`, "");
};
export default rule;
