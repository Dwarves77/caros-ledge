import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";

import { readCrossPage } from "@/core/detail/cross-page-read";
import { themeAnalysisView } from "@/core/themes/theme-view";
import { ItemConnections } from "@/ui/detail/ItemConnections";

import { memoryDb } from "../_support/memory-db.ts";
import { renderApp } from "../_support/render.ts";

test("themeAnalysisView: with no brief the cluster is structure (ids, surface keys, the words it is linked by, counts), not a sentence", () => {
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
  assert.deepEqual(view.cluster, { memberIds: ["item-a", "item-b", "item-c"], pivotIds: [], surfaces: ["regulations", "market"], linkedBy: [], memberCount: 3, surfaceCount: 2, density: 0.82 });
});

test("ItemConnections: each connection says why in one sentence, never a tag or a score", () => {
  const row = { id: "r1", title: "Maritime Fuel Standard", priority: "HIGH", label: "References", surface: "market", href: "/market/r1", origin: "provenance_discovery", discovered: true, reason: "Both apply to ocean fuel surcharge operations." };
  const html1 = renderApp(createElement(ItemConnections, { rows: [row] as never }));
  assert.match(html1, /Both apply to ocean fuel surcharge operations\./);
  assert.doesNotMatch(html1, /Bound by|shared_|0\.\d\d/);
  const html2 = renderApp(createElement(ItemConnections, { rows: [{ ...row, id: "r2", label: "Supersedes", surface: "regulations", href: "/regulations/r2", reason: "Replaces prior statutory provisions." }] as never }));
  assert.match(html2, /Replaces prior statutory provisions/);
});

test("OPS-FIX-1 item 5: a bracketed item id in the stated coupling is read as the item's title and link; an id no admissible item holds is dropped; the stored text is untouched", async () => {
  const known = "dd7b482b-bae8-4620-a6ac-6fa9846b1eb5";
  const gone = "00000000-bae8-4620-a6ac-6fa9846b1eb5";
  const stored = `Both bind the same carrier duty [${known}], and the earlier order [${gone}] sets the date.`;
  const db = memoryDb({ intelligence_items: [{ id: known, legacy_id: "us-zev-order", title: "US Zero-Emission Vehicle Order", item_type: "regulation", domain: 1, is_archived: false, provenance_status: "verified" }] }).db;
  const read = (summary: string | null) => readCrossPage(db, "00000000-0000-4000-8000-0000000000aa", "operations", summary, [], {}, "2026-10-31T00:00:00Z").then((c) => c.intersections?.summary ?? null);
  const shown = await read(stored);
  assert.equal(shown, "Both bind the same carrier duty [US Zero-Emission Vehicle Order](/regulations/us-zev-order), and the earlier order sets the date.");
  assert.doesNotMatch(shown ?? "", /[0-9a-f]{8}-[0-9a-f]{4}-/, "no raw id reaches the page");
  assert.match(stored, new RegExp(known), "the stored text is untouched");
  assert.equal(await read("No ids here."), "No ids here.");
  assert.equal(await read(null), null);
});
