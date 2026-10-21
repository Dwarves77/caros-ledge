// LIST-SETTLE-1: a list never draws a partial count as a total (INV-LS-1, INV-LS-2) and its remainder is read together (INV-LS-3).
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";

import type { Resource } from "@/core/types";
import { readRemainder, type WorkspaceAggregates } from "@/features/lists";
import { RegulationsLedger } from "@/features/regulations/RegulationsLedger";

import { renderApp, textOf } from "../_support/render.ts";

import { listDb } from "./list-db.ts";

const NOW = "2026-10-15T00:00:00Z";
const first = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, uuid: `00000000-0000-4000-8000-00000000000${i}`, cat: "air", sub: "", title: `Reg ${i}`, url: "", note: "", type: "regulation", priority: "MODERATE", added: "2026-01-01", reasoning: "", tags: [], whatIsIt: "", whyMatters: "", keyData: [], modes: ["air"], timeline: [] }) as unknown as Resource & { uuid: string | null });
const agg = (over: Partial<WorkspaceAggregates> = {}): WorkspaceAggregates => ({ totalItems: 1002, byPriority: { CRITICAL: 12, HIGH: 40, MODERATE: 700, LOW: 250 }, byStatus: {}, byJurisdiction: { eu: 600, us: 402 }, totalJurisdictions: 2, lastUpdatedAt: null, ...over });
const draw = (aggregates: WorkspaceAggregates | null, hasMore: boolean, search = "") => renderApp(createElement(RegulationsLedger, { initial: first(5), aggregates, hasMore, nowIso: NOW, chips: [], rail: null }), { path: "/regulations", search });

test("INV-LS-1: with the rest loading and the counts known, the band draws the corpus total, never the five rows in hand", () => {
  const html = draw(agg(), true);
  const text = textOf(html);
  assert.match(text, /showing 5 of 700/);
  assert.match(text, /All 700 monitor/);
  assert.doesNotMatch(text, /of 5\b|All 5\b|\b5 active|\b5 regulations\b/, "no partial count drawn as a total");
  assert.match(text, /1,002 active/);
  assert.match(html, /data-list-state="loading"/);
  const facet = html.match(/data-audit="facet-mode".*?<\/div><\/div>/s)?.[0] ?? "";
  assert.match(facet, /cl-facet-count"><\/span>/, "a facet the corpus counts cannot answer is drawn without a count");
});

test("INV-LS-1: a filter the corpus counts cannot answer draws no total while the rest loads", () => {
  const text = textOf(draw(agg(), true, "mode=air"));
  assert.match(text, /showing 5 · loading the rest/);
  assert.doesNotMatch(text, /All \d|\d active/);
});

test("INV-LS-2: with the rest loading and no counts, the band says it is loading: no All N button and no number after showing N", () => {
  const html = draw(null, true);
  const text = textOf(html);
  assert.match(text, /showing 5 · loading the rest/);
  assert.doesNotMatch(text, /All \d/);
  assert.doesNotMatch(text, /showing 5 of/);
  assert.doesNotMatch(text, /5 active|5 shown, the list is longer/);
});

test("a list with no remainder is idle and draws its own rows as the whole", () => {
  const html = draw(null, false);
  assert.match(html, /data-list-state="idle"/);
  assert.match(textOf(html), /showing 5 of 5/);
});

const row = (id: string) => ({ id, legacy_id: null, title: `Item ${id}`, item_type: "regulation", effective_priority: "HIGH", added_date: "2026-01-01", domain: 1 });
const LISTINGS = "get_workspace_intelligence_listings" as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A listing database whose pages answer after a delay (the first remainder page last), recording the offsets in the order they started and how many pages were in flight at once. */
function timed(pageRows: (from: number) => unknown[]) {
  const inner = listDb({ rpc: (_n, _a, range) => ({ data: range ? pageRows(range[0]) : [] }), from: () => ({ data: [] }) }).db as never as { rpc: (n: string, a: unknown) => { range: (a: number, b: number) => Promise<unknown> }; from: unknown };
  const started: number[] = [];
  let inFlight = 0;
  let max = 0;
  const db = {
    ...inner,
    from: (t: string) => (inner.from as (t: string) => unknown).call(inner, t),
    rpc: (name: string, args: Record<string, unknown>) => {
      const q = inner.rpc(name, args);
      return {
        range: async (a: number, b: number) => {
          started.push(a);
          max = Math.max(max, ++inFlight);
          await sleep(a === 2 ? 40 : 5);
          const r = await q.range(a, b);
          inFlight -= 1;
          return r;
        },
      };
    },
  };
  return { db: db as never, started, max: () => max };
}

test("INV-LS-3: with the total, the remainder's pages are read together and the rows come back in offset order, and a total that is too small drops no row", async () => {
  const pages = (from: number) => (from < 10 ? [row(`x${from}`), row(`y${from}`)] : []);
  const withTotal = timed(pages);
  const r = await readRemainder(withTotal.db, { orgId: "o", rpc: LISTINGS, firstPageSize: 2, pageSize: 2, total: 8 });
  assert.equal(r.failed, false);
  assert.deepEqual(r.rows.map((x) => x.id), ["x2", "y2", "x4", "y4", "x6", "y6", "x8", "y8"], "offset order though the first page answered last");
  assert.equal(withTotal.max(), 3, "the three pages the total calls for were in flight together");
  assert.deepEqual(withTotal.started.slice(0, 3), [2, 4, 6]);

  const tooSmall = timed(pages);
  const t = await readRemainder(tooSmall.db, { orgId: "o", rpc: LISTINGS, firstPageSize: 2, pageSize: 2, total: 6 });
  assert.deepEqual(t.rows.map((x) => x.id), ["x2", "y2", "x4", "y4", "x6", "y6", "x8", "y8"], "the walk continues past a total that was too small");

  const walked = timed(pages);
  await readRemainder(walked.db, { orgId: "o", rpc: LISTINGS, firstPageSize: 2, pageSize: 2 });
  assert.equal(walked.max(), 1, "without a total the walk is one page at a time");
});
