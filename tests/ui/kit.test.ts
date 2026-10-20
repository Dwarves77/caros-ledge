import assert from "node:assert/strict";
import { test } from "node:test";

import { biasChips } from "@/core/sources";
import { customerTierOf } from "@/core/sources";
import { NEEDS_PHRASE, pickAbsenceReason, type AbsenceReason } from "@/ui/absence-reason";
import { SOURCE_TIER_MAX as TIER_MAX } from "@/core/sources";
import { clampTier } from "@/ui/tier";
import { isImpactScored, rampColor, segmentFilled, SEGMENT_GROUPS } from "@/ui/impact";
import { classifyMilestones, classifyTimelineEntries, collapseTimeline, formatDayMonthYear, greenPercent, nextMilestoneClause, timelineHeaderCounts } from "@/ui/timeline-math";
import { relativeTimeLabel, stableDateLabel } from "@/ui/relative-time";
import { weekOfIso } from "@/ui/iso-week";
import { clampIndex, trapIndex, wrapIndex } from "@/ui/focus";
import { sixWordHeadline, withClaimTiers, type FactCardModel } from "@/ui/claim-tier";
import { moveActiveIndex, resolveEnterKeyAction, runSearch } from "@/ui/shell/command-bar";

test("INV-216: pickAbsenceReason precedence, and the three banned words never render", () => {
  assert.equal(pickAbsenceReason(["pending", "not in primary source", "connect data"]), "connect data");
  assert.equal(pickAbsenceReason(["pending", "not in primary source"]), "not in primary source");
  assert.equal(pickAbsenceReason(["pending"]), "pending");
  assert.equal(pickAbsenceReason([null, undefined]), null);
  assert.equal(pickAbsenceReason(["unscored"]), null, "unscored has no slot in the precedence");
  for (const reason of Object.keys(NEEDS_PHRASE) as AbsenceReason[]) assert.doesNotMatch(NEEDS_PHRASE[reason], /\b(pending|unscored|not scored)\b/i);
});

test("INV-214: bias chips mark lower confidence below 0.80 (0.79 yes, 0.80 no), top by confidence, bounded", () => {
  const d = biasChips([{ dimension: "funding", tag: "government", confidence: 0.79 }, { dimension: "methodology", tag: "peer-reviewed", confidence: 0.8 }], 2);
  const by = Object.fromEntries(d.shown.map((c) => [c.tag, c.lowerConfidence]));
  assert.deepEqual(by, { government: true, "peer-reviewed": false });
  const many = biasChips(Array.from({ length: 5 }, (_, i) => ({ dimension: "funding", tag: `t${i}`, confidence: 0.7 + i / 100 })), 2);
  assert.equal(many.shown.length, 2);
  assert.equal(many.remaining, 3);
  assert.deepEqual(biasChips(null).shown, []);
});

test("INV-213: one tier ceiling; a tier past it clamps to it (T8 shows T7), and customerTierOf rejects an out-of-vocabulary tier", () => {
  assert.equal(clampTier(TIER_MAX + 1), TIER_MAX);
  assert.equal(clampTier(0), 1);
  assert.equal(clampTier(2.4), 2);
  assert.equal(customerTierOf({ tier_override: 2, base_tier: 5 }), 2);
  assert.equal(customerTierOf({ tier_override: null, effective_tier: null, base_tier: 5 }), 5);
  assert.equal(customerTierOf({ base_tier: TIER_MAX + 1 }), null);
});

test("impact ramp: the stops, the brief worked examples at 3, 5 and 9, and the segment fill", () => {
  assert.equal(rampColor(1), "#16A34A");
  assert.equal(rampColor(4), "#CA8A04");
  assert.equal(rampColor(7), "#F97316");
  assert.equal(rampColor(12), "#DC2626");
  assert.equal(rampColor(3), "#8E921B");
  assert.equal(rampColor(5), "#DA820A");
  assert.equal(rampColor(9), "#ED541C");
  assert.equal(rampColor(0), rampColor(1));
  assert.equal(rampColor(99), rampColor(12));
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => segmentFilled(3, i)), [true, true, true, false, false]);
  assert.equal(SEGMENT_GROUPS.length, 4);
  assert.equal(SEGMENT_GROUPS.flat().length, 12);
  assert.equal(isImpactScored({ cost: 0, compliance: 0, client: 0, operational: 0 }), false);
  assert.equal(isImpactScored({ cost: 0, compliance: 1, client: 0, operational: 0 }), true);
  assert.equal(isImpactScored(null), false);
});

test("timeline classification with and without an explicit current; collapse; green extent", () => {
  const e = (date: string, status?: "past" | "current" | "future") => ({ date, label: date, ...(status ? { status } : {}) });
  assert.deepEqual(classifyTimelineEntries([e("2026-01-01", "past"), e("2026-02-01"), e("2026-03-01")]).map((c) => c.state), ["passed", "next", "ahead"]);
  assert.deepEqual(classifyTimelineEntries([e("2026-01-01", "past"), e("2026-02-01"), e("2026-03-01", "current")]).map((c) => c.state), ["passed", "ahead", "next"]);
  assert.deepEqual(classifyTimelineEntries([e("2026-01-01", "past")]).map((c) => c.state), ["passed"]);
  const nine = classifyMilestones(Array.from({ length: 9 }, (_, i) => e(`2026-0${(i % 9) + 1}-01`, i < 3 ? "past" : undefined)));
  const c = collapseTimeline(nine);
  assert.equal(c.collapsed, true);
  assert.equal(c.visible.length, 4);
  assert.equal(c.visible[0]?.state, "next");
  assert.equal(c.hiddenCount, 5);
  assert.equal(collapseTimeline(nine.slice(0, 4)).collapsed, false);
  assert.equal(greenPercent(["passed", "next", "ahead"]), 50);
  assert.equal(greenPercent(["passed", "passed"]), 100);
  assert.equal(greenPercent(["ahead", "ahead"]), 0);
  assert.deepEqual(timelineHeaderCounts(nine), { total: 9, passed: 3, nextDate: "2026-04-01" });
});

test("the timeline reads no clock: the next-milestone clause depends only on nowIso", () => {
  const real = Date.now;
  Date.now = () => {
    throw new Error("the clock was read");
  };
  try {
    const m = classifyMilestones([{ date: "2026-11-01", label: "Filing due" }]);
    assert.equal(nextMilestoneClause(m, "2026-10-15"), "Filing due · 1 Nov 2026 · in 17 days");
    assert.equal(nextMilestoneClause(m, "2026-11-03"), "Filing due · 1 Nov 2026 · 2 days ago");
    assert.equal(formatDayMonthYear("2026-03"), "Mar 2026");
    assert.equal(formatDayMonthYear("nonsense"), "nonsense");
    assert.equal(nextMilestoneClause(classifyMilestones([{ date: "2026-01-01", label: "x", status: "past" }]), "2026-10-15"), null);
  } finally {
    Date.now = real;
  }
});

test("stableDateLabel does not depend on Date.now; relativeTimeLabel takes its clock", () => {
  const real = Date.now;
  Date.now = () => {
    throw new Error("the clock was read");
  };
  try {
    assert.equal(stableDateLabel("2026-03-04T23:59:00Z"), "Mar 4, 2026");
    assert.equal(stableDateLabel("nope"), "");
    assert.equal(relativeTimeLabel("2026-03-04T12:00:00Z", Date.parse("2026-03-04T12:05:00Z")), "5 min ago");
    assert.equal(relativeTimeLabel("2026-03-04T12:00:00Z", Date.parse("2026-03-04T15:00:00Z")), "3 hrs ago");
    assert.equal(relativeTimeLabel("2026-03-04T12:00:00Z", Date.parse("2026-03-06T12:00:00Z")), "2 days ago");
    assert.equal(relativeTimeLabel("2026-01-01T00:00:00Z", Date.parse("2026-03-06T12:00:00Z")), "2 mo ago");
  } finally {
    Date.now = real;
  }
});

test("the ISO week across a UTC Monday boundary, in two browser timezones", () => {
  for (const tz of ["UTC", "Pacific/Auckland", "America/Los_Angeles"]) {
    process.env.TZ = tz;
    assert.equal(weekOfIso("2026-01-04T23:59:59Z"), 1, tz);
    assert.equal(weekOfIso("2026-01-05T00:00:00Z"), 2, tz);
    assert.equal(weekOfIso("2026-10-15T09:00:00Z"), 42, tz);
  }
  process.env.TZ = "UTC";
});

test("focus helpers: Tab trap wraps, roving wraps, listbox clamps", () => {
  assert.equal(trapIndex(3, 2, false), 0);
  assert.equal(trapIndex(3, 0, true), 2);
  assert.equal(trapIndex(3, -1, false), 0);
  assert.equal(trapIndex(3, -1, true), 2);
  assert.equal(trapIndex(0, -1, false), -1);
  assert.equal(wrapIndex(4, 3, 1), 0);
  assert.equal(wrapIndex(4, 0, -1), 3);
  assert.equal(clampIndex(4, 3, 1), 3);
  assert.equal(clampIndex(4, 0, -1), 0);
  assert.equal(moveActiveIndex(-1, 1, 3), 0);
  assert.equal(moveActiveIndex(-1, -1, 3), 2);
  assert.equal(moveActiveIndex(2, 1, 3), 2);
  assert.equal(moveActiveIndex(0, -1, 3), 0);
  assert.equal(moveActiveIndex(-1, 1, 0), -1);
});

test("the command bar: Enter opens results, Enter on an option opens it, Cmd or Ctrl Enter asks", () => {
  assert.equal(resolveEnterKeyAction(false, -1), "open-results");
  assert.equal(resolveEnterKeyAction(false, 2), "navigate-active");
  assert.equal(resolveEnterKeyAction(true, 2), "ask");
});

test("INV-263: a failed search says it failed; it is never an empty result", async () => {
  const res = (ok: boolean, body: unknown) => async () => ({ ok, json: async () => body }) as unknown as Response;
  assert.deepEqual(await runSearch(res(false, {}), "carbon"), { phase: "failed" });
  assert.deepEqual(await runSearch(async () => Promise.reject(new Error("offline")), "carbon"), { phase: "failed" });
  assert.deepEqual(await runSearch(res(true, { nope: 1 }), "carbon"), { phase: "failed" });
  assert.deepEqual(await runSearch(res(true, { results: [] }), "carbon"), { phase: "ok", rows: [] });
});

test("claim tiers: exact and contained matches, an ambiguous card gets no tier, record-grade cards are untouched", () => {
  const long = "The regulation applies to all vessels above 5,000 gross tonnage from 1 January 2027.";
  const map = { [`[scope] ${long}`]: { tier: 2, sourceName: "IMO", sourceUrl: "https://imo.org/x" }, "A different claim that is long enough to match nothing here at all.": { tier: 4, sourceName: "Press", sourceUrl: null } };
  const tierOf = (text: string, tiers: Record<string, { tier: number; sourceName: string; sourceUrl: string | null }>) => withClaimTiers({ kind: "SCOPE", claim: [{ text }] } as FactCardModel, tiers).provenance?.tier ?? null;
  assert.equal(tierOf(long, map), 2);
  assert.equal(tierOf("short", map), null);
  const clash = { a: { tier: 2, sourceName: "A", sourceUrl: null }, b: { tier: 3, sourceName: "B", sourceUrl: null } };
  const text = "Both entries contain this same long enough sentence for containment.";
  assert.equal(tierOf(text, { [text]: clash.a, [`${text} extra`]: clash.b }), null);
  const model: FactCardModel = { kind: "SCOPE", claim: [{ text: long }] };
  assert.equal(withClaimTiers(model, map).provenance?.tier, 2);
  assert.equal(withClaimTiers({ ...model, kind: "ANALYTICAL INFERENCE" }, map).provenance, undefined);
  assert.equal(withClaimTiers({ ...model, recordGrade: true }, map).provenance, undefined);
  assert.equal(sixWordHeadline("one two three four five six seven eight"), "one two three four five six");
});
