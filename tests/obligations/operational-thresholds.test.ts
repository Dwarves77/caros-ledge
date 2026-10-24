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

  const artifactsOf = (pin: string): Array<{ class: string; name: string }> => {
    const cand = plan.toInsert.find((x) => String(x.row.pinpoint_citation).includes(pin));
    assert.ok(cand, `candidate ${pin} must be derived`);
    assert.equal(cand.row.plain_language, null, "code never composes plain language");
    return JSON.parse(String(cand.row.evidence_required)) as Array<{ class: string; name: string }>;
  };

  // 1. Annex VIII DoC: the class from the data file, the name exactly as the span writes it
  assert.deepEqual(artifactsOf("33(1)"), [{ class: "declaration_of_conformity", name: "EU declaration of conformity in accordance with Annex VIII" }]);

  // 2. Annex VII technical documentation
  assert.deepEqual(artifactsOf("34(2)"), [{ class: "conformity_assessment_technical_documentation", name: "technical documentation in accordance with Annex VII" }]);

  // 3. Producer register: the span says "register of producers", so that is the name written (no fixed artifact name)
  assert.deepEqual(artifactsOf("39(1)"), [{ class: "producer_register", name: "register of producers" }]);

  // 4. Labeling & Marking
  const labelCandidate = plan.toInsert.find((x) => String(x.row.pinpoint_citation).includes("11(1)"));
  assert.ok(labelCandidate, "Labeling candidate must be derived");
  const labelTrigger = labelCandidate.row.applicability_trigger as { attribute: string; value: string };
  assert.equal(labelTrigger.attribute, "labeling_marking_class");
  assert.equal(labelTrigger.value, "material_composition_sorting");
});

test("a threshold the capture does not state is the stated absence, never a typed number", async () => {
  const span = "Article 6(1) Manufacturers shall ensure packaging meets the de minimis rule.";
  const db = connectDb({
    intelligence_items: [ITEM],
    agent_run_searches: [{ id: "c-nov", intelligence_item_id: "i-ppwr", result_content: span, result_url: "https://eur-lex.europa.eu/ppwr", result_index: 0 }],
    section_claim_provenance: [{ id: "claim-nov", claim_kind: "FACT", source_span: span, search_result_id: "c-nov", intelligence_item_id: "i-ppwr" }],
    item_forward_events: [],
    obligation_objects: [],
  }).db;
  const result = await deriveObligationObjects(db, { dry: true, itemIds: ["i-ppwr"] });
  const row = (result.data as { plan: { toInsert: Array<{ row: Row }> } }).plan.toInsert[0]?.row as Row;
  assert.deepEqual(row.applicability_trigger, { attribute: "de_minimis_weight", value: "M", comparison: "<", obs_status: "M" });
  assert.equal(row.plain_language, null);
  assert.equal(row.evidence_required, null);
});

test("a candidate with no capture is refused, never written", async () => {
  const db = connectDb({ intelligence_items: [ITEM], agent_run_searches: [], section_claim_provenance: [], item_forward_events: [], obligation_objects: [] }).db;
  const result = await deriveObligationObjects(db, {
    dry: true,
    itemIds: ["i-ppwr"],
    extraCandidates: [{ instrument_item_id: "i-ppwr", capture_id: undefined as never, pinpoint_citation: "Article 6(1)", verbatim_text: "Article 6(1) Manufacturers shall ensure x.", duty_holder_class: ["manufacturer"], applicability_trigger: { attribute: "recycled_content", value: "35%" } }],
  });
  const plan = (result.data as { plan: { toInsert: unknown[]; refused: Array<{ reason: string }> } }).plan;
  assert.equal(plan.toInsert.length, 0);
  assert.deepEqual(plan.refused.map((r) => r.reason), ["capture_missing"]);
});
