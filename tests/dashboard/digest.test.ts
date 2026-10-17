import assert from "node:assert/strict";
import { test } from "node:test";

import { readCounts, readDigest } from "@/features/dashboard/read/digest";
import { buildChangedRows, buildDueNextRows } from "@/features/dashboard/rows";

import { dashboardWorld, ID, NOW, ORG } from "./world.ts";

test("the digest: the nearest binding dates, the dated feed, one backfill, the changelog field; every row passes the read gate and the workspace's own archive", async () => {
  const db = dashboardWorld();
  const d = await readDigest(db.client, ORG);
  assert.equal(d.windowDays, 90, "the cadence is off, so the window is 90 days (rule 16)");
  assert.deepEqual(d.dueNext.map((r) => r.id), [ID.a, ID.b], "soonest binding date first: the deadline, then the timeline milestone");
  assert.deepEqual(d.feed.map((f) => [f.id, f.change_kind]).sort(), [[ID.a, "new"], [ID.b, "new"], [ID.e, "updated"]].sort(), "the unverified and the workspace-archived items are not in the feed");
  assert.deepEqual(d.candidates.map((c) => c.uuid).sort(), [ID.a, ID.b, ID.e].sort());
  assert.deepEqual(d.changelogField, { [ID.e]: "full_brief" });
  assert.equal(d.candidates.find((c) => c.uuid === ID.a)?.resource.sourceTier, 1, "the row carries its source's rating");
  assert.deepEqual(d.candidates.find((c) => c.uuid === ID.a)?.verticals, ["fine-art"]);
  assert.equal(d.lastChangelogDate, null, "read only when the feed is empty");
  assert.deepEqual(db.rpcCalls.find((c) => c.name === "get_workspace_recent_changes")?.args, { p_org_id: ORG, p_days: 90 });
  assert.equal(d.ratingsFailed, false);
});

test("the cards are built from the digest: the deadline is a Due-next row, an UPDATED item is labelled with its field, and a sector profile reorders the changes", async () => {
  const d = await readDigest(dashboardWorld().client, ORG);
  const due = buildDueNextRows(d.dueNext, NOW);
  assert.deepEqual(due.map((r) => [r.id, r.href, r.dueDays]), [[ID.a, `/regulations/${ID.a}`, 17], [ID.b, `/market/${ID.b}`, 61]]);
  const changed = buildChangedRows(d.feed, d.candidates, d.changelogField, NOW, { sectors: ["fine-art"] });
  assert.equal(changed[0]?.id, ID.a, "the fine-art change first for a fine-art workspace");
  const echo = changed.find((r) => r.id === ID.e);
  assert.deepEqual([echo?.isUpdated, echo?.updatedField], [true, "full_brief"]);
});

test("a window with a cadence is 7 days; an empty feed reads the newest changelog date and nothing else", async () => {
  const db = dashboardWorld();
  (db.rows("system_state")[0] as Record<string, unknown>).scrape_cadence = "weekly";
  const d = await readDigest(db.client, ORG);
  assert.equal(d.windowDays, 7);
  assert.deepEqual(d.feed.map((f) => f.id).sort(), [ID.a, ID.e].sort(), "the item added last week and the one updated five days ago; bravo (added in September) is outside 7 days");
  db.rows("intelligence_items").forEach((i) => (i.added_date = "2025-01-01"));
  db.rows("item_changelog").length = 0;
  db.seed("item_changelog", [{ id: "c9", item_id: ID.e, change_date: "2026-03-01", change_type: "UPDATED", field: "timeline", new_value: "b" }]);
  const empty = await readDigest(db.client, ORG);
  assert.deepEqual([empty.feed.length, empty.lastChangelogDate], [0, "2026-03-01"]);
});

test("INV-263: a failed read rejects the whole digest; an empty corpus is a real digest, not a failure", async () => {
  for (const fn of ["get_workspace_due_next", "get_workspace_recent_changes"]) {
    const db = dashboardWorld();
    db.rpcs[fn] = () => ({ error: { message: "denied" } });
    await assert.rejects(readDigest(db.client, ORG), new RegExp(`${fn} failed: denied`));
  }
  const backfill = dashboardWorld();
  backfill.fail("intelligence_items", "select", "down");
  await assert.rejects(readDigest(backfill.client, ORG), /backfill failed: down/);
  const changelog = dashboardWorld();
  changelog.fail("item_changelog", "select", "down");
  await assert.rejects(readDigest(changelog.client, ORG), /item_changelog read failed: down/);
  const empty = dashboardWorld();
  empty.tables.intelligence_items = [];
  const d = await readDigest(empty.client, ORG);
  assert.deepEqual([d.dueNext.length, d.feed.length, d.candidates.length], [0, 0, 0]);
});

test("a failed source-rating read leaves the rows without a tier and says so; it never invents one", async () => {
  const db = dashboardWorld();
  db.fail("sources", "select", "down");
  const d = await readDigest(db.client, ORG);
  assert.equal(d.ratingsFailed, true);
  assert.equal(d.dueNext.find((r) => r.id === ID.a)?.sourceTier, undefined);
});

test("the counts: the band tiles are the regulations surface's own tallies, the rail is the verified count per surface; one unknown count is a failure, never a zero", async () => {
  const db = dashboardWorld();
  const c = await readCounts(db.client, ORG);
  assert.deepEqual(c.regulations.byPriority, { CRITICAL: 1, HIGH: 0, MODERATE: 1, LOW: 0 }, "alpha and echo; delta is archived by this workspace, charlie is unverified");
  assert.deepEqual(c.surfaces, { regulations: 2, marketIntel: 1, research: 0, operations: 0 }, "verified counts: the unverified item is not a customer figure");
  assert.equal(c.aggregates.totalItems, 3);
  db.rpcs.get_all_surface_counts = () => ({ error: { message: "x" } });
  await assert.rejects(readCounts(db.client, ORG), /surface totals read failed/);
});
