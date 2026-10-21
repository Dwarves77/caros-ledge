import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveObligationObjects } from "@/features/obligations";

import { connectDb } from "../connect/world.ts";

type Row = Record<string, unknown>;

const ITEM = {
  id: "i-ppwr",
  title: "Packaging and Packaging Waste Regulation",
  provenance_status: "verified",
  replaced_by: null,
  is_archived: false,
  jurisdiction_iso: ["EU"],
  instrument_identifier: "Regulation (EU) 2025/400",
  canonical_instrument_key: null,
};

test("operational thresholds: derives void space, recycled content, and de minimis exemptions", async () => {
  const captureText = [
    "Article 21(1) Economic operators shall ensure a maximum void space ratio of 50 percent for grouped and transport packaging.",
    "Article 6(1) Manufacturers shall ensure packaging contains at least 35% post-consumer recycled plastic content by weight.",
    "Article 10(2) Economic operators shall ensure packaging components representing less than 5% by weight of the packaging unit are exempt.",
    "Article 14(3) Undertakings handling less than 10 tonnes of packaging per calendar year shall be exempt.",
    "Article 28(4) Operators shall be exempt with respect to transport packaging used in B2B transactions within a closed loop system.",
  ].join("\n");

  const capture = {
    id: "c-ppwr",
    intelligence_item_id: "i-ppwr",
    result_content: captureText,
    result_url: "https://eur-lex.europa.eu/ppwr",
    result_index: 0,
  };

  const claims = [
    {
      id: "claim-void",
      claim_kind: "FACT",
      source_span: "Article 21(1) Economic operators shall ensure a maximum void space ratio of 50 percent for grouped and transport packaging.",
      search_result_id: "c-ppwr",
      intelligence_item_id: "i-ppwr",
    },
    {
      id: "claim-recycled",
      claim_kind: "FACT",
      source_span: "Article 6(1) Manufacturers shall ensure packaging contains at least 35% post-consumer recycled plastic content by weight.",
      search_result_id: "c-ppwr",
      intelligence_item_id: "i-ppwr",
    },
    {
      id: "claim-deminimis",
      claim_kind: "FACT",
      source_span: "Article 10(2) Economic operators shall ensure packaging components representing less than 5% by weight of the packaging unit are exempt.",
      search_result_id: "c-ppwr",
      intelligence_item_id: "i-ppwr",
    },
    {
      id: "claim-tonnage",
      claim_kind: "FACT",
      source_span: "Article 14(3) Undertakings handling less than 10 tonnes of packaging per calendar year shall be exempt.",
      search_result_id: "c-ppwr",
      intelligence_item_id: "i-ppwr",
    },
    {
      id: "claim-exemption",
      claim_kind: "FACT",
      source_span: "Article 28(4) Operators shall be exempt with respect to transport packaging used in B2B transactions within a closed loop system.",
      search_result_id: "c-ppwr",
      intelligence_item_id: "i-ppwr",
    },
  ];

  const db = connectDb({
    intelligence_items: [ITEM],
    agent_run_searches: [capture],
    section_claim_provenance: claims,
    item_forward_events: [],
    obligation_objects: [],
  }).db;

  const result = await deriveObligationObjects(db, { dry: true, itemIds: ["i-ppwr"] });
  const plan = (result.data as { plan: { toInsert: Array<{ row: Row }> } }).plan;

  // 1. Void space ratio extraction
  const voidCandidate = plan.toInsert.find((x) => String(x.row.pinpoint_citation).includes("21(1)"));
  assert.ok(voidCandidate, "void space candidate must be derived");
  const voidTrigger = voidCandidate.row.applicability_trigger as { attribute: string; value: string };
  assert.equal(voidTrigger.attribute, "void_space_ratio");
  assert.match(voidTrigger.value, /50/);

  // 2. Recycled content extraction
  const recycledCandidate = plan.toInsert.find((x) => String(x.row.pinpoint_citation).includes("6(1)"));
  assert.ok(recycledCandidate, "recycled content candidate must be derived");
  const recycledTrigger = recycledCandidate.row.applicability_trigger as { attribute: string; value: string };
  assert.equal(recycledTrigger.attribute, "recycled_content");
  assert.match(recycledTrigger.value, /35%/);

  // 3. De minimis weight extraction
  const deMinimisCandidate = plan.toInsert.find((x) => String(x.row.pinpoint_citation).includes("10(2)"));
  assert.ok(deMinimisCandidate, "de minimis candidate must be derived");
  const deMinimisTrigger = deMinimisCandidate.row.applicability_trigger as { attribute: string; value: string };
  assert.equal(deMinimisTrigger.attribute, "de_minimis_weight");
  assert.match(deMinimisTrigger.value, /5%/);

  // 4. Tonnage cutoff extraction
  const tonnageCandidate = plan.toInsert.find((x) => String(x.row.pinpoint_citation).includes("14(3)"));
  assert.ok(tonnageCandidate, "tonnage cutoff candidate must be derived");
  const tonnageTrigger = tonnageCandidate.row.applicability_trigger as { attribute: string; value: string };
  assert.equal(tonnageTrigger.attribute, "tonnage_cutoff");
  assert.match(tonnageTrigger.value, /10 tonnes/i);

  // 5. Exemption scope extraction
  const exemptionCandidate = plan.toInsert.find((x) => String(x.row.pinpoint_citation).includes("28(4)"));
  assert.ok(exemptionCandidate, "exemption candidate must be derived");
  const exemptionTrigger = exemptionCandidate.row.applicability_trigger as { attribute: string; value: string };
  assert.equal(exemptionTrigger.attribute, "exemption_scope");
  assert.match(exemptionTrigger.value, /b2b|closed_loop/i);
});

test("compliance artifacts & labeling: derives Annex VIII DoC, technical docs, and marking classes", async () => {
  const captureText = [
    "Article 33(1) Manufacturers shall draw up an EU declaration of conformity in accordance with Annex VIII and affix the CE marking.",
    "Article 34(2) The manufacturer shall compile technical documentation in accordance with Annex VII.",
    "Article 39(1) Producers shall register in the register of producers established by the competent authority.",
    "Article 11(1) Manufacturers shall ensure packaging bears a harmonised label and material composition marking to facilitate waste sorting.",
  ].join("\n");

  const capture = {
    id: "c-artifacts",
    intelligence_item_id: "i-ppwr",
    result_content: captureText,
    result_url: "https://eur-lex.europa.eu/ppwr",
    result_index: 0,
  };

  const claims = [
    {
      id: "claim-doc",
      claim_kind: "FACT",
      source_span: "Article 33(1) Manufacturers shall draw up an EU declaration of conformity in accordance with Annex VIII and affix the CE marking.",
      search_result_id: "c-artifacts",
      intelligence_item_id: "i-ppwr",
    },
    {
      id: "claim-techdocs",
      claim_kind: "FACT",
      source_span: "Article 34(2) The manufacturer shall compile technical documentation in accordance with Annex VII.",
      search_result_id: "c-artifacts",
      intelligence_item_id: "i-ppwr",
    },
    {
      id: "claim-register",
      claim_kind: "FACT",
      source_span: "Article 39(1) Producers shall register in the register of producers established by the competent authority.",
      search_result_id: "c-artifacts",
      intelligence_item_id: "i-ppwr",
    },
    {
      id: "claim-label",
      claim_kind: "FACT",
      source_span: "Article 11(1) Manufacturers shall ensure packaging bears a harmonised label and material composition marking to facilitate waste sorting.",
      search_result_id: "c-artifacts",
      intelligence_item_id: "i-ppwr",
    },
  ];

  const db = connectDb({
    intelligence_items: [ITEM],
    agent_run_searches: [capture],
    section_claim_provenance: claims,
    item_forward_events: [],
    obligation_objects: [],
  }).db;

  const result = await deriveObligationObjects(db, { dry: true, itemIds: ["i-ppwr"] });
  const plan = (result.data as { plan: { toInsert: Array<{ row: Row }> } }).plan;

  // 1. Annex VIII DoC
  const docCandidate = plan.toInsert.find((x) => String(x.row.pinpoint_citation).includes("33(1)"));
  assert.ok(docCandidate, "Annex VIII DoC candidate must be derived");
  assert.equal(typeof docCandidate.row.evidence_required, "string");
  assert.match(String(docCandidate.row.evidence_required), /Declaration of Conformity/i);
  assert.match(String(docCandidate.row.evidence_required), /Annex VIII/i);

  // 2. Annex VII Technical Documentation
  const techDocsCandidate = plan.toInsert.find((x) => String(x.row.pinpoint_citation).includes("34(2)"));
  assert.ok(techDocsCandidate, "Annex VII technical docs candidate must be derived");
  assert.equal(typeof techDocsCandidate.row.evidence_required, "string");
  assert.match(String(techDocsCandidate.row.evidence_required), /technical documentation/i);
  assert.match(String(techDocsCandidate.row.evidence_required), /Annex VII/i);

  // 3. Producer Register
  const regCandidate = plan.toInsert.find((x) => String(x.row.pinpoint_citation).includes("39(1)"));
  assert.ok(regCandidate, "Producer register candidate must be derived");
  assert.equal(typeof regCandidate.row.evidence_required, "string");
  assert.match(String(regCandidate.row.evidence_required), /producer register/i);

  // 4. Labeling & Marking
  const labelCandidate = plan.toInsert.find((x) => String(x.row.pinpoint_citation).includes("11(1)"));
  assert.ok(labelCandidate, "Labeling candidate must be derived");
  const labelTrigger = labelCandidate.row.applicability_trigger as { attribute: string; value: string };
  assert.equal(labelTrigger.attribute, "labeling_marking_class");
  assert.equal(labelTrigger.value, "material_composition_sorting");
});
