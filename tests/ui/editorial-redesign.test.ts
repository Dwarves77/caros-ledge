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
  assert.ok(html.includes("cl-detail-disclosure"), "Expected overflow rows past 20 to be wrapped in a collapsible disclosure");
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
