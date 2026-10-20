// P2-15j: structures the retired parity waivers hid. The parity gate (tests/parity/compare.mjs) reads landmarks (role and name) in order, every list row (`[data-part="list-row"]`) and controls by name; each test pins one class of defect it found,
// on the same first paint a reader gets (static markup, no effects run).
//  1. every detail page ends with the Recalculation notices region the old pages drew (regulation, research, operations, market);
//  2. the timeline track and the related-signals links keep the markup the old page drew (G2 retired the sampler these were bent to: the gate no longer samples `li`, so the markup is free to be semantic);
//  3. an empty Spec09 panel on Operations offers its Request coverage control (the old page drew it twice).
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement, type ReactNode } from "react";

import { Timeline } from "@/ui/Timeline";
import { bandOf } from "@/core/lists";
import { RelatedSignalLinks } from "@/features/market/ui/RelatedSignalLinks";
import { RequestableCoverageState } from "@/features/coverage";

import { renderApp } from "../_support/render.ts";
import { memberWorld } from "../_support/sweep-worlds.ts";

const html = async (path: string, render: () => Promise<ReactNode>): Promise<string> => renderApp((await render()) as never, { path });
const count = (s: string, needle: string): number => s.split(needle).length - 1;

const ROUTES: { name: string; path: string; draw: () => Promise<ReactNode> }[] = [
  { name: "regulation detail", path: "/regulations/o3", draw: async () => (await import("@/features/regulations/pages")).RegulationDetailRoute({ params: Promise.resolve({ slug: "o3" }) }) },
  { name: "research detail", path: "/research/r1", draw: async () => (await import("@/features/research/detail-page")).ResearchDetailRoute({ params: Promise.resolve({ slug: "r1" }) }) },
  { name: "operations detail", path: "/operations/o1", draw: async () => (await import("@/features/operations/detail-page")).OperationsDetailRoute({ params: Promise.resolve({ slug: "o1" }) }) },
  { name: "market detail", path: "/market/m1", draw: async () => (await import("@/features/market/detail-page")).MarketDetailRoute({ params: Promise.resolve({ slug: "m1" }) }) },
];

for (const r of ROUTES) {
  test(`${r.name}: draws the Recalculation notices region once, after the page's own sections`, async () => {
    memberWorld();
    const out = await html(r.path, r.draw);
    assert.equal(count(out, 'aria-label="Recalculation notices"'), 1, `${r.name}: the region the old page drew is missing or doubled`);
  });
}

test("regulation detail: the notices region follows the binding banner (the old landmark order: ..., How this regulation reaches you, Recalculation notices)", async () => {
  memberWorld();
  const out = await html(ROUTES[0]!.path, ROUTES[0]!.draw);
  const banner = out.indexOf("How this regulation reaches you");
  assert.ok(banner >= 0, "the binding banner draws");
  assert.ok(out.indexOf('aria-label="Recalculation notices"') > banner, "the notices region comes after the banner");
});

test("the timeline track keeps the markup the old page drew: an image-role track with one marker and one line per entry", () => {
  const band = bandOf("HIGH" as never);
  const out = renderApp(createElement(Timeline, { entries: [{ date: "2026-01-01", label: "Passed", status: "past" }, { date: "2027-02-01", label: "Ahead" }], band, nowIso: "2026-06-01" }));
  assert.match(out, /role="img"/);
  assert.equal(count(out, "cl-tl-marker"), 2);
  assert.equal(count(out, "cl-tl-line"), 1);
});

test("the related signals are one link each", () => {
  const out = renderApp(createElement(RelatedSignalLinks, { signals: [{ id: "m2", title: "Second signal", priority: "HIGH" } as never, { id: "m3", title: "Third signal", priority: "LOW" } as never] }));
  assert.equal(count(out, "<a "), 2);
});

test("a not-covered Spec09 panel on Operations offers Request coverage", async () => {
  memberWorld();
  const out = await html(ROUTES[2]!.path, ROUTES[2]!.draw);
  assert.match(out, /Auxiliary energy loads is not covered yet/, "the fixture's item has no auxiliary rows");
  assert.equal(count(out, "Request coverage"), 2, "one control per empty Spec09 panel");
});

test("RequestableCoverageState draws the control when it has a requestRef", () => {
  const out = renderApp(createElement(RequestableCoverageState, { state: "not_covered", variant: "inline", subject: "X", reason: "No rows yet.", requestRef: "/operations/o1#x" }));
  assert.match(out, />Request coverage</);
});

test("no source file bends its markup to the parity sampler: the gate reads every list row by its data-part, so a comment that explains a tag by the sampler is a stale rule (S:73)", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(name) && /parity gate samples|the parity sampler|first 20 `li/i.test(readFileSync(p, "utf8"))) offenders.push(p);
    }
  };
  walk("src");
  assert.deepEqual(offenders, [], "a file explains its markup by the retired sampler");
});
