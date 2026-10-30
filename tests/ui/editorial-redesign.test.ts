import assert from "node:assert/strict";
import { test } from "node:test";

import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Resource } from "@/core/types";
import { ObligationRegister, type RegisterRowView } from "@/features/regulations/ObligationRegister";
import { FactCard } from "@/ui/FactCard";
import { commonActionCardProps } from "@/ui/detail/action-card-props";
import { DetailLayout } from "@/ui/detail/DetailShell";
import { ItemConnections } from "@/ui/detail/ItemConnections";
import { PendingTriggers } from "@/ui/detail/PendingTriggers";
import { classifyMilestones, nextMilestoneClause } from "@/ui/timeline-math";

const router = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
} as unknown as AppRouterInstance;

test("PendingTriggers renders inside a framed .cl-summary-subcard with .cl-summary-subcard-title", () => {
  const html = renderToStaticMarkup(
    createElement(PendingTriggers, {
      events: [{ event_date: "2026-12-31", event_kind: "implementing_act_due", obligation_text: "Adopt implementing act", source_span: "Article 12(3)" }],
      kindLabels: { implementing_act_due: "Implementing act due" },
    }),
  );
  assert.ok(html.includes("cl-summary-subcard"), "Expected PendingTriggers to render a framed .cl-summary-subcard container");
  assert.ok(html.includes("cl-summary-subcard-title"), "Expected PendingTriggers to use high-contrast .cl-summary-subcard-title");
});

test("commonActionCardProps humanizes snake_case item types in Who pays exposure cell", () => {
  const resource = {
    id: "r1",
    title: "Test Research",
    url: "https://example.com",
    type: "research_finding",
    topic: "research",
    priority: "HIGH",
    cat: "air",
    sub: "",
    note: "",
    added: "2026-01-01",
    reasoning: "",
    tags: [],
    whatIsIt: "",
    whyMatters: "",
    keyData: [],
  } as unknown as Resource;
  const props = commonActionCardProps(resource, { tagPopover: null, watch: null, onTag: () => {} });
  const whoPays = String(props.whoPays.value ?? "");
  assert.ok(!whoPays.includes("research_finding"), `Expected snake_case type to be humanized, got: ${whoPays}`);
  assert.ok(whoPays.includes("Research finding"), `Expected humanized type label, got: ${whoPays}`);
});

test("nextMilestoneClause strips duplicate ISO date prefixes from milestone labels", () => {
  const milestones = classifyMilestones([
    { date: "2026-06-01", label: "2026-06-01 — 2026-06-01: Entry into force" },
  ]);
  const clause = nextMilestoneClause(milestones, "2026-05-14");
  assert.equal(clause, "Entry into force · 1 Jun 2026 · in 18 days");
});

test("ItemConnections deduplicates repeated basis signal labels", () => {
  const html = renderToStaticMarkup(
    createElement(ItemConnections, {
      rows: [
        {
          id: "c1",
          title: "Connected Regulation",
          href: "/regulations/c1",
          label: "References",
          surface: "regulations",
          priority: null,
          origin: "editorial",
          score: 0.8,
          discovered: false,
          basisSummary: [
            { signal: "shared_scenario" },
            { signal: "shared_scenario" },
            { signal: "shared_scenario" },
          ],
        },
      ],
    }),
  );
  assert.ok(html.includes("Bound by shared scenario"), "Expected deduplicated basis signal");
  assert.ok(!html.includes("shared scenario, shared scenario"), "Expected duplicate basis signals to be collapsed");
});

test("DetailLayout with rail={null} renders full-width .cl-detail-layout--solo without an empty rail track", () => {
  const html = renderToStaticMarkup(DetailLayout({ rail: null, children: createElement("p", null, "Body") }));
  assert.ok(html.includes("cl-detail-layout--solo"), "Expected .cl-detail-layout--solo class when rail is null");
  assert.ok(!html.includes('data-audit="detail-rail"'), "Expected no empty detail-rail node when rail is null");
});

test("ObligationRegister sanitizes leaked HTML comments/entities and collapses overflow rows past 20 on item variant", () => {
  const rows: RegisterRowView[] = Array.from({ length: 25 }, (_, i) => ({
    id: `row-${i + 1}`,
    jurisdiction: ["EU"],
    modes: ["ocean"],
    binding_position: null,
    due_date: "2026-11-21",
    date_precision: "day",
    event_kind: "compliance_deadline",
    obligation_text: i === 0 ? "claim:70cfedd6-a987-4fa3-a9de-150a00ff73af --> Submit&nbsp;emissions report <!-- comment -->" : `Clause ${i + 1}`,
    item: { id: "reg-1", title: "Test Reg", legacy_id: "reg-1" },
  }));
  const html = renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(ObligationRegister, {
        variant: "item",
        initial: { rows, total: 25 },
        failed: false,
      }),
    ),
  );
  assert.ok(!html.includes("claim:70cfedd6"), "Expected raw claim UUID comment fragment to be stripped");
  assert.ok(!html.includes("&amp;nbsp;"), "Expected &nbsp; entity to be decoded/cleaned");
  assert.ok(html.includes("Submit emissions report"), "Expected sanitized obligation text");
  assert.ok(html.includes("cl-register-master"), "Expected item ObligationRegister to be closed by default inside .cl-register-master");
  assert.ok(html.includes("cl-register-toolbar"), "Expected item ObligationRegister to include search and event-type filter toolbar");
  assert.ok(html.includes("cl-register-group"), "Expected item ObligationRegister to group clauses into collapsible date buckets");
  assert.ok(!html.includes("Not classified"), "Expected unclassified item register rows to omit NOT CLASSIFIED badge spam");
});

test("FactCard matrix density strips trailing middle-dots to prevent double dot separators", () => {
  const html = renderToStaticMarkup(
    createElement(FactCard, {
      density: "matrix",
      fact: {
        figure: "42 EUR",
        headline: " Wage floor",
        claim: "Hourly rate",
        prose: null,
        indexVsBase: null,
        sourceName: "Eurostat ·",
        sourceUrl: null,
        sourceTier: 1,
        period: null,
        provenance: "",
        written: "2026-04-06",
      },
    }),
  );
  assert.ok(!html.includes("· ·"), `Expected no double middle-dots in matrix source line, got: ${html}`);
});

test("ActionCard ExposureCell places header and Show more inline in .cl-exposure-head without vertical dead space below .cl-exposure-value", async () => {
  const { readFileSync } = await import("node:fs");
  const { BAND_ORDER } = await import("@/core/lists/bands");
  const { ActionCard } = await import("@/ui/ActionCard");
  const html = renderToStaticMarkup(
    createElement(ActionCard, {
      band: BAND_ORDER[0]!,
      kindLabel: "Regulation",
      nowIso: "2026-10-29T00:00:00Z",
      onExport: () => {},
      onShare: () => {},
      watch: null,
      where: { value: "European Union" },
      whoPays: { value: "Obligated: freight forwarder, exporter, importer, carrier road" },
      yourLanes: { value: "connect ↗" },
      timeline: [{ date: "2026-11-21", label: "Plastic waste B3011 export to non-OECD countries prohibited (Article 39(1)(d))" }],
    }),
  );
  assert.ok(html.includes('class="cl-exposure-head"><p class="cl-exposure-label">'), "Expected .cl-exposure-label inside .cl-exposure-head above .cl-exposure-value");
  const css = readFileSync("src/ui/base.css", "utf8");
  assert.match(css, /\.cl-exposure-grid\s*\{[^}]*minmax\(220px,\s*1\.75fr\)/, "Expected .cl-exposure-grid to allocate proportional width to Next milestone");
  assert.match(css, /\.cl-exposure-expand\s*\{[^}]*margin:\s*-4px 0;[^}]*min-height:\s*24px;/, "Expected .cl-exposure-expand to sit inline in the header row without 44px block height below value");
});

test("getClaims resolves directly from getSession user without a network round-trip to GoTrue getClaims", async () => {
  const { getClaims } = await import("@/core/auth/claims");
  let networkCalls = 0;
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "hs256-session-tok", user: { id: "u-fast-1", email: "fast@carosledge.com", user_metadata: { full_name: "Fast User" } } } },
        error: null,
      }),
      getClaims: async () => {
        networkCalls += 1;
        return { data: null, error: { name: "AuthApiError", status: 400 } };
      },
    },
  };
  const claims = await getClaims(client);
  assert.deepEqual(claims, { userId: "u-fast-1", email: "fast@carosledge.com", name: "Fast User" });
  assert.equal(networkCalls, 0, "Expected 0 network calls to GoTrue getClaims when getSession already holds the decoded user");
});

test("milestoneStageOf classifies statutory stages from event_kind or verbatim milestone labels and renders on Timeline markers", async () => {
  const { BAND_ORDER } = await import("@/core/lists/bands");
  const { Timeline } = await import("@/ui/Timeline");
  const { milestoneStageOf } = await import("@/ui/timeline-math");
  assert.equal(milestoneStageOf({ date: "2026-06-01", label: "Public consultation closes", kind: "consultation_close" }), "Proposed / consultation");
  assert.equal(milestoneStageOf({ date: "2026-11-21", label: "Commission to adopt first list of non-OECD authorised countries" }), "Rulemaking due");
  assert.equal(milestoneStageOf({ date: "2026-12-31", label: "Green-listed waste paper procedures permitted until this date (transitional)" }), "Phase-in");
  assert.equal(milestoneStageOf({ date: "2026-11-21", label: "Plastic waste B3011 export to non-OECD countries prohibited (Article 39(1)(d))" }), "Enacted deadline");
  const html = renderToStaticMarkup(
    createElement(Timeline, {
      entries: [
        { date: "2026-11-21", label: "Plastic waste B3011 export prohibited" },
        { date: "2026-12-31", label: "Transitional paper procedures permitted until this date" },
      ],
      band: BAND_ORDER[0]!,
      nowIso: "2026-10-30T00:00:00Z",
    }),
  );
  assert.ok(html.includes("21 Nov 2026 · Enacted deadline"), "Expected enacted deadline stage badge on timeline marker");
  assert.ok(html.includes("31 Dec 2026 · Phase-in"), "Expected phase-in stage badge on timeline marker");
});

test("commonActionCardProps and RelevanceRailCard surface deterministic applicability assumptions and scope triggers", async () => {
  const { RelevanceRailCard } = await import("@/ui/detail/ItemConnections");
  const relevance = {
    band: "high" as const,
    matchedModes: ["road", "ocean"],
    matchedVerticals: [],
    matchedJurisdictions: ["EU"],
    roleSignals: ["forwarder"],
    summary: "Relevance to your operation: affects your road/ocean operations, your role as forwarder in EU.",
    applicability: { status: "applies" as const, reasons: ["Applies to EU road and ocean freight forwarders."], missingDimensions: [] },
    binding: {
      decomposed: true,
      objectCount: 1,
      applicability: { status: "applies" as const, reasons: ["Applies to EU road and ocean freight forwarders."], missingDimensions: [], grain: "obligation" as const },
      lines: [{ position: "direct", label: "Your duty", note: "", dutyHolders: [{ id: "forwarder", label: "Freight forwarder" }], triggers: [{ attribute: "org_role", value: "forwarder", comparison: undefined, obsStatus: undefined, label: "Your organisation role is Freight forwarder" }], artifacts: [], applicability: null, objectCount: 1, costSlots: [] }],
      penalties: [],
    },
  };
  const resource = {
    id: "reg-1157",
    title: "Regulation (EU) 2024/1157",
    url: "https://eur-lex.europa.eu",
    type: "regulation",
    topic: "waste",
    priority: "HIGH",
    jurisdiction: "European Union",
    modes: ["road", "ocean"],
    operationalScenarioTags: ["cross-border-waste-shipment"],
    complianceObjectTags: ["freight-forwarder", "exporter"],
  } as unknown as Resource;
  const props = commonActionCardProps(resource, { tagPopover: null, watch: null, onTag: () => {}, relevance });
  const lanes = String(props.yourLanes.value ?? "");
  assert.ok(lanes.includes("Matched: affects your road/ocean operations"), `Expected matched summary in yourLanes, got: ${lanes}`);
  assert.ok(lanes.includes("In scope: Your organisation role is Freight forwarder"), `Expected trigger assumption in yourLanes, got: ${lanes}`);
  assert.ok(lanes.includes("Scenarios: cross border waste shipment"), `Expected scenario tags in yourLanes, got: ${lanes}`);

  const railHtml = renderToStaticMarkup(createElement(RelevanceRailCard, { state: { phase: "ready", relevance } }));
  assert.ok(railHtml.includes("In scope because: Your organisation role is Freight forwarder"), "Expected RelevanceRailCard to render explicit scope triggers");
  assert.ok(railHtml.includes("Applies to EU road and ocean freight forwarders."), "Expected RelevanceRailCard to render applicability reasons");
});
