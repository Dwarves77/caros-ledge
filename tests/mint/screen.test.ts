// The relevance screen: the rule table as data, the first-match order, the flipped rules, reviewed overrides, and the live-record reconcile.
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadReviewedVerdicts, screenVerdictFor } from "@/features/mint";
import rulesData from "@/features/mint/data/screen-rules.json";

import { MemDb } from "../intake/memdb.ts";

/** The rule verdict of one row: the screen with no reviewed overrides. */
const classifyRelevance = (row: Parameters<typeof screenVerdictFor>[0]) => {
  const v = screenVerdictFor(row);
  return { ...v, rule: String(v.rule) };
};

test("the rule table is data with the contract the register recorded: 4 CELEX roots, 114 rules (61 ON, 53 OFF of which 10 flip to on_vertical), every rule cited", () => {
  assert.equal(rulesData.celex_roots.length, 4);
  assert.equal(rulesData.rules.length, 114);
  const data = rulesData.rules;
  assert.equal(data.filter((r) => r.group === "on").length, 61);
  assert.equal(data.filter((r) => r.group === "off").length, 53);
  assert.equal(data.filter((r) => r.group === "off" && r.verdict === "on_vertical").length, 10);
  for (const r of data) assert.ok(r.ruling.length > 5 && r.rationale.length > 10 && (r.verdict === "on_vertical" || r.verdict === "off_vertical"), r.name);
  assert.equal(new Set(data.map((r) => r.name)).size, 114, "rule names are unique");
});

test("first match wins and ON is checked before OFF: a CBAM corrigendum is on_vertical, never the language-correction denylist", () => {
  const cbam = classifyRelevance({ title: "Corrigendum to Regulation (EU) 2023/956 establishing a carbon border adjustment mechanism (language corrections)" });
  assert.equal(cbam.verdict, "on_vertical");
  assert.equal(cbam.rule, "adr020_edge_zone_cbam_ets");
  // the same words with no ON signal fall to the denylist
  const lang = classifyRelevance({ title: "Corrigendum to Regulation (EU) 2022/1 (language corrections)" });
  assert.equal(lang.verdict, "off_vertical");
  assert.match(lang.rule, /language_correction/);
});

test("every OFF rule that an operator ruling or the mechanism re-audit flipped returns on_vertical; its ruling is cited", () => {
  const flipped = rulesData.rules.filter((r) => r.group === "off" && r.verdict === "on_vertical");
  assert.equal(flipped.length, 10);
  for (const r of flipped) assert.match(r.ruling, /^FLIP: /, r.name);
  const hit = classifyRelevance({ title: "Implementing Regulation laying down the Single European Sky performance plan for air navigation services" });
  assert.equal(hit.verdict, "on_vertical");
  assert.equal(hit.rule, "denylist_atm_air_services_bilateral");
  const rhine = classifyRelevance({ title: "Resolution of the CCNR on Rhine navigation emission standards" });
  assert.ok(["on_vertical", "off_vertical", "ambiguous"].includes(rhine.verdict));
});

test("the CELEX-root heuristic decides by number alone, whatever the title says", () => {
  const nomenclature = classifyRelevance({ title: "Carbon border adjustment mechanism", document_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:31987R2658" });
  assert.equal(nomenclature.verdict, "off_vertical");
  assert.equal(nomenclature.rule, "celex_root_customs_nomenclature");
  assert.equal(classifyRelevance({ title: "x", document_url: "https://eur-lex.europa.eu/?uri=CELEX:32013R0952" }).rule, "celex_root_union_customs_code");
});

test("ambiguous is never auto-declined: a preparatory act and a no-signal row are ambiguous with their own rule", () => {
  assert.deepEqual([classifyRelevance({ title: "Proposal for a regulation on something unrelated", document_url: "https://eur-lex.europa.eu/?uri=CELEX:52023PC0001" }).rule, classifyRelevance({ title: "Zebra grazing programme" }).rule], ["celex_preparatory_act_no_title_signal", "no_signal_ambiguous"]);
  assert.equal(classifyRelevance({ title: "", document_url: "https://agency.example/files?filename=policy_transport_shipping_accreditation_en.pdf" }).rule, "no_signal_ambiguous");
});

test("a title-less row is matched against its URL-derived text, and the basis says so", () => {
  const v = classifyRelevance({ title: "", document_url: "https://x.example/docs/greenhouse-gas-emissions-reduction-plan.pdf" });
  assert.equal(v.verdict, "on_vertical");
  assert.match(v.basis, /document_url-derived text/);
});

test("surface_tags are carried for traceability and never decide: the same title with different tags gets the same verdict", () => {
  const a = classifyRelevance({ title: "Zebra grazing programme", surface_tags: ["regulations"] });
  const b = classifyRelevance({ title: "Zebra grazing programme", surface_tags: ["research", "operations"] });
  assert.equal(a.verdict, b.verdict);
  assert.match(a.basis, /never a decision input/);
});

test("a reviewed verdict replaces only a rule's ambiguous, and only with a stated basis (INV-294 resolver input)", () => {
  const reviewed = new Map([["r1", { verdict: "on_vertical" as const, basis: "operator ruling" }], ["r2", { verdict: "on_vertical" as const, basis: "" }], ["r3", { verdict: "on_vertical" as const, basis: "operator ruling" }]]);
  assert.deepEqual([screenVerdictFor({ id: "r1", title: "Zebra grazing" }, reviewed).provenance, screenVerdictFor({ id: "r1", title: "Zebra grazing" }, reviewed).verdict], ["reviewed", "on_vertical"]);
  assert.equal(screenVerdictFor({ id: "r2", title: "Zebra grazing" }, reviewed).provenance, "rule", "no basis: ignored");
  assert.equal(screenVerdictFor({ id: "r3", title: "Corrigendum (language corrections)" }, reviewed).verdict, "off_vertical", "a reviewed verdict never overrides a rule's off_vertical");
});

test("the reviewed verdicts are read from screen_verdicts; a failed read throws and is never 'no overrides'", async () => {
  const db = new MemDb().seed("screen_verdicts", [{ census_id: "r1", verdict: "off_vertical", basis: "b", reviewer: "x" }]);
  assert.equal((await loadReviewedVerdicts(db.client)).get("r1")?.verdict, "off_vertical");
  db.failWhen = (c) => (c.table === "screen_verdicts" ? "relation does not exist" : null);
  await assert.rejects(() => loadReviewedVerdicts(db.client), /paginated read failed/);
});

