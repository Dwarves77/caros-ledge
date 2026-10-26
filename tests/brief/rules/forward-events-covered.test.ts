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

// Precision (PR 139): a month-precision row (stored YYYY-MM-01) arrives as the key YYYY-MM and a year-precision row (YYYY-01-01) as YYYY.
const at = (key: string, b: Record<string, unknown>) => run("forward-events-covered", { ...base.brief, ...b }, { ...base.item, supplied_dates: [key] });
test("forward-events-covered: a month-precision date is covered by an events entry of that month and precision, by the month and year in a section, or by an omitted_events entry; the day alone does not cover it", () => {
  assert.equal(at("2031-02", {})?.rule, "forward-events-covered");
  assert.equal(at("2031-02", { events: ["2031-02"] }), null);
  assert.equal(at("2031-02", { events: ["2031-02-03"] })?.rule, "forward-events-covered");
  assert.equal(at("2031-02", { body: `${base.brief.body}

The step falls in February 2031.` }), null);
  assert.equal(at("2031-02", { omitted: [{ date: "2031-02-01", reason: "a meeting, not an event" }] }), null);
});
test("forward-events-covered: a year-precision date is covered by an events entry of that year and precision, by the year in a section, or by an omitted_events entry", () => {
  assert.equal(at("2031", {})?.rule, "forward-events-covered");
  assert.equal(at("2031", { events: ["2031"] }), null);
  assert.equal(at("2031", { events: ["2031-02"] })?.rule, "forward-events-covered");
  assert.equal(at("2031", { body: `${base.brief.body}

The review is due during 2031.` }), null);
  assert.equal(at("2031", { omitted: [{ date: "2031-01-01", reason: "a placeholder year" }] }), null);
});
