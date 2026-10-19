// R2d addendum A (operator ruling 2026-10-20: items per source is at least 1 for every source once collected; fewer items than sources means uncollected, and the system must say so). The source_coverage view
// (migration 0092) is the one place coverage is computed; the dashboard ledger, the map's coverage card and the admin card read it. A page never states coverage from a count of sources alone.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

import { createElement, type ReactNode } from "react";

import { notCollected, readCollectedSourceIds, readSourceCoverage } from "@/core/derived/source-coverage";
import { MapPage } from "@/features/regulations/map/MapPage";
import { readRegionCoverage } from "@/features/regulations/map/region-coverage";

import { memoryDb, type Row } from "../_support/memory-db.ts";
import { STATED } from "../_support/page-sweep.ts";
import { renderApp, textOf } from "../_support/render.ts";
import { memberWorld } from "../_support/sweep-worlds.ts";

import registry from "./coverage.json" with { type: "json" };

const row = (n: number, state: string, over: Row = {}): Row => ({ source_id: `5000000${n}-0000-4000-8000-00000000000${n}`, items_count: state === "collected" ? 3 : 0, last_item_at: state === "collected" ? "2026-10-10T00:00:00Z" : null, last_capture_at: state === "uncollected" ? null : "2026-10-12T00:00:00Z", state, ...over });
const view = (): Row[] => [row(1, "collected"), row(2, "collected"), row(3, "uncollected"), row(4, "refused"), row(5, "access_requested")];

test("addendum A: the ledger reads the view's states; 'not yet collected' is every source that is not collected, from the rows, and the newest capture is the view's", async () => {
  const c = await readSourceCoverage(memoryDb({ source_coverage: view() }).db);
  assert.deepEqual(c.byState, { collected: 2, uncollected: 1, refused: 1, access_requested: 1 });
  assert.equal(c.total, 5);
  assert.equal(notCollected(c), 3);
  assert.equal(c.lastCaptureAt, "2026-10-12T00:00:00Z");
  const empty = await readSourceCoverage(memoryDb({ source_coverage: [] }).db);
  assert.deepEqual([empty.total, notCollected(empty), empty.lastCaptureAt], [0, 0, null]);
});

test("addendum A: a state the reader does not know, or a failed read, is a failure and never a smaller number", async () => {
  await assert.rejects(() => readSourceCoverage(memoryDb({ source_coverage: [...view(), row(6, "pending_review")] }).db), /another state/);
  await assert.rejects(() => readSourceCoverage(memoryDb({ source_coverage: view() }, { failures: [{ table: "source_coverage", op: "select", message: "relation public.source_coverage does not exist", code: "42P01" }] }).db), /does not exist|exact count failed/);
});

const drawn = async (render: () => Promise<ReactNode>): Promise<string> => textOf(renderApp((await render()) as never, { path: "/" }));
const dashboard = async () => (await import("@/features/dashboard/page")).default();

test("addendum A: the dashboard ledger states 'N sources not yet collected' from the view, not from a constant, and a refused read is a stated failure with Retry", async () => {
  const w = memberWorld();
  w.db.seed("source_coverage", view());
  const text = await drawn(dashboard);
  assert.match(text, /Source coverage/);
  assert.match(text, /2 of 5 sources collected/);
  assert.match(text, /3 sources not yet collected/);
  assert.match(text, /1 source refused automated access/);
  assert.match(text, /Access requested for 1 source/);
  const fewer = memberWorld();
  fewer.db.seed("source_coverage", [row(1, "collected"), row(2, "uncollected")]);
  assert.match(await drawn(dashboard), /1 of 2 sources collected\..*1 source not yet collected/, "the same card, other rows, other numbers");
  const refused = memberWorld();
  refused.failTable("source_coverage");
  const failed = await drawn(dashboard);
  assert.match(failed, /Source coverage did not load/);
  assert.match(failed, STATED);
  assert.doesNotMatch(failed, /sources? collected|not yet collected/);
});

const REGION = { id: "r", name: "R", jurisdictions: [{ iso: "AT", name: "Austria" }, { iso: "BE", name: "Belgium" }] };
const src = (id: string, jurisdictions: string[], types: string[] | null, name = "x", url = "https://x.example") => ({ id, name, url, jurisdictions, source_type: types, status: "active", admin_only: false });

test("surfaces:11 the map counts collected sources only and says how many it left out: a registered source that is not collected is not coverage, and one with no type is stated too", async () => {
  const A = "50000001-0000-4000-8000-000000000001";
  const B = "50000002-0000-4000-8000-000000000002";
  const C = "50000003-0000-4000-8000-000000000003";
  const D = "50000004-0000-4000-8000-000000000004";
  const m = memoryDb({
    sources: [src(A, ["AT"], ["environmental_body"]), src(B, ["AT"], ["legislature"]), src(C, ["BE"], ["legislature"]), src(D, ["BE"], null, "A page", "https://page.example")],
    source_coverage: [row(1, "collected", { source_id: A }), row(2, "collected", { source_id: B }), row(3, "uncollected", { source_id: C }), row(4, "collected", { source_id: D })],
  });
  const read = await readRegionCoverage(m.db);
  assert.equal(read.notCollected, 1, "C is registered but not collected");
  assert.equal(read.untyped, 1, "D is collected but nothing says what kind of source it is");
  const text = textOf(renderApp(createElement(MapPage, { items: [], coverage: { regions: [{ region: REGION, covered: 1, partial: 0, gap: 1, total: 2 }], notCollected: read.notCollected, untyped: read.untyped }, activeCodes: null })));
  assert.match(text, /1 source is not yet collected and 1 collected source has no type, so they are not counted/);
  assert.match(text, /1 of 2 covered/);
  const html = renderApp(createElement(MapPage, { items: [], coverage: { regions: [{ region: REGION, covered: 1, partial: 0, gap: 1, total: 2 }], notCollected: 0, untyped: 0 }, activeCodes: null }));
  assert.match(html, /aria-label="Filter map to R \(1 of 2 jurisdictions covered, 1 gaps\)"/, "the accessible name states the same quantity as the visible text");
  assert.deepEqual([...await readCollectedSourceIds(m.db)].sort(), [A, B, D]);
});

test("surfaces:11 a failed collection read leaves the region links and says no count is shown; it never draws an all-gap map", () => {
  const html = renderApp(createElement(MapPage, { items: [], coverage: null, activeCodes: null }));
  const text = textOf(html);
  assert.match(text, /coverage snapshot did not load, so no coverage count is shown/);
  assert.match(html, /href="\/map\?region=eu-members"/, "the region filters are still there");
  assert.doesNotMatch(text, /\d+ of \d+ covered/);
});

// ---- the structure test: no page computes coverage from a count of sources alone ----
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
const norm = (p: string): string => relative(".", p).replace(/\\/g, "/");
const globRe = (g: string): RegExp => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
const COVERAGE_FROM_SOURCES = (text: string): boolean => /\.from\(\s*["'`](?:sources|data_sources)["'`]\s*\)/.test(text) && /\bcover(?:ed|age)\b/i.test(text) && !/source_coverage/.test(text);

test("addendum A structure: a file that reads the sources table and speaks of coverage reads source_coverage; pipeline files are exempt by glob with a reason; nothing else is", () => {
  const exempt = (registry as { exempt: { glob: string; why: string }[] }).exempt.map((e) => ({ ...e, re: globRe(e.glob) }));
  const offenders = walk("src").map(norm).filter((f) => COVERAGE_FROM_SOURCES(readFileSync(f, "utf8")) && !exempt.some((e) => e.re.test(f)));
  assert.deepEqual(offenders, [], "coverage from a count of sources alone: read the source_coverage view (src/core/derived/source-coverage.ts)");
  const unused = exempt.filter((e) => !walk("src").map(norm).some((f) => e.re.test(f) && COVERAGE_FROM_SOURCES(readFileSync(f, "utf8")))).map((e) => e.glob);
  assert.deepEqual(unused, [], "an exempt glob that matches no such file is dead weight");
  assert.ok(COVERAGE_FROM_SOURCES('db.from("sources").select("id"); const covered = rows.length;'), "the planted violation is flagged");
  assert.ok(!COVERAGE_FROM_SOURCES('db.from("sources").select("id"); const covered = rows.length; /* source_coverage */'));
});
