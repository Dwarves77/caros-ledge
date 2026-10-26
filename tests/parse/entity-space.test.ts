// PARSE-FIX-1: HTML whitespace entities read as a space by the formal matchers; the stored text and the stored quote are never rewritten. kW is a statutory unit.
import assert from "node:assert/strict";
import { test } from "node:test";

import { stated } from "@/core/brief/rules/stored-date-stated";
import { locateSpan } from "@/core/contracts/verbatim";
import { findFigures, foldHtmlSpace, isFigure, statutoryUnit, tryParseDateAt } from "@/core/parse";

const QUOTE = "by 1&nbsp;January&nbsp;2025 and 45&nbsp;% of the fleet, 3&#160;600&#xA0;kW, 2 800 kW";

test("the date grammar and stated() read the entity forms as spaces; the quote text is unchanged", () => {
  assert.equal(tryParseDateAt(QUOTE, QUOTE.indexOf("1&nbsp;"))?.iso, "2025-01-01");
  assert.equal(stated(QUOTE, "2025-01-01"), true);
  assert.equal(stated(QUOTE, "2025-01-02"), false);
  assert.ok(QUOTE.includes("1&nbsp;January&nbsp;2025"));
});

test("findFigures on the folded slice reads 45 pct and the kW figures", () => {
  const got = findFigures(foldHtmlSpace(QUOTE)).flatMap((h) => (isFigure(h.result) ? [`${h.result.value} ${h.result.unit}`] : []));
  assert.ok(got.includes("45 pct"), got.join("|"));
  assert.ok(got.includes("2800 kW"), got.join("|"));
  assert.equal(findFigures(QUOTE).some((h) => isFigure(h.result) && h.result.unit === "pct"), false, "unfolded text keeps the entity: the fold is the matcher's, not the capture's");
});

test("kW is a statutory unit of kind power", () => {
  assert.equal(statutoryUnit("kW"), "kW");
  assert.equal(statutoryUnit("kilowatts"), "kW");
  assert.equal(statutoryUnit("MW"), "MW");
});

test("locateSpan finds a quote typed with spaces and returns the capture's own slice", () => {
  const capture = "x 1&nbsp;January&nbsp;2025 y";
  assert.equal(locateSpan(capture, "1 January 2025"), "1&nbsp;January&nbsp;2025");
});
