// New in VALID-1: R10 (V30): sources_used holds at least one source id.
import { violation } from "./_text";
import type { Rule } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rule: Rule = (_b, i) => (i.sources_used.some((s) => UUID.test(s)) ? null : violation("sources-used-non-empty", "sources_used holds no source id", ""));
export default rule;
