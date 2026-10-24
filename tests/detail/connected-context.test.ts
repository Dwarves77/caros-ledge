import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";

import { themeAnalysisView } from "@/core/themes/theme-view";
import { ItemConnections } from "@/ui/detail/ItemConnections";

import { renderApp } from "../_support/render.ts";

test("themeAnalysisView: synthesizes informative cluster summary when no brief exists", () => {
  const themes = [
    {
      id: "t1",
      member_ids: ["item-a", "item-b", "item-c"],
      dominant_signals: [
        { signal: "shared_source", weight: 3 },
        { signal: "shared_scenario", weight: 2 },
      ],
      surfaces: ["regulations", "market"],
      density: 0.82,
    },
  ];
  const members = [
    { id: "item-a", legacy_id: "a", title: "Act A", item_type: "regulation", domain: 1 },
    { id: "item-b", legacy_id: "b", title: "Signal B", item_type: "market_signal", domain: 4 },
    { id: "item-c", legacy_id: "c", title: "Act C", item_type: "regulation", domain: 1 },
  ];
  const view = themeAnalysisView({
    itemId: "item-a",
    surface: "regulations",
    themes,
    briefs: [],
    members,
    asOfIso: "2026-10-24T00:00:00Z",
  });

  assert.ok(view);
  assert.equal(view.hasBrief, false);
  assert.notEqual(view.absence, "A brief for this theme has not been written yet, so what this connection means is not stated here.");
  assert.match(view.absence ?? "", /This cluster connects 3 items across/);
  assert.match(view.absence ?? "", /bound by/i);
  assert.match(view.absence ?? "", /cohesion 0\.82/);
});

test("ItemConnections: explains why and how items connect via rendered context lines", () => {
  const rowWithBasis = {
    id: "r1",
    title: "Maritime Fuel Standard",
    priority: "HIGH",
    label: "References",
    surface: "market",
    href: "/market/r1",
    origin: "provenance_discovery",
    discovered: true,
    basisSummary: [{ signal: "shared_source" }, { signal: "shared_scenario" }],
    score: 0.9,
  };
  const html1 = renderApp(createElement(ItemConnections, { rows: [rowWithBasis] as never }));
  assert.match(html1, /Bound by shared source, shared scenario/);

  const rowSupersedes = {
    id: "r2",
    title: "Old Fuel Standard",
    priority: "LOW",
    label: "Supersedes",
    surface: "regulations",
    href: "/regulations/r2",
    origin: "manual",
    discovered: false,
    basisSummary: [],
    score: null,
  };
  const html2 = renderApp(createElement(ItemConnections, { rows: [rowSupersedes] as never }));
  assert.match(html2, /Replaces prior statutory provisions/);
});
