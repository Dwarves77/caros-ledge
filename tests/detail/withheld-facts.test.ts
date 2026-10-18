// A research finding or operations profile whose claims could not be read (production before the cutover carries no migration 0031) withholds its stored sections and SAYS so with Retry (INV-263, INV-270);
// it never reads the outage as "not written yet". The assessment cards sit in the document outline at the level the old page drew them (h2), not one level down.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";

import { DissentPanel, SignpostList } from "@/features/research/ui/AssessmentRail";
import { ResearchDetail, type ResearchDetailProps } from "@/features/research/ui/ResearchDetail";
import { OperationsDetail, type OperationsDetailProps } from "@/features/operations/ui/OperationsDetail";

import { renderApp, textOf } from "../_support/render.ts";

const resource = { id: "r1", title: "A finding", priority: "MODERATE", fullBrief: "", sources: [] } as never;
const common = {
  resource,
  sections: [],
  claimTiers: {},
  recommendedActions: [],
  connectionRows: [],
  crossPage: { intersections: null, theme: null, inferences: [], degraded: [] },
  related: { items: [], failed: false, reason: null },
  nowIso: "2026-10-17T00:00:00.000Z",
};
const bundle = { assessment: null, signposts: [], history: [], historyComplete: true, failed: false };

test("a finding whose claims did not load says the sections are withheld, with Retry; once they load it says they are not written", () => {
  const props = { ...common, assessment: bundle } as unknown as ResearchDetailProps;
  const withheld = textOf(renderApp(createElement(ResearchDetail, { ...props, claimsDegraded: true })));
  assert.match(withheld, /withheld until the facts load/);
  assert.match(withheld, /The facts of this finding did not load/);
  assert.match(withheld, /Retry/);
  assert.doesNotMatch(withheld, /Detailed sections for this finding are not written yet/);
  const ok = textOf(renderApp(createElement(ResearchDetail, { ...props, claimsDegraded: false })));
  assert.match(ok, /Detailed sections for this finding are not written yet/);
  assert.doesNotMatch(ok, /did not load, so none is shown/);
});

test("a profile whose claims did not load says the sections are withheld, with Retry", () => {
  const props = { ...common, eligibility: { s3Eligible: false, s4Eligible: false, dimensions: [], resolvedRegionCodes: [], unavailable: null }, spec09: { aux: null, grid: null, intensity: null, intensityFailed: false }, derived: null } as unknown as OperationsDetailProps;
  const withheld = textOf(renderApp(createElement(OperationsDetail, { ...props, claimsDegraded: true })));
  assert.match(withheld, /withheld until the facts load/);
  assert.match(withheld, /The facts of this profile did not load/);
  assert.doesNotMatch(withheld, /Detailed sections for this regional profile are not written yet/);
});

test("the Dissent and Signposts cards are level-2 headings", () => {
  const html = renderApp(createElement("div", null, createElement(DissentPanel, { assessment: null }), createElement(SignpostList, { signposts: [] })));
  assert.match(html, /<h2[^>]*>Dissent<\/h2>/);
  assert.match(html, /<h2[^>]*>Signposts<\/h2>/);
});

test("a connection row reads label then the surface it links to (as the old card did); a discovered edge keeps its mark off the visible name", async () => {
  const { ItemConnections } = await import("@/ui/detail");
  const row = { id: "x", title: "T", priority: "MODERATE", label: "References", surface: "research", href: "/research/x", origin: "provenance_discovery", discovered: true, basisSummary: [] };
  const html = renderApp(createElement(ItemConnections, { rows: [row] as never }));
  assert.match(textOf(html), /References · research T/);
  assert.doesNotMatch(textOf(html), /discovered/);
  assert.match(textOf(renderApp(createElement(ItemConnections, { rows: [{ ...row, surface: "uncategorized" }] as never }))), /References T/);
});
