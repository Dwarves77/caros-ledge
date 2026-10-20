import assert from "node:assert/strict";
import { test } from "node:test";

import { bandFromPriority, canonicalSurface, detailHref, pageSizes, toListRowFields, trimRemainder } from "@/core/lists";
import type { Resource } from "@/core/types";
import { navCountSources, readAggregates, readCategory, readListing, readRemainder, readSurfaceTotals } from "@/features/lists";
import { getNavCounts } from "@/ui/shell/nav-counts.server";

import { listDb } from "./list-db.ts";

const row = (id: string, over: Record<string, unknown> = {}) => ({ id, legacy_id: null, title: `Item ${id}`, item_type: "regulation", effective_priority: "HIGH", added_date: "2026-01-01", source_id: "s1", ...over });
const LISTINGS = "get_workspace_intelligence_listings" as const;
const PUBLIC = "get_workspace_intelligence_listings_public" as const;

test("INV-263: a failed listing RPC is `failed`, an empty corpus is not", async () => {
  const bad = listDb({ rpc: () => ({ error: { message: "boom" } }) });
  const r = await readListing(bad.db, { orgId: "o", rpc: LISTINGS, page: { offset: 0, limit: 60 } });
  assert.equal(r.failed, true);
  assert.deepEqual(r.rows, []);
  const empty = listDb({ rpc: () => ({ data: [] }) });
  const e = await readListing(empty.db, { orgId: "o", rpc: LISTINGS, page: { offset: 0, limit: 60 } });
  assert.equal(e.failed, false);
  assert.deepEqual(e.rows, []);
});

test("INV-263: a failed remainder page is a failure, never a short list", async () => {
  let page = 0;
  const { db } = listDb({ rpc: () => (page++ === 0 ? { data: [row("a")] } : { error: { message: "down" } }), from: () => ({ data: [] }) });
  const r = await readRemainder(db, { orgId: "o", rpc: LISTINGS, firstPageSize: 60, pageSize: 1 });
  assert.equal(r.failed, true);
  assert.deepEqual(r.rows, []);
});

test("the remainder ends on a short page and carries the first-page offset", async () => {
  const { db, calls } = listDb({ rpc: (_n, _a, range) => ({ data: range && range[0] === 60 ? [row("x"), row("y")] : [] }), from: () => ({ data: [] }) });
  const r = await readRemainder(db, { orgId: "o", rpc: LISTINGS, firstPageSize: 60, pageSize: 500 });
  assert.equal(r.failed, false);
  assert.deepEqual(r.rows.map((x) => x.id), ["x", "y"]);
  assert.deepEqual(calls.find((c) => c.kind === "rpc")?.range, [60, 559]);
});

test("the public listing uses the keyset cursor and ranges from zero; the org listing passes p_org_id and the domain", async () => {
  const pub = listDb({ rpc: () => ({ data: [] }) });
  await readListing(pub.db, { rpc: PUBLIC, page: { offset: 99, limit: 30, domain: 1, cursor: { offset: 60, afterPriority: "HIGH", afterAddedDate: "2026-01-01", afterId: "z" } } });
  const c = pub.calls[0]!;
  assert.deepEqual(c.range, [0, 29]);
  assert.deepEqual(c.args, { p_domain: 1, p_after_priority: "HIGH", p_after_added_date: "2026-01-01", p_after_id: "z" });
  const org = listDb({ rpc: () => ({ data: [] }) });
  await readListing(org.db, { orgId: "o1", rpc: LISTINGS, page: { offset: 60, limit: 30, domain: 2 } });
  assert.deepEqual(org.calls[0]!.args, { p_org_id: "o1", p_domain: 2 });
  assert.deepEqual(org.calls[0]!.range, [60, 89]);
});

test("INV-213: the tier on a row is customerTierOf the source (override, then effective, then base)", async () => {
  const { db } = listDb({
    rpc: () => ({ data: [row("a", { source_id: "s1" }), row("b", { source_id: "s2" }), row("c", { source_id: "s3" })] }),
    from: (table) => (table === "sources" ? { data: [{ id: "s1", name: "A", base_tier: 5, effective_tier: 4, tier_override: 2 }, { id: "s2", name: "B", base_tier: 5, effective_tier: null, tier_override: null }, { id: "s3", name: "C", base_tier: 99, effective_tier: null, tier_override: null }] } : { data: [] }),
  });
  const r = await readListing(db, { rpc: PUBLIC });
  assert.deepEqual(Object.fromEntries(r.rows.map((x) => [x.id, x.sourceTier])), { a: 2, b: 5, c: undefined });
  assert.equal(r.rows.find((x) => x.id === "c")?.sourceTier, undefined, "an out-of-vocabulary tier is never invented");
});

test("a failed source read leaves rows unrated and says so; a failed timeline chunk is counted", async () => {
  const { db } = listDb({ rpc: () => ({ data: [row("a")] }), from: (t) => (t === "sources" || t === "item_timelines" ? { error: { message: "x" } } : { data: [] }) });
  const r = await readListing(db, { rpc: PUBLIC });
  assert.equal(r.failed, false);
  assert.equal(r.enrichFailed, true);
  assert.equal(r.timelineFailures, 1);
  assert.equal(r.rows[0]?.sourceTier, undefined);
});

test("org-scoped reads return the org overrides for the rows read; a failed override read is null", async () => {
  const ok = listDb({ rpc: () => ({ data: [row("a", { legacy_id: "L1" })] }), from: (t) => (t === "workspace_item_overrides" ? { data: [{ item_id: "a", priority_override: "LOW", is_archived: false, archive_reason: null, archive_note: null, archived_at: null, dismissed_at: null, owner_user_id: "u" }] } : { data: [] }) });
  const r = await readListing(ok.db, { orgId: "o", rpc: LISTINGS });
  assert.deepEqual(r.overrides?.map((o) => [o.itemId, o.priorityOverride]), [["L1", "LOW"]]);
  const bad = listDb({ rpc: () => ({ data: [row("a")] }), from: (t) => (t === "workspace_item_overrides" ? { error: { message: "x" } } : { data: [] }) });
  assert.equal((await readListing(bad.db, { orgId: "o", rpc: LISTINGS })).overrides, null);
});

test("INV-263: counts return null on failure, never zeros; nav counts go blank, not 0", async () => {
  const bad = listDb({ rpc: () => ({ error: { message: "x" } }), from: () => ({ error: { message: "x" } }) });
  assert.equal(await readAggregates(bad.db, "o"), null);
  assert.equal(await readSurfaceTotals(bad.db, "o"), null);
  const nav = await getNavCounts(navCountSources(bad.db, { orgId: "o", userId: "u" }));
  assert.deepEqual(nav, { regulations: null, market: null, research: null, operations: null, watchlist: null, byPriority: null });
  const good = listDb({
    rpc: (n) => (n === "get_all_surface_counts" ? { data: { regulations: { verified: 3, total: 30 }, market: { verified: 4, total: 40 }, research: { verified: 5, total: 50 }, operations: { verified: 6, total: 60 } } } : { data: { total_items: 9, by_priority: { CRITICAL: 1, HIGH: 2 } } }),
    from: () => ({ data: null, count: 7 }),
  });
  const n = await getNavCounts(navCountSources(good.db, { orgId: "o", userId: "u" }));
  assert.deepEqual(n, { regulations: 3, market: 4, research: 5, operations: 6, watchlist: 7, byPriority: { CRITICAL: 1, HIGH: 2, MODERATE: 0, LOW: 0 } });
});

test("a category read pages under the cap and a failed page is a failure", async () => {
  const bad = listDb({ rpc: () => ({ error: { message: "x" } }) });
  assert.deepEqual(await readCategory(bad.db, "get_market_intel_items_public"), { resources: [], total: 0, failed: true });
  const ok = listDb({ rpc: () => ({ data: [row("m1")] }), from: () => ({ data: [] }) });
  const r = await readCategory(ok.db, "get_research_items_public");
  assert.equal(r.failed, false);
  assert.equal(r.total, 1);
});

test("the first page is sixty rows", () => {
  assert.equal(pageSizes.first, 60);
});

test("trimRemainder drops the fields a list row never draws (keys removed, not set undefined)", () => {
  const out = trimRemainder({ id: "a", title: "t", keyData: ["k"], reasoning: "r", fullBrief: "b", penaltyRange: "p" } as unknown as Resource);
  assert.deepEqual(out.keyData, []);
  assert.equal(out.reasoning, "");
  assert.equal("fullBrief" in out, false);
  assert.equal("penaltyRange" in out, false);
});

test("INV-265: an item detail href comes only from its raw type and domain; uncategorized goes to regulations", () => {
  assert.equal(canonicalSurface({ type: null, domain: null }), "regulations");
  assert.equal(canonicalSurface({ type: "uncertain", domain: null }), "regulations");
  assert.equal(detailHref({ id: "a b", type: null }), "/regulations/a%20b");
});

test("list row fields: impact is the stored score or null, never a keyword guess; due is the nearest future date", () => {
  const r = { id: "a", title: "T", priority: "HIGH", type: "regulation", modes: ["air"], complianceDeadline: "2026-12-01", timeline: [{ date: "2026-11-01", label: "x" }] } as unknown as Resource;
  const f = toListRowFields(r, new Date("2026-10-15T12:00:00Z"));
  assert.equal(f.impact, null);
  assert.equal(f.due?.days, "17 days");
  assert.equal(f.jurisdiction, "GLOBAL");
  assert.equal(bandFromPriority("nonsense").key, "awareness");
});
