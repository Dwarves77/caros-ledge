import assert from "node:assert/strict";
import { test } from "node:test";

import { scanText } from "@/features/obligations/extract/scan";
import { syncComplianceDeadline } from "@/features/obligations/derive/compliance-deadline";

import { connectDb } from "../connect/world.ts";

const TODAY = "2026-10-21";

test("pending regulatory triggers: scan classifies regulator rulemaking as implementing_act_due, delegated_act_due, or guidance_expected", () => {
  const imp = scanText("The Commission shall adopt implementing acts laying down detailed rules by 31 December 2026.");
  const impHit = imp.hits.find((h) => h.kind === "implementing_act_due");
  assert.ok(impHit, "Commission implementing act duty should classify as implementing_act_due");
  assert.equal(impHit.iso, "2026-12-31");

  const del = scanText("The Commission shall adopt delegated acts supplementing this Regulation by 1 January 2028.");
  const delHit = del.hits.find((h) => h.kind === "delegated_act_due");
  assert.ok(delHit, "Commission delegated act duty should classify as delegated_act_due");
  assert.equal(delHit.iso, "2028-01-01");

  const guid = scanText("The Agency shall publish guidance and guidelines on compliance monitoring by 1 July 2027.");
  const guidHit = guid.hits.find((h) => h.kind === "guidance_expected");
  assert.ok(guidHit, "Agency guidance duty should classify as guidance_expected");
  assert.equal(guidHit.iso, "2027-07-01");
});

test("syncComplianceDeadline: regulator and agency rulemaking triggers are structurally rejected as operator compliance deadlines", async () => {
  const item = {
    id: "reg-1",
    item_type: "regulation",
    compliance_deadline: null,
  };

  const pendingEvents = [
    {
      id: "ev-1",
      intelligence_item_id: "reg-1",
      event_date: "2027-01-01",
      event_kind: "implementing_act_due",
      confidence: "high",
      source_claim_id: "claim-1",
    },
    {
      id: "ev-2",
      intelligence_item_id: "reg-1",
      event_date: "2027-06-01",
      event_kind: "delegated_act_due",
      confidence: "high",
      source_claim_id: "claim-2",
    },
    {
      id: "ev-3",
      intelligence_item_id: "reg-1",
      event_date: "2027-09-01",
      event_kind: "guidance_expected",
      confidence: "high",
      source_claim_id: "claim-3",
    },
  ];

  const db = connectDb({
    intelligence_items: [item],
    item_forward_events: pendingEvents,
    fact_suppressions: [],
  }).db;

  const result = await syncComplianceDeadline(db, "reg-1", TODAY, { dry: true });
  assert.deepEqual(
    result,
    { changed: false, reason: "no future compliance_deadline event" },
    "regulator rulemaking triggers must not be picked as operator compliance deadline",
  );

  // If a genuine operator compliance_deadline is present, that one is picked
  const dbWithOperatorDeadline = connectDb({
    intelligence_items: [item],
    item_forward_events: [
      ...pendingEvents,
      {
        id: "ev-4",
        intelligence_item_id: "reg-1",
        event_date: "2028-01-01",
        event_kind: "compliance_deadline",
        confidence: "high",
        source_claim_id: "claim-4",
      },
    ],
    fact_suppressions: [],
  }).db;

  const resultWithOperator = await syncComplianceDeadline(dbWithOperatorDeadline, "reg-1", TODAY, { dry: true });
  assert.deepEqual(
    resultWithOperator,
    { changed: true, value: "2028-01-01" },
    "only the genuine operator compliance_deadline is picked",
  );
});
