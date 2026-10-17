// The coverage line under a list always draws its link (WAVE-4 addendum): a refused or unavailable read is the unavailable state with the Absence token, never "not covered yet"; "not covered yet" is only the
// state of a SUCCESSFUL read that returns zero.
import assert from "node:assert/strict";
import { test } from "node:test";

import { denominatorLineView } from "@/features/coverage/denominator-view";

const line = { surface: "research", label: "Research", numerator: 3, denominator: 10, verifiedBriefs: 2, href: "/dashboard/coverage?class=research" };

test("a refused read (the census policy is not there yet) keeps the link and says the count did not load; it is never 'not covered yet'", () => {
  for (const [d, error] of [[null, "Coverage is unavailable"], [null, null], [line, "refused"]] as const) {
    const v = denominatorLineView(d, error, "research");
    assert.equal(v.state, "unavailable");
    assert.ok(v.href.startsWith("/dashboard/coverage"), "the link is drawn");
    assert.equal(v.text, null);
  }
});
test("a successful read of zero is the only 'not covered yet' state, and it still draws the link", () => {
  const v = denominatorLineView({ ...line, denominator: 0 }, null, "research");
  assert.deepEqual([v.state, v.href], ["empty-catalogue", line.href]);
});
test("a successful read with a count draws the stated count and the link", () => {
  const v = denominatorLineView(line, null, "research");
  assert.equal(v.state, "count");
  assert.match(String(v.text), /3/);
  assert.equal(v.href, line.href);
});
