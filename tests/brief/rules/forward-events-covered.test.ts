import assert from "node:assert/strict";
import { test } from "node:test";

import { fixtureRow, run, ruleTests } from "../_cases.ts";

ruleTests("forward-events-covered");

const base = fixtureRow("forward-events-covered");
const D = "2031-02-03";
const go = (b: Record<string, unknown>) => run("forward-events-covered", { ...base.brief, ...b }, base.item);

test("forward-events-covered: a supplied date missing from the entry is residue naming the rule", () => assert.equal(go({})?.rule, "forward-events-covered"));
test("forward-events-covered: the date in the events block passes", () => assert.equal(go({ events: [D] }), null));
test("forward-events-covered: the date quoted in a section passes", () => assert.equal(go({ body: `${base.brief.body}\n\nThe step falls on ${D}.` }), null));
test("forward-events-covered: a stated reason for omitting passes, a blank reason does not", () => {
  assert.equal(go({ omitted: [{ date: D, reason: "the source gives it as a meeting, not an event" }] }), null);
  assert.equal(go({ omitted: [{ date: D, reason: "  " }] })?.rule, "forward-events-covered");
});
test("forward-events-covered: an item with no supplied events passes", () => assert.equal(run("forward-events-covered", base.brief, { ...base.item, supplied_dates: [] }), null));
