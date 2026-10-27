// VISIBLE-FIX-2: every detail view states the item's UUID as data-item-id, never its legacy slug (main run 40421798392: "shows item g19, not the item")
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReactNode } from "react";

import { renderApp } from "../_support/render.ts";
import { memberWorld } from "../_support/sweep-worlds.ts";

const ROUTES: { name: string; path: string; uuid: string; draw: () => Promise<ReactNode> }[] = [
  { name: "regulation detail", path: "/regulations/o3", uuid: "", draw: async () => (await import("@/features/regulations/pages")).RegulationDetailRoute({ params: Promise.resolve({ slug: "o3" }) }) },
  { name: "research detail", path: "/research/r1", uuid: "aaaaaaaa-0000-4000-8000-000000000012", draw: async () => (await import("@/features/research/detail-page")).ResearchDetailRoute({ params: Promise.resolve({ slug: "r1" }) }) },
  { name: "operations detail", path: "/operations/o1", uuid: "aaaaaaaa-0000-4000-8000-000000000013", draw: async () => (await import("@/features/operations/detail-page")).OperationsDetailRoute({ params: Promise.resolve({ slug: "o1" }) }) },
  { name: "market detail", path: "/market/m1", uuid: "aaaaaaaa-0000-4000-8000-000000000011", draw: async () => (await import("@/features/market/detail-page")).MarketDetailRoute({ params: Promise.resolve({ slug: "m1" }) }) },
];

for (const r of ROUTES) {
  test(`${r.name}: data-item-id is the item's uuid, though the item is reached by its legacy id`, async () => {
    const world = memberWorld() as unknown as { tables?: Record<string, { id: string; legacy_id?: string }[]> } | undefined;
    const out = await renderApp((await r.draw()) as never, { path: r.path });
    const m = /data-item-id="([^"]*)"/.exec(out);
    assert.ok(m, `${r.name}: no data-item-id drawn`);
    assert.match(m[1]!, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, `${r.name}: data-item-id is "${m[1]}", not a uuid`);
    if (r.uuid) assert.equal(m[1], r.uuid);
    void world;
  });
}
