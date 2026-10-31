import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";

import { resolveBracketedIds } from "@/core/detail/cross-page-read";
import { themeAnalysisView } from "@/core/themes/theme-view";
import { ItemConnections } from "@/ui/detail/ItemConnections";

import { memoryDb } from "../_support/memory-db.ts";
import { renderApp } from "../_support/render.ts";

test("themeAnalysisView: with no brief the cluster is structure (ids, surface keys, signal tokens, counts), not a sentence", () => {
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
  assert.deepEqual(view.cluster, { memberIds: ["item-a", "item-b", "item-c"], pivotIds: [], surfaces: ["regulations", "market"], signals: ["shared_source", "shared_scenario"], memberCount: 3, surfaceCount: 2, density: 0.82 });
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

test("OPS-FIX-1 item 5: a bracketed item id in the stated coupling is read as the item's title and link; an id no admissible item holds is dropped; the stored text is untouched", async () => {
  const known = "dd7b482b-bae8-4620-a6ac-6fa9846b1eb5";
  const gone = "00000000-bae8-4620-a6ac-6fa9846b1eb5";
  const stored = `Both bind the same carrier duty [${known}], and the earlier order [${gone}] sets the date.`;
  const db = memoryDb({ intelligence_items: [{ id: known, legacy_id: "us-zev-order", title: "US Zero-Emission Vehicle Order", item_type: "regulation", domain: 1, is_archived: false, provenance_status: "verified" }] }).db;
  const shown = await resolveBracketedIds(db, stored);
  assert.equal(shown, "Both bind the same carrier duty [US Zero-Emission Vehicle Order](/regulations/us-zev-order), and the earlier order sets the date.");
  assert.doesNotMatch(shown ?? "", /[0-9a-f]{8}-[0-9a-f]{4}-/, "no raw id reaches the page");
  assert.match(stored, new RegExp(known), "the stored text is untouched");
  assert.equal(await resolveBracketedIds(db, "No ids here."), "No ids here.");
  assert.equal(await resolveBracketedIds(db, null), null);
});
