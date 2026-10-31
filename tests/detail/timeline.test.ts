import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";

import { withObligationEvents } from "@/core/detail/timeline";
import { bandOf } from "@/core/lists";
import { Timeline } from "@/ui/Timeline";
import { classifyMilestones, nextMilestoneClause } from "@/ui/timeline-math";

import { renderApp } from "../_support/render.ts";

test("withObligationEvents: preserves obligation_text in detail, claimId, and builds concise label", () => {
  const existing = [{ date: "2026-01-01", label: "Baseline Milestone" }];
  const events = [
    {
      event_date: "2027-06-30",
      event_kind: "compliance_deadline",
      obligation_text: "Operators of large container vessels must submit verified fuel carbon intensity reports for Q1 and Q2 to the national administering authority.",
      source_claim_id: "claim-uuid-1",
      source_section_id: "section-uuid-1",
    },
    {
      event_date: "2028-01-01",
      event_kind: "entry_into_force",
      obligation_text: "",
      source_claim_id: null,
      source_section_id: null,
    },
  ];
  const kindLabels = {
    compliance_deadline: "Compliance deadline",
    entry_into_force: "Entry into force",
  };

  const merged = withObligationEvents(existing, events, kindLabels);
  assert.equal(merged.length, 3);
  assert.equal(merged[0]?.label, "Baseline Milestone");

  const ev1 = merged[1];
  assert.equal(ev1?.date, "2027-06-30");
  assert.equal(ev1?.claimId, "claim-uuid-1");
  assert.equal(ev1?.kind, "compliance_deadline");
  assert.equal(ev1?.detail, "Operators of large container vessels must submit verified fuel carbon intensity reports for Q1 and Q2 to the national administering authority.");
  assert.notEqual(ev1?.label, "Compliance deadline");
  assert.ok((ev1?.label ?? "").length <= 50, `label is concise: ${ev1?.label}`);

  const ev2 = merged[2];
  assert.equal(ev2?.date, "2028-01-01");
  assert.equal(ev2?.label, "Entry into force", "falls back to kindLabel when obligation_text is empty");
  assert.equal(ev2?.detail, undefined);
});

test("Timeline: milestone nodes render as interactive buttons with accessible attributes", () => {
  const band = bandOf("HIGH" as never);
  const entries = [
    {
      date: "2026-01-01",
      label: "Phase 1 Starts",
      detail: "Phase 1 verified monitoring requirements enter into force.",
      kind: "entry_into_force",
      status: "past" as const,
    },
    {
      date: "2027-06-30",
      label: "Phase 2 Reports",
      detail: "Operators must submit verified emissions figures.",
      kind: "compliance_deadline",
      status: "current" as const,
    },
  ];
  const out = renderApp(createElement(Timeline, { entries, band, nowIso: "2026-06-01" }));
  assert.match(out, /<button[^>]*class="[^"]*\bcl-tl-marker\b[^"]*"/);
  assert.match(out, /type="button"/);
  assert.match(out, /aria-label="Phase 1 Starts · 1 Jan 2026 · Entry into force"/);
});

test("OPS-FIX-1 item 4: a sentence lifted from the source (an `other` event, or a long label with no event token) never headlines Next milestone; the next dated binding milestone does; none held is null", () => {
  const sentence = { date: "2030", label: "2030 — other: The order was supported by leading U.S. automakers, including Ford, General Motors, and Stellantis, who have voluntarily agreed to the target." };
  const longNoToken = { date: "2031", label: "A sentence quoted from the source document that runs on and on without naming what kind of event it is at all" };
  const binding = { date: "2032-03-01", label: "compliance_deadline: Operators submit the first report" };
  const now = "2026-10-31";
  assert.equal(nextMilestoneClause(classifyMilestones([sentence]), now), null, "only a prose sentence: no headline");
  assert.equal(nextMilestoneClause(classifyMilestones([sentence, longNoToken]), now), null);
  assert.match(nextMilestoneClause(classifyMilestones([sentence, longNoToken, binding]), now) ?? "", /^Operators submit the first report · 1 Mar 2032 · in /, "the next dated binding event headlines, skipping the sentences before it");
  assert.match(nextMilestoneClause(classifyMilestones([{ date: "2027-01-01", label: "Entry into force", kind: "entry_into_force" }]), now) ?? "", /^Entry into force/, "an obligation event of a binding kind qualifies");
  assert.equal(nextMilestoneClause(classifyMilestones([{ date: "2027-01-01", label: "Short but other", kind: "other" }]), now), null, "kind other never headlines, however short");
  assert.match(nextMilestoneClause(classifyMilestones([{ date: "2027-01-01", label: "Short plain milestone" }]), now) ?? "", /^Short plain milestone/, "a short label with no token is a milestone");
});
