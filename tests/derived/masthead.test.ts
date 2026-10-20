// INV-R2d-5 and surfaces:6: the masthead's item number is the sum of the four counts the rail card draws on the same render, over the one surface list; a failed counts read is a stated failure in the masthead, never
// "pending", a zero or the constant "5 surfaces".
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ReactNode } from "react";

import { SURFACES } from "@/features/dashboard/rows";

import { STATED } from "../_support/page-sweep.ts";
import { renderApp, textOf } from "../_support/render.ts";
import { memberWorld } from "../_support/sweep-worlds.ts";

const drawn = async (render: () => Promise<ReactNode>): Promise<string> => textOf(renderApp((await render()) as never, { path: "/" }));
const dashboard = async () => (await import("@/features/dashboard/page")).default();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const railCounts = (text: string): number[] => SURFACES.map((s) => Number(new RegExp(`${escape(s.label)} ${escape(s.note)} ([\\d,]+)`).exec(text)?.[1]?.replace(/,/g, "")));

test("INV-R2d-5: the masthead's 'N items across M surfaces' is the sum of the rail's M counts on the same render, and M is the length of the surface list", async () => {
  memberWorld();
  const text = await drawn(dashboard);
  const m = /([\d,]+) items across (\d+) surfaces/.exec(text);
  assert.ok(m, `the masthead states its count: ${text.slice(0, 300)}`);
  const rail = railCounts(text);
  assert.equal(rail.length, SURFACES.length);
  assert.ok(rail.every((n) => Number.isFinite(n)), `the rail counts parse: ${rail}`);
  assert.equal(Number(m[1]!.replace(/,/g, "")), rail.reduce((a, b) => a + b, 0));
  assert.equal(Number(m[2]), SURFACES.length);
  assert.equal(SURFACES.length, 4, "the rail card lists four surfaces, so the masthead says four, not the old constant five");
});

test("surfaces:6 a refused surface-counts or aggregates read: the masthead says the counts did not load, prints no item count, and 'needs more data' does not appear", async () => {
  for (const rpc of ["get_all_surface_counts", "get_workspace_intelligence_aggregates", "get_surface_counts"]) {
    const w = memberWorld();
    w.failRpc(rpc);
    const text = await drawn(dashboard);
    assert.match(text, STATED, rpc);
    assert.doesNotMatch(text, /\d items across \d surfaces/, `${rpc}: no count is printed`);
    assert.match(text, /The item count did not load/, rpc);
    assert.doesNotMatch(text, /needs more data/, rpc);
  }
});
