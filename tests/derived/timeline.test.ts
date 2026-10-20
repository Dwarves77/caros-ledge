// R2d S1, flywheel:12 / 13 / 42: a date is drawn as exact as it was written. A year, a quarter or "early 2027" was stored as the period start and drawn "Jan 1, 2027 / 74 days" with an urgency band classified from a
// day nobody wrote (F:12); a bare "D Month YYYY" on a page was labelled "Published" (F:13); the pipeline's own captured and recorded dates entered the customer timeline as milestones (F:42). Each case first
// reproduces the register's wrong output in its comment, then asserts the right one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildTimelineRows, deriveTimeline, isInstrumentMilestone, timelineDateOf } from "@/core/brief/timeline";
import { dueInfo, toListRowFields } from "@/core/lists";
import type { Resource } from "@/core/types";
import { mapRows, type WorkspaceItemRpcRow } from "@/features/lists";

import { memoryDb } from "../_support/memory-db.ts";

const NOW = new Date("2026-10-20T12:00:00Z");
const entry = (date: string, label = "Entry into force") => ({ date, label, source: null });

test("F:12 the writer stores how exact each date is: a year, a quarter, early 2027 and a range are period starts; a day and a qualified day are days", () => {
  const { rows } = buildTimelineRows([entry("2027"), entry("Q3 2027", "Reporting"), entry("early 2027", "Consultation"), entry("30 June 2027", "Filing"), entry("by 31 December 2027", "Deadline"), entry("1 March 2027 to 30 June 2027", "Window"), entry("March 2027", "Guidance")], "2026-10-20");
  const byLabel = Object.fromEntries(rows.map((r) => [r.label.replace(/^.* — /, ""), r.date_precision]));
  assert.deepEqual(byLabel, { "Entry into force": "year", Reporting: "quarter", Consultation: "segment", Filing: "day", Deadline: "qualified", Window: "range", Guidance: "month" });
  // every precision the parser can produce is one the column's CHECK admits
  const sql = readFileSync("supabase/migrations/0094_item_timelines_date_precision.sql", "utf8");
  const admitted = /ARRAY\[([^\]]*)\]/.exec(sql)?.[1]?.match(/'([a-z]+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
  for (const precision of Object.values(byLabel)) assert.ok(admitted.includes(precision as string), `${precision} is admitted by the column CHECK`);
});

test("F:12 a reader hands a row the date at the precision it was written: the whole day for a day, the month for a month, the year for anything coarser, and never a day for a precision it does not know", () => {
  assert.equal(timelineDateOf("2027-01-01", "year"), "2027");
  assert.equal(timelineDateOf("2027-07-01", "quarter"), "2027");
  assert.equal(timelineDateOf("2027-03-01", "month"), "2027-03");
  assert.equal(timelineDateOf("2027-06-30", "day"), "2027-06-30");
  assert.equal(timelineDateOf("2027-12-31", "qualified"), "2027-12-31");
  assert.equal(timelineDateOf("2027-01-01", undefined), "2027", "an absent precision is not a day");
  assert.equal(timelineDateOf("2027-01-01", null), "2027");
});

const resource = (timeline: Resource["timeline"], over: Partial<Resource> = {}): Resource => ({ id: "r", cat: "ocean", sub: "", title: "T", url: "", note: "", type: "regulation", priority: "HIGH", added: "2026-01-01", reasoning: "", tags: [], whatIsIt: "", whyMatters: "", keyData: [], isArchived: false, modes: [], ...(timeline ? { timeline } : {}), ...over }) as Resource;

test("F:12 a year-only or month-only entry is not a due date: the register's probe drew 'Jan 1, 2027 / 74 days' and classified the band from it", () => {
  assert.equal(dueInfo(resource([{ date: "2027", label: "x" }]), NOW), null, "the probe: 74 days to 2027-01-01");
  assert.equal(dueInfo(resource([{ date: "2027-03", label: "x" }]), NOW), null);
  const day = dueInfo(resource([{ date: "2027", label: "x" }, { date: "2026-12-31", label: "Filing" }]), NOW);
  assert.equal(day?.daysNum, 72, "the stated day still counts, and the year beside it does not pull it earlier");
  assert.equal(toListRowFields(resource([{ date: "2027", label: "x" }]), NOW).due, null);
  assert.equal(dueInfo(resource([], { complianceDeadline: "2026-11-01" }), NOW)?.daysNum, 12, "the deadline column is a date column: it counts");
});

const rpcRow = (id: string): WorkspaceItemRpcRow => ({ id, legacy_id: null, title: `Item ${id}`, item_type: "regulation", effective_priority: "HIGH", priority: "HIGH", added_date: "2026-01-01", transport_modes: ["ocean"], effective_archived: false } as WorkspaceItemRpcRow);

test("F:12 and F:42 the list reader draws a year as a year, and the captured and recorded fallbacks, which say when the pipeline saw the item, are not milestones", async () => {
  const db = memoryDb({
    item_timelines: [
      { item_id: "i1", milestone_date: "2027-01-01", date_precision: "year", label: "2027 — Entry into force", is_completed: false, sort_order: 0 },
      { item_id: "i1", milestone_date: "2026-12-31", date_precision: "day", label: "Filing", is_completed: false, sort_order: 1 },
      { item_id: "i1", milestone_date: "2026-09-01", date_precision: "day", label: "Captured (source page retrieved on this date; not the instrument's own date)", is_completed: true, sort_order: 999 },
      { item_id: "i1", milestone_date: "2026-10-01", date_precision: "day", label: "Recorded in the ledger on this date; not the instrument's own date", is_completed: true, sort_order: 1000 },
    ],
  }).db;
  const { active } = await mapRows(db, [rpcRow("i1")]);
  assert.deepEqual(active[0]?.timeline, [{ date: "2027", label: "2027 — Entry into force" }, { date: "2026-12-31", label: "Filing" }]);
  assert.equal(isInstrumentMilestone(998), true);
  assert.equal(isInstrumentMilestone(999), false);
  assert.equal(dueInfo(active[0] as Resource, NOW)?.daysNum, 72);
});

test("F:13 a date the page introduces with a publication marker is labelled Published; a bare date is labelled for what it is, and a later effective date never becomes the publication date", () => {
  const dateline = (capturedText: string) => deriveTimeline({ title: "Guidance", capturedText }).result;
  const marked = dateline("Regulation (EU) 2026/1 enters into force on 1 January 2030.\nPublished 5 May 2026\nBody text.");
  assert.deepEqual([marked?.iso, marked?.baseLabel], ["2026-05-05", "Published (from the source page)"]);
  const bare = dateline("Amended by the Council on 3 March 2025.\nRegulation text follows.");
  assert.equal(bare?.iso, "2025-03-03");
  assert.equal(bare?.baseLabel, "Date found on the source page", "the old step called any bare date 'Published'");
  const tag = dateline('<h1>Guidance</h1><time datetime="2026-04-02T10:00:00Z">2 April</time> and 1 January 2030');
  assert.deepEqual([tag?.iso, tag?.baseLabel], ["2026-04-02", "Published (from the source page)"]);
  const derived = deriveTimeline({ title: "Guidance", capturedText: "Effective 1 January 2030. Published 5 May 2026.", bestCapture: { searched_at: "2026-10-01T00:00:00Z" } });
  assert.equal(derived.result?.baseLabel, "Published (from the source page)");
  assert.equal(deriveTimeline({ title: "Guidance", capturedText: "Last amended 3 March 2025." }).result?.baseLabel, "Date found on the source page");
});

test("migration 0094 reads the precision back from the token the old writer put in a label, with the same shapes the writer produces", () => {
  const sql = readFileSync("supabase/migrations/0094_item_timelines_date_precision.sql", "utf8");
  for (const shape of ["year", "quarter", "half", "segment", "month", "range", "qualified"]) assert.ok(sql.includes(`THEN '${shape}'`), `the backfill reads ${shape}`);
  assert.match(sql, /NOT NULL DEFAULT 'day'/);
});
