import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRecordSections, splitKeyDateFacts } from "@/core/brief";
import { isVerbatim } from "@/core/contracts/verbatim";
import { CLASSIFY_INSTRUCTION, CLASSIFY_PROMPT_VERSION, CONTENT_MAX_CHARS, buildClassifyUserMessage, readVerdictFile, validateClassifyVerdict } from "@/core/intake";
import { classifyFrDocType, classifyHost, classifyItemTypeFromCelexKey, classifyUkLegislationType, deriveUkLegislationIdentifier, extractFrDocumentNumber, resolveDocumentIdentity } from "@/core/intake/identity";
import { buildRecordFacts, buildRecordPayload, buildResearchRecordPayload, writeGroundingSequence } from "@/features/intake";
import { claim, isProseSpan } from "@/features/intake/record-facts/extract";
import { STUB_BRIEF_MARKER, buildRecordFullBrief } from "@/features/intake/record-facts/payload";
import { WriteSequenceError, classifyMintOutcome } from "@/features/intake/write-item";

import { ITEM, OFFICIAL_TEXT, OFFICIAL_URL, SOURCE } from "./fixtures.ts";
import { MemDb } from "./memdb.ts";

const errBody = (t: string) => t.startsWith("Access Denied");
const input = { source_id: SOURCE, source_url: OFFICIAL_URL, source_name: "EUR-Lex", source_tier: 1, source_category: "regulatory" as const };

test("proof 1: the classifier instruction is pinned (existing verdict files keep their version) and the user message is capped at the excerpt the author read", () => {
  assert.equal(CLASSIFY_PROMPT_VERSION, "sha256:1ceca92ff0dfae68");
  assert.ok(CLASSIFY_INSTRUCTION.length > 500);
  const msg = buildClassifyUserMessage({ ...input, text: "x".repeat(CONTENT_MAX_CHARS + 500) });
  assert.ok(msg.includes("x".repeat(CONTENT_MAX_CHARS)) && !msg.includes("x".repeat(CONTENT_MAX_CHARS + 1)));
  assert.match(msg, /Source tier: 1/);
});

test("verdict validation: the error-body pre-gate wins over whatever the author inferred; nothing defaults to a positive", () => {
  const specific = { entity_verdict: "specific_document", item_type: "regulation", domain: 1, surface_tags: ["regulations", "bogus"], relevance: 250, severity: "COST ALERT", priority: "HIGH", urgency_tier: "elevated", title_candidate: " The Regulation ", topic_tags: ["emissions"], jurisdictions: ["EU"] };
  const gated = validateClassifyVerdict({ ...input, text: "Access Denied: robot check" }, specific, { isErrorBody: errBody });
  assert.ok(gated.ok && gated.result.entity_verdict === "uncertain" && gated.result.item_type === null, "a bot-block body is never a document");
  const ok = validateClassifyVerdict({ ...input, text: "real text" }, specific, { isErrorBody: errBody });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.result.surface_tags, ["regulations"], "surface tags are validated against the four surfaces");
    assert.equal(ok.result.relevance, 100, "relevance clamps");
    assert.equal(ok.result.title_candidate, "The Regulation");
    assert.equal(ok.result.domain, 1);
  }
  const noType = validateClassifyVerdict({ ...input, text: "t" }, { entity_verdict: "specific_document", item_type: null }, { isErrorBody: errBody });
  assert.ok(noType.ok && noType.result.entity_verdict === "uncertain", "specific_document with no item_type is an honest uncertain");
  const portal = validateClassifyVerdict({ ...input, text: "t" }, { entity_verdict: "portal", surface_tags: ["regulations"] }, { isErrorBody: errBody });
  assert.ok(portal.ok && portal.result.surface_tags.length === 0, "surface tags are empty unless the document is specific");
  assert.equal(validateClassifyVerdict({ ...input, text: "t" }, [], { isErrorBody: errBody }).ok, false);
  const fallback = validateClassifyVerdict({ ...input, text: "t" }, { entity_verdict: "weird" }, { isErrorBody: errBody });
  assert.ok(fallback.ok && fallback.result.entity_verdict === "uncertain" && fallback.result.title_candidate === "EUR-Lex");
});

const entry = (over: Record<string, unknown>) => ({ candidate_id: "c1", url: "https://a.test/x", entity_verdict: "specific_document", item_type: "regulation", confidence: 0.9, rationale: "r", classified_by: "session-haiku", classified_at: "2026-10-01T00:00:00Z", prompt_version: CLASSIFY_PROMPT_VERSION, domain: 1, severity: "MONITORING", priority: "LOW", urgency_tier: "stable", title_candidate: "T", surface_tags: ["regulations"], ...over });
const file = (entries: unknown[], over: Record<string, unknown> = {}) => ({ batch: "b1", generated_at: "2026-10-01T00:00:00Z", prompt_version: CLASSIFY_PROMPT_VERSION, classified_by: "session-haiku", entries, ...over });

test("the verdict file: a stale instruction version is excluded and COUNTED, the newest verdict per URL wins, a structural violation fails the whole file", () => {
  const r = readVerdictFile(file([entry({}), entry({ candidate_id: "c2", classified_at: "2026-10-02T00:00:00Z", title_candidate: "Newer" }), entry({ candidate_id: "c3", url: "https://b.test/y", prompt_version: "sha256:0000000000000000" })]));
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.stale, 1);
    assert.equal(r.superseded, 1);
    assert.equal(r.byUrl.get("https://a.test/x")?.title_candidate, "Newer");
    assert.equal(r.byUrl.has("https://b.test/y"), false);
  }
  const bad = readVerdictFile(file([entry({ domain: null })]));
  assert.equal(bad.ok, false, "an entry missing a required field fails the file");
  if (!bad.ok) assert.match(bad.errors.join("|"), /domain is required/);
  assert.equal(readVerdictFile({ batch: "" }).ok, false);
  assert.equal(readVerdictFile(file([], { classified_by: "someone" })).ok, false);
});

test("proof 1: document identity: CELEX sector map, UK series from the URL path only, Federal Register number and type, institution fallback", () => {
  assert.deepEqual(classifyItemTypeFromCelexKey("32023R1115"), { itemType: "regulation", hold: null });
  assert.deepEqual(classifyItemTypeFromCelexKey("32022L2464"), { itemType: "directive", hold: null });
  assert.deepEqual(classifyItemTypeFromCelexKey("22023A0101"), { itemType: "framework", hold: null });
  assert.equal(classifyItemTypeFromCelexKey("32023X9999").hold, "item_type_unmapped", "a real key with no home is named, never guessed");
  assert.equal(classifyItemTypeFromCelexKey("not-celex").hold, "canonical_key_unresolved", "the two holds are never conflated");
  assert.equal(classifyUkLegislationType("https://www.legislation.gov.uk/uksi/2024/12/made"), "regulation");
  assert.equal(deriveUkLegislationIdentifier("https://www.legislation.gov.uk/wsi/2024/12/made"), "UK wsi 2024/12", "a Welsh instrument is not labelled uksi");
  assert.equal(deriveUkLegislationIdentifier("https://example.test/none"), null);
  assert.equal(extractFrDocumentNumber("https://www.federalregister.gov/documents/2026/03/04/2026-04567/some-rule"), "2026-04567");
  assert.deepEqual(classifyFrDocType("Rule"), { itemType: "regulation", hold: null });
  assert.deepEqual(classifyFrDocType("Proposed Rule"), { itemType: "initiative", hold: null });
  assert.equal(classifyFrDocType("Notice").hold, "item_type_unmapped");
  assert.equal(classifyHost("https://eur-lex.europa.eu/x"), "eurlex");
  assert.equal(classifyHost("https://example.test/x"), null);
  const helpers = { deriveKey: (id: string | null) => id, sameInstitution: (a?: string | null, b?: string | null) => !!a && !!b && new URL(a).hostname === new URL(b).hostname };
  const eu = resolveDocumentIdentity({ document_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R1115", instrument_identifier: "32023R1115" }, { url: "https://eur-lex.europa.eu/" }, helpers);
  assert.deepEqual([eu.scheme, eu.itemType, eu.jurisdictionIso], ["celex", "regulation", "EU"]);
  const fr = resolveDocumentIdentity({ document_url: "https://www.federalregister.gov/documents/2026/03/04/2026-04567/x" }, null, helpers);
  assert.equal(fr.needsFrLookup, true, "no guess: the caller owns the network call");
  assert.equal(resolveDocumentIdentity({ document_url: "https://www.federalregister.gov/documents/2026/03/04/2026-04567/x" }, null, helpers, { frDocType: "Rule" }).itemType, "regulation");
  assert.equal(resolveDocumentIdentity({ document_url: "https://www.federalregister.gov/nope" }, null, helpers).hold, "fr_document_number_unresolved");
  assert.equal(resolveDocumentIdentity({ document_url: "https://agency.test/doc" }, { url: "https://agency.test/", category: "regulatory" }, helpers).itemType, "regulation");
  assert.equal(resolveDocumentIdentity({ document_url: "https://agency.test/doc" }, { url: "https://agency.test/", category: "news" }, helpers).hold, "institution_category_unmapped");
  assert.equal(resolveDocumentIdentity({ document_url: "https://stranger.test/doc" }, { url: "https://agency.test/" }, helpers).hold, "identity_unmapped_source");
});

const slots = ["effective_date", "penalty_summary", "jurisdictional_scope", "primary_deadline", "effective_date"];

test("INV-171 / proof 5: one claim per slot; every FACT span is verbatim under the database rule; GAPs are honest; the stub brief has no internal marker", () => {
  const claims = buildRecordFacts({ title: "Regulation (EU) 2023/9999 of the European Parliament and of the Council on sustainable freight operations", sourceUrl: OFFICIAL_URL, capturedText: OFFICIAL_TEXT, requiredSlots: slots, itemType: "regulation" });
  const keys = claims.filter((c) => c.section_key === "record_facts").map((c) => c.slot_key);
  assert.equal(new Set(keys).size, keys.length, "no slot twice (the executed duplicate case)");
  assert.ok(keys.includes("binding_position") && keys.includes("due_date"), "the regulation family adds binding position and due date");
  assert.ok(keys.includes("operative_provision"), "an EUR-Lex source adds the EU-act slots");
  const facts = claims.filter((c) => c.claim_kind === "FACT");
  assert.ok(facts.length >= 3);
  for (const f of facts) assert.ok(isVerbatim(OFFICIAL_TEXT, f.source_span), `FACT span verbatim: ${f.source_span}`);
  assert.ok(claims.filter((c) => c.claim_kind === "GAP").every((g) => g.source_span === null));
  assert.ok(claims.some((c) => c.section_key === "identity" && c.claim_kind === "FACT"), "the identity FACT is the title located verbatim");
  const brief = buildRecordFullBrief({ sourceUrl: OFFICIAL_URL, claims });
  assert.ok(brief.startsWith(`*${STUB_BRIEF_MARKER}*`));
  assert.doesNotMatch(brief, /<<<|CLAIM_PROVENANCE|_proof_note/);
  const boiler = brief.split("\n").filter((l) => !l.startsWith("- ") && !l.startsWith("Source:"));
  assert.doesNotMatch(boiler.join("\n"), /\d/, "the boilerplate is digit-free");
});

test("INV-171: a title that is not in the capture yields no identity FACT, and a span that fails the prose guard is never a FACT", () => {
  const none = buildRecordFacts({ title: "A Completely Different Title", sourceUrl: OFFICIAL_URL, capturedText: OFFICIAL_TEXT, requiredSlots: [], itemType: "regulation" });
  assert.equal(none.filter((c) => c.section_key === "identity").length, 0);
  assert.equal(isProseSpan("====== ====== ======"), false);
  assert.equal(isProseSpan("&nbsp; Operators shall report their annual emissions"), false);
  assert.equal(isProseSpan("<div>Operators shall report annual emissions</div>"), false);
  assert.equal(isProseSpan("see https://example.test/ for the details here"), false, "a bare-domain pointer is not a located fact");
  assert.equal(isProseSpan("Operators shall report verified annual emissions"), true);
  const nav = buildRecordFacts({ title: null, sourceUrl: null, capturedText: "Home | News | penalty ===== ===== ===== |", requiredSlots: ["penalty_summary"], itemType: "regulation" });
  assert.equal(nav.find((c) => c.slot_key === "penalty_summary")?.claim_kind, "GAP");
});

test("proof 5: the research payload has one claim per slot (the executed duplicate case), a stub that parses back, and no column-less side-fields", () => {
  const text = "This study finds that road electrification cuts emissions by a large margin in every tested corridor. The limitations of this study include a small sample of operators. Policymakers should consider a staged rollout of charging capacity. The report does not resolve the cost of grid upgrades. A key cost is $4.5 million per depot across the sample.";
  const p = buildResearchRecordPayload({ sourceUrl: "https://journal.test/paper", title: "Road electrification study", source: { id: SOURCE }, capturedText: text, requiredSlots: ["finding", "key_figure", "finding"] });
  const keys = p.claims.filter((c) => c.section_key === "record_facts").map((c) => c.slot_key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("finding") && keys.includes("key_figure") && keys.includes("evidence_agreement_signal"));
  assert.equal(p.item.grade, "record");
  for (const k of ["binding_position", "due_date", "date_precision", "corridor_identity", "research_credibility"]) assert.ok(!(k in p.item), `${k} has no column and is not computed here (ruling 2)`);
  const parsed = parseRecordSections(p.sections);
  assert.ok(parsed, "the stored sections parse back for the detail surface");
  assert.equal((parsed?.facts.length ?? 0) + (parsed?.gaps.length ?? 0), keys.length);
  assert.ok(Array.isArray(splitKeyDateFacts(parsed?.facts ?? []).dateFacts));
  assert.throws(() => buildRecordPayload({ sourceUrl: "", itemType: "regulation", title: "t", source: { id: "s" }, capturedText: "x" }), /requires sourceUrl/);
  assert.throws(() => buildRecordPayload({ sourceUrl: "u", itemType: "regulation", title: "t", source: { id: "s" }, capturedText: "   " }), /non-empty capturedText/);
});

test("INV-295: the grounding write sequence is ordered (pool, sections, Gate A, claims, citations); a failed step names itself and nothing after it is attempted", async () => {
  const payload = buildRecordPayload({ sourceUrl: OFFICIAL_URL, itemType: "regulation", title: "Regulation (EU) 2023/9999 of the European Parliament and of the Council on sustainable freight operations", source: { id: SOURCE }, capturedText: OFFICIAL_TEXT, requiredSlots: ["effective_date", "penalty_summary"] });
  const db = new MemDb();
  const res = await writeGroundingSequence(db.client, payload, ITEM, { sourceId: SOURCE, sourceTier: 1, nowIso: "2026-10-15T00:00:00Z" });
  assert.deepEqual(db.calls.filter((c) => c.op !== "select").map((c) => c.table), ["agent_run_searches", "intelligence_item_sections", "item_gate_a_state", "section_claim_provenance", "intelligence_item_citations"]);
  assert.equal(res.searches, 1);
  assert.equal(res.claims, payload.claims.length);
  const facts = db.rows("section_claim_provenance").filter((c) => c.claim_kind === "FACT");
  assert.ok(facts.length > 0 && facts.every((c) => c.source_id === SOURCE && c.search_result_id && c.source_tier_at_grounding === 1), "a grounded FACT carries the source, its pool row and the tier");
  assert.ok(db.rows("section_claim_provenance").filter((c) => c.claim_kind === "GAP").every((c) => c.source_id === null && c.source_tier_at_grounding === null));
  const broken = new MemDb();
  broken.failWhen = (c) => (c.table === "item_gate_a_state" ? "locked" : null);
  await assert.rejects(writeGroundingSequence(broken.client, payload, ITEM, { sourceId: SOURCE, sourceTier: 1, nowIso: "t" }), (e: unknown) => e instanceof WriteSequenceError && e.step === "item_gate_a_state");
  assert.equal(broken.writes("section_claim_provenance").length, 0, "no claim is written after a failed Gate A state");
  const emptyPool = new MemDb();
  await assert.rejects(writeGroundingSequence(emptyPool.client, { ...payload, search_results: [{ ...payload.search_results[0]!, result_content: undefined as never }] }, ITEM, { sourceId: SOURCE, sourceTier: 1, nowIso: "t" }), /result_content must be a string/);
});

test("population run #8: the mint outcome is read from the row's provenance_status, never from an RPC's own flag", () => {
  assert.equal(classifyMintOutcome("verified"), "minted_verified");
  assert.equal(classifyMintOutcome("quarantined"), "minted_unverified");
  assert.equal(classifyMintOutcome(null), "minted_unverified");
});

test("INV-171: the one claim constructor refuses a FACT whose span is not verbatim in the capture (the assertion before emission)", () => {
  const ctx = { capturedText: OFFICIAL_TEXT, sourceUrl: OFFICIAL_URL };
  assert.equal(claim("effective_date", "record_facts", ctx, { span: "This Regulation shall enter into force on 1 January 2027", text: "x" }).claim_kind, "FACT");
  assert.throws(() => claim("effective_date", "record_facts", ctx, { span: "This Regulation enters into force whenever it likes", text: "x" }), /not a substring of the captured source text/);
  assert.equal(claim("effective_date", "record_facts", ctx, null).claim_kind, "GAP");
});

test("INV-025: a record-grade payload is not hollow: it holds more than its title as a FACT whenever the capture states anything the slots look for; a title-only capture is visibly hollow", () => {
  const full = buildRecordPayload({ sourceUrl: OFFICIAL_URL, itemType: "regulation", title: "Regulation (EU) 2023/9999 of the European Parliament and of the Council on sustainable freight operations", source: { id: SOURCE }, capturedText: OFFICIAL_TEXT, requiredSlots: ["effective_date", "penalty_summary"] });
  const nonTitleFacts = (p: typeof full) => p.claims.filter((c) => c.claim_kind === "FACT" && c.section_key !== "identity");
  assert.ok(nonTitleFacts(full).length >= 2, "slot FACTs beyond the title");
  const hollow = buildRecordPayload({ sourceUrl: OFFICIAL_URL, itemType: "regulation", title: "Regulation (EU) 2023/9999 of the European Parliament and of the Council on sustainable freight operations", source: { id: SOURCE }, capturedText: "Regulation (EU) 2023/9999 of the European Parliament and of the Council on sustainable freight operations", requiredSlots: ["effective_date", "penalty_summary"] });
  assert.equal(nonTitleFacts(hollow).length, 0, "a title-only capture yields no slot FACT: the hollow shape the sweep looks for");
  assert.ok(hollow.claims.some((c) => c.section_key === "identity" && c.claim_kind === "FACT"));
});
