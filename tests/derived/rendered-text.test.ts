// INV-R2d-4 (the rendered half) and INV-R2d-1: every page of the sweep is drawn healthy and once per refused read; the text a reader sees carries none of the banned shapes (customer-strings.json), and the driver's own
// message (the sweep refuses every read with the words "refused by the page sweep") never appears in any draw. A shape a page still carries is on the file's `owed` list with its owner; the test fails when an owed shape
// is gone and when a new one appears.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReactNode } from "react";

import { renderApp, textOf } from "../_support/render.ts";
import { memberWorld } from "../_support/sweep-worlds.ts";

import table from "./customer-strings.json" with { type: "json" };

const SHAPES = (table as { shapes: { id: string; re: string }[] }).shapes.map((s) => ({ id: s.id, rx: new RegExp(s.re, "i") }));
const drawn = async (path: string, render: () => Promise<ReactNode>): Promise<string> => textOf(renderApp((await render()) as never, { path }));
const m = (path: string) => import(path);

const PAGES: { name: string; draw: () => Promise<string> }[] = [
  { name: "/", draw: () => drawn("/", async () => (await m("@/features/dashboard/page")).default()) },
  { name: "/watchlist", draw: () => drawn("/watchlist", async () => (await m("@/features/watchlist/page")).default()) },
  { name: "/search", draw: () => drawn("/search", async () => (await m("@/features/search/page")).default({ searchParams: Promise.resolve({ q: "fuel" }) })) },
  { name: "/regulations", draw: () => drawn("/regulations", async () => (await m("@/features/regulations/pages")).RegulationsIndex()) },
  { name: "/market", draw: () => drawn("/market", async () => (await m("@/features/market/page")).default()) },
  { name: "/research", draw: () => drawn("/research", async () => (await m("@/features/research/page")).ResearchRoute()) },
  { name: "/operations", draw: () => drawn("/operations", async () => (await m("@/features/operations/page")).OperationsRoute()) },
  { name: "/regulations/register", draw: () => drawn("/regulations/register", async () => (await m("@/features/regulations/pages")).ObligationRegisterRoute()) },
  { name: "/market/series", draw: () => drawn("/market/series", async () => (await m("@/features/market/series-page")).default()) },
  { name: "/regulations/[slug]", draw: () => drawn("/regulations/o3", async () => (await m("@/features/regulations/pages")).RegulationDetailRoute({ params: Promise.resolve({ slug: "o3" }) })) },
  { name: "/market/[slug]", draw: () => drawn("/market/m1", async () => (await m("@/features/market/detail-page")).MarketDetailRoute({ params: Promise.resolve({ slug: "m1" }) })) },
  { name: "/research/[slug]", draw: () => drawn("/research/r1", async () => (await m("@/features/research/detail-page")).ResearchDetailRoute({ params: Promise.resolve({ slug: "r1" }) })) },
  { name: "/operations/[slug]", draw: () => drawn("/operations/o1", async () => (await m("@/features/operations/detail-page")).OperationsDetailRoute({ params: Promise.resolve({ slug: "o1" }) })) },
];

const SNIPPETS = new Map<string, string>();
const shapesIn = (text: string, where = ""): string[] => SHAPES.filter((s) => s.rx.test(text)).map((s) => { const hit = s.rx.exec(text); SNIPPETS.set(`${where} ${s.id}`, text.slice(Math.max(0, (hit?.index ?? 0) - 60), (hit?.index ?? 0) + 80)); return s.id; });

test("INV-R2d-4 / INV-R2d-1: every swept page, healthy and with each read refused, carries no entity, status token, ISO timestamp, driver message, migration number, pipeline word or column name", async () => {
  const found = new Set<string>();
  for (const page of PAGES) {
    memberWorld();
    for (const id of shapesIn(await page.draw(), page.name)) found.add(`${page.name} ${id}`);
    const probe = memberWorld();
    await page.draw();
    const { tables, rpcs } = probe.reads();
    for (const t of tables) {
      const w = memberWorld();
      w.failTable(t);
      for (const id of shapesIn(await page.draw().catch(() => "Application error"), page.name)) found.add(`${page.name} ${id}`);
    }
    for (const r of rpcs) {
      const w = memberWorld();
      w.failRpc(r);
      for (const id of shapesIn(await page.draw().catch(() => "Application error"), page.name)) found.add(`${page.name} ${id}`);
    }
  }
  const owed = new Set(((table as { renderedOwed?: { page: string; shape: string; owner: string; finding: string }[] }).renderedOwed ?? []).map((o) => `${o.page} ${o.shape}`));
  assert.deepEqual([...found].filter((f) => !owed.has(f)).sort().map((f) => `${f}: ...${SNIPPETS.get(f)}...`), [], "a page prints a banned shape");
  assert.deepEqual([...owed].filter((f) => !found.has(f)).sort(), [], "owed but no longer printed: remove it from customer-strings.json renderedOwed");
});
