// New in VALID-1: R14 (V18): no claim-ledger JSON key and no internal marker in the body. Wraps findInternalMarkers (sentinels, the ledger name, a JSON object literal) and adds the ledger's own keys.
import { describeMarkers, findInternalMarkers } from "../sections";

import { textRule, violation } from "./_text";
import type { Rule } from "./types";

const keys = textRule("no-claim-ledger-json", "claim-ledger");
const rule: Rule = (b, i) => {
  const markers = findInternalMarkers(b.body);
  return markers.length ? violation("no-claim-ledger-json", describeMarkers(markers), markers[0]?.excerpt ?? "") : keys(b, i);
};
export default rule;
