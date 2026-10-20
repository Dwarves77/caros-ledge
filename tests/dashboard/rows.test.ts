import assert from "node:assert/strict";
import { test } from "node:test";

import type { Resource } from "@/core/types";
import { buildChangedRows, buildDueNextRows, briefCardState, changeRowPrefix, computeAuditDate, deriveBriefTitle, dueNextWindowLabel, firstTokenOf, recentChangesWindowDays, selectBriefResources, type Candidate, type FeedRow } from "@/features/dashboard/rows";

const NOW = new Date("2026-10-15T12:00:00.000Z");
/** The brief reads at most this many distinct change ids in full (the window is a product number, written here once as the test's oracle). */
const CANDIDATE_WINDOW = 48;
const item = (id: string, over: Partial<Resource> = {}): Resource => ({ id, title: `Title ${id}`, type: "regulation", domain: 1, priority: "HIGH", jurisdiction: "eu", modes: ["ocean"], topic: "emissions", tags: [], timeline: [], ...over }) as unknown as Resource;
const feed = (id: string, over: Partial<FeedRow> = {}): FeedRow => ({ id, legacy_id: null, title: `Title ${id}`, priority: "HIGH", effective_priority: "HIGH", added_date: "2026-10-14", change_kind: "new", change_date: "2026-10-14", ...over });
const cand = (id: string, over: Partial<Resource> = {}, verticals: string[] = []): Candidate => ({ uuid: id, resource: item(id, over), verticals });

test("buildDueNextRows: nearest binding date first, an item with no future date is not a row, the cap holds, and each row carries its own day count", () => {
  const rows = buildDueNextRows([item("far", { complianceDeadline: "2027-03-01" }), item("none"), item("near", { complianceDeadline: "2026-10-20" }), item("past", { complianceDeadline: "2026-01-01" }), item("tl", { timeline: [{ date: "2026-10-16", label: "x" }] })], NOW, 3);
  assert.deepEqual(rows.map((r) => [r.id, r.dueDays]), [["tl", 1], ["near", 5], ["far", 137]]);
  assert.equal(rows[0]?.href, "/regulations/tl", "every row links to its surface");
});

test("buildDueNextRows: the surface comes from the item's type and domain, never from the page it is drawn on", () => {
  const rows = buildDueNextRows([item("m", { type: "market_signal", domain: 2, complianceDeadline: "2026-11-01" }), item("o", { type: "regional_data", domain: 3, complianceDeadline: "2026-11-02" })], NOW);
  assert.deepEqual(rows.map((r) => r.href), ["/market/m", "/operations/o"]);
});

test("selectBriefResources counts DISTINCT ids: a feed that repeats an id never leaves the cards short (B-1985)", () => {
  const repeated = [...Array.from({ length: 10 }, () => feed("a")), ...Array.from({ length: 100 }, (_, i) => feed(`id${i}`))];
  const sel = selectBriefResources(["d1", "d1", "d2"], repeated);
  assert.deepEqual(sel.dueIds, ["d1", "d2"]);
  assert.equal(sel.changeIds.length, CANDIDATE_WINDOW);
  assert.equal(sel.changeIds[0], "a");
  assert.equal(new Set(sel.changeIds).size, CANDIDATE_WINDOW, "every id in the window is distinct");
});

test("buildChangedRows: de-duplicated, ranked by the urgency composite with the feed order breaking ties, capped, NEW or UPDATED never both", () => {
  const f = [feed("low", { priority: "LOW", effective_priority: "LOW" }), feed("crit", { priority: "CRITICAL", effective_priority: "CRITICAL" }), feed("crit", { priority: "CRITICAL" }), feed("up", { change_kind: "updated", change_date: "2026-10-13" }), feed("same")];
  const c = [cand("low", { priority: "LOW" }), cand("crit", { priority: "CRITICAL" }), cand("up", { priority: "HIGH" }), cand("same", { priority: "HIGH" })];
  const rows = buildChangedRows(f, c, { up: "timeline" }, NOW, {}, 3);
  assert.deepEqual(rows.map((r) => r.id), ["crit", "up", "same"], "ranked by priority, the feed order between equals; the duplicate and the lowest drop");
  assert.deepEqual(rows.map((r) => [r.isNew, r.isUpdated]), [[true, false], [false, true], [true, false]]);
  assert.equal(rows[1]?.updatedField, "timeline");
  assert.equal(rows[1]?.changeDate, "2026-10-13");
});

test("buildChangedRows: the workspace's sectors and jurisdiction weights change the ranking; an item the read gate did not return is not drawn", () => {
  const f = [feed("eu"), feed("art"), feed("ghost")];
  const c = [cand("eu", { priority: "HIGH" }, ["mining-minerals"]), cand("art", { priority: "HIGH" }, ["fine-art"])];
  assert.deepEqual(buildChangedRows(f, c, {}, NOW).map((r) => r.id), ["eu", "art"], "without a profile the feed order stands, and the ghost (no full row) is absent");
  assert.deepEqual(buildChangedRows(f, c, {}, NOW, { sectors: ["fine-art"] }).map((r) => r.id), ["art", "eu"], "a fine-art workspace sees the fine-art change first");
});

test("changeRowPrefix names the kind and the field; dueNextWindowLabel says how far the rows reach", () => {
  assert.equal(changeRowPrefix({ isNew: true }), "New");
  assert.equal(changeRowPrefix({ isUpdated: true, updatedField: "timeline", changeDate: "2026-10-13" }), "Updated · timeline added Oct 13, 2026");
  assert.equal(changeRowPrefix({ isUpdated: true }), "Updated · brief updated");
  assert.equal(changeRowPrefix({}), null);
  const rows = buildDueNextRows([item("a", { complianceDeadline: "2026-10-16" }), item("b", { complianceDeadline: "2026-11-30" })], NOW);
  assert.equal(dueNextWindowLabel(rows.slice(0, 1), "Oct 15"), "By next binding date · week of Oct 15");
  assert.match(dueNextWindowLabel(rows, "Oct 15"), /, reaching to /);
});

test("briefCardState: no rows because the read failed is not 'nothing changed'", () => {
  assert.deepEqual([briefCardState(2, true), briefCardState(0, true), briefCardState(0, false)], ["rows", "failed", "empty"]);
});

test("computeAuditDate: the newest change date of the rows, else the changelog's, else empty; it is never today", () => {
  assert.equal(computeAuditDate([{ changeDate: "2026-10-01" }, { changeDate: "2026-10-09" }, { changeDate: null }], "2026-03-01"), "2026-10-09");
  assert.equal(computeAuditDate([], "2026-03-01"), "2026-03-01");
  assert.equal(computeAuditDate([], null), "");
});

test("rule 16: the What-changed window is 90 days while the cadence is off or unknown, 7 with a cadence", () => {
  assert.deepEqual(["off", null, undefined, "weekly", "monthly"].map(recentChangesWindowDays), [90, 90, 90, 7, 7]);
});

test("the brief title: the first name, else the workspace, else a stated default; an e-mail local part is a usable first name", () => {
  assert.equal(deriveBriefTitle("Pat", "Acme"), "PAT'S BRIEF");
  assert.equal(deriveBriefTitle(null, "Acme Freight"), "ACME FREIGHT");
  assert.equal(deriveBriefTitle(null, ""), "YOUR BRIEF");
  assert.equal(firstTokenOf("Pat Lee"), "Pat");
  assert.equal(firstTokenOf("pat@example.invalid"), "pat");
  assert.equal(firstTokenOf("  "), null);
  assert.equal(firstTokenOf(null), null);
});
