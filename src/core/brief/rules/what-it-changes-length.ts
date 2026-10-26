// New in VALID-1: R7 (V28): what_it_changes is present and within the contract's 80 to 200 characters (contract.json, the what_it_changes field).
import { limitOf, violation } from "./_text";
import type { Rule } from "./types";

const { min = 0, max = Infinity } = limitOf("what_it_changes");
const rule: Rule = (_b, i) => {
  const n = i.what_it_changes?.length ?? null;
  return n !== null && n >= min && n <= max ? null : violation("what-it-changes-length", n === null ? "what_it_changes is null" : `what_it_changes is ${n} characters, outside ${min} to ${max}`, i.what_it_changes ?? "");
};
export default rule;
