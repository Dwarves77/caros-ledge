// UI-1 (the list surfaces read cleanly): the direct tests of INV-UI1-1 (an unscored row draws no impact segment), INV-UI1-5 (facet labels are the label table's sentence-case entries), and the row copy of U2/U3 (the one absence
// in sentence case, the bias chips as one muted line on the phone). The layout invariants (-2, -3, -4) need real fonts and run in the UX smokes through tests/ux/list-invariants.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";

import type { Resource } from "@/core/types";
import { liveFacetCounts } from "@/ui/list-surface";
import { facetLabel } from "@/ui/list-surface/facet-labels";
import table from "@/ui/list-surface/facet-labels.json";
import { EMPTY_FILTER_STATE } from "@/ui/list-surface/filter-sort";
import { NextObligationLine } from "@/features/regulations/NextObligationLine";
import { ImpactMeter } from "@/ui/ImpactMeter";

import { renderApp } from "../_support/render.ts";

const SCORED = { cost: 2, compliance: 3, client: 1, operational: 2 };
const meter = (scores: unknown, absence?: string) => renderApp(createElement(ImpactMeter, { scores, absence } as never));
const count = (html: string, needle: string) => html.split(needle).length - 1;

test("INV-UI1-1: an unscored impact meter renders no segment element and one dash named 'Impact not scored'; a scored one renders its twelve segments", () => {
  const unscored = meter({ cost: 0, compliance: 0, client: 0, operational: 0 });
  assert.equal(count(unscored, "cl-impact-bar"), 0, "no segment element, no outline");
  assert.equal(count(unscored, "cl-impact-group"), 0);
  assert.equal(count(unscored, 'aria-label="Impact not scored"'), 1, "exactly one dash in the impact cell");
  assert.equal(count(meter(null), "cl-impact-bar"), 0);
  assert.equal(count(meter(SCORED), 'class="cl-impact-bar"'), 12, "a scored row keeps its twelve segments");
});

const rowOf = (modes: string[], topic: string, jurisdiction: string): Resource => ({ id: topic + modes.join(), title: "t", priority: "HIGH", modes, topic, jurisdiction, sourceTier: 1 }) as never;

test("INV-UI1-5: facet labels are sentence case from the one label table; the stored values stay as stored", () => {
  const rows = [rowOf(["road"], "transport", "EU"), rowOf(["Road"], "Maritime", "EU"), rowOf(["maritime"], "maritime", "global"), rowOf(["inland_waterway"], "Inland waterway", "EU"), rowOf(["Inland waterway"], "INLAND WATERWAY", "united kingdom")];
  const f = liveFacetCounts(rows, EMPTY_FILTER_STATE);
  const labels = (o: { label: string }[]) => o.map((x) => x.label).sort();
  assert.deepEqual(labels(f.topic), ["Inland waterway", "Inland waterway", "Maritime", "Maritime", "Transport"].sort());
  assert.ok(f.mode.every((o) => /^[A-Z][a-z]*( [a-z]+)*$/.test(o.label)), labels(f.mode).join("|"));
  assert.ok(f.mode.some((o) => o.label === "Maritime"));
  assert.deepEqual(new Set(f.topic.map((o) => o.value)), new Set(["transport", "Maritime", "maritime", "Inland waterway", "INLAND WATERWAY"]), "values stay as stored");
  assert.ok(f.region.some((o) => o.label === "Global") && f.region.some((o) => o.label === "EU"));
});

test("INV-UI1-5: every entry of the label table is what the facets draw for that stored value, in any stored case", () => {
  for (const [group, entries] of Object.entries(table.labels)) {
    for (const [key, label] of Object.entries(entries)) {
      assert.match(label, /^[A-Z]/, `${group}.${key} is sentence case`);
      for (const stored of [key, key.toUpperCase(), key.replace(/ /g, "_"), key.charAt(0).toUpperCase() + key.slice(1)]) assert.equal(facetLabel(group as "mode" | "topic" | "region", stored), label, `${group}: ${stored}`);
    }
  }
  assert.equal(facetLabel("topic", "SUPPLY chain"), "Supply chain");
  assert.equal(facetLabel("topic", "EU ETS"), "EU ETS");
  assert.equal(facetLabel("region", "EU"), "EU");
  assert.equal(facetLabel("region", "United Kingdom"), "United Kingdom");
  // A code (two or three capitals, an optional subdivision) stays as stored; a bare capital word of four letters or more is a name.
  for (const code of ["US", "GB", "EU", "UN", "US-CA", "GB-ENG", "CA-NS", "CA-NU", "US-FL"]) assert.equal(facetLabel("region", code), code);
  assert.equal(facetLabel("region", "OECD"), "OECD");
  assert.equal(facetLabel("region", "ASIA"), "Asia");
  assert.equal(facetLabel("region", "GLOBAL"), "Global");
  assert.equal(facetLabel("topic", "road_transport"), "Road transport");
});

test("U8: the masthead names the next obligation by its title cut at 48 characters with an ellipsis; the title links to the item and carries the whole title", () => {
  const long = "Alternative Fuels Data Center: Federal and State Laws and Incentives Database";
  const html = renderApp(createElement(NextObligationLine, { label: "Nov 15, 2026", title: long, href: "/regulations/abc" }));
  const anchor = /<a ([^>]*)>([^<]*)<\/a>/.exec(html);
  assert.ok(anchor, html);
  assert.match(anchor[1]!, /href="\/regulations\/abc"/);
  assert.ok(anchor[1]!.includes(`title="${long}"`), "the whole title is the tooltip");
  assert.equal(anchor[2], `${long.slice(0, 48)}…`);
  assert.match(html.replace(/<[^>]*>/g, ""), /^ · next obligation Nov 15 · Alternative/);
  assert.equal(renderApp(createElement(NextObligationLine, { label: "Nov 15", title: "Short title", href: "/r/1" })).includes(">Short title</a>"), true);
});

test("IMPACT-1 sentence: an impact meter with an absence sentence names it on the dash, never 'Needs more data' (the sentence is the detail page's impact card; the list row draws no impact)", () => {
  const html = meter(null, "No obligations extracted yet");
  assert.match(html, /aria-label="No obligations extracted yet"/, "the impact dash carries the sentence");
  assert.doesNotMatch(html, /needs more data/i);
  assert.equal(count(meter(null), 'aria-label="Impact not scored"'), 1, "with no sentence the dash keeps its name");
});
