// New in VALID-1: R26 (V26): urgency_tier is one of the contract's four values.
import { URGENCY_TIERS } from "../contract";

import { violation } from "./_text";
import type { Rule } from "./types";

const rule: Rule = (_b, i) => (i.urgency_tier !== null && URGENCY_TIERS.includes(i.urgency_tier) ? null : violation("urgency-tier-in-vocabulary", `urgency_tier ${JSON.stringify(i.urgency_tier)} is not one of ${URGENCY_TIERS.join(", ")}`, String(i.urgency_tier)));
export default rule;
