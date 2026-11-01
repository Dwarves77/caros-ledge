import assert from "node:assert/strict";
import { test } from "node:test";

import { locateSpan } from "@/core/contracts/verbatim";
import { ledgerCoversClaims } from "@/core/grounding/ledger";
import { applyBatch } from "@/features/batches";
import { validateRecordBriefEntry } from "@/features/batches/kinds/item-briefs/validate";

import { batchFile, batchWorld, claims, factClaim, goodBody, ITEM, metadata, NOW, OFFICIAL_TEXT, OFFICIAL_URL, poolHashOf, recordEntry, SPAN_REPORT } from "./world.ts";

type World = ReturnType<typeof batchWorld>;
const apply = (w: World, entries: unknown[], o: { dry?: boolean; options?: Record<string, unknown>; file?: Record<string, unknown> } = {}) =>
  applyBatch("item-briefs", w.deps, { content: JSON.stringify(batchFile("item-briefs", entries, o.file)), dry: o.dry ?? false, runId: "run-1", ...(o.options ? { options: o.options } : {}) });
const item = (w: World) => w.db.rows("intelligence_items").find((r) => r.id === ITEM) as Record<string, unknown>;
const refusals = (r: Awaited<ReturnType<typeof apply>>) => r.notes.join("\n");

test("a valid batch applies end to end: the brief, its sections and timeline, its ground, the actions, the change, the participation and the flywheel, each recorded", async () => {
  const w = batchWorld();
  const r = await apply(w, [recordEntry(w.db)]);
  assert.equal(r.outcome === "ok" || r.outcome === "partial", true, refusals(r));
  assert.equal(r.counts.applied, 1, refusals(r));
  assert.equal(item(w).item_grade, "brief");
  assert.equal(item(w).provenance_status, "verified");
  assert.match(String(item(w).full_brief), /Regulation \(EU\) 2023\/9999/);
  assert.ok(w.db.rows("intelligence_item_sections").length >= 7 && w.db.rows("item_timelines").length >= 1);
  assert.equal(w.db.rows("section_claim_provenance").filter((c) => c.claim_kind === "FACT").length, 3);
  assert.ok(Array.isArray(item(w).recommended_actions), "the structured-actions step is a real write, not a preview");
  const change = w.db.rows("intelligence_changes").filter((c) => c.item_id === ITEM);
  assert.equal(change.length, 1);
  // P2-13: the reader of the change feed (get_workspace_recent_changes) calls an item UPDATED from item_changelog, so the regeneration writes that row too.
  assert.deepEqual(w.db.rows("item_changelog").map((c) => [c.item_id, c.change_type, c.field, c.detected_by]), [[ITEM, "UPDATED", "full_brief", "record-briefs"]]);
  assert.equal(w.rec.connects.some((c) => c.startsWith("events:")) && w.rec.connects.some((c) => c.startsWith("obligations:")) && w.rec.connects.some((c) => c.startsWith("entities:")), true, "the flywheel participation ran in the same run");
  assert.deepEqual((r.data as { ids: Record<string, string[]> }).ids.applied_ids, [ITEM]);
  assert.equal(r.counts.verified, 1);
});

test("INV-210: a re-apply of the same batch writes nothing new; a dry apply writes nothing", async () => {
  const w = batchWorld();
  const dry = await apply(w, [recordEntry(w.db)], { dry: true });
  assert.equal(dry.counts.valid, 1, refusals(dry));
  assert.equal(w.db.writes("intelligence_items").length, 0, "a dry run wrote nothing");
  await apply(w, [recordEntry(w.db)]);
  const before = w.db.writes().length;
  const again = await apply(w, [recordEntry(w.db)]);
  assert.equal(again.counts.already_applied, 1);
  assert.equal(again.counts.applied, 0);
  assert.equal(w.db.writes().length, before, "nothing new was written");
  assert.equal(w.db.rows("intelligence_changes").length, 1, "the change is recorded once");
  assert.equal(w.db.rows("item_changelog").length, 1, "the changelog row is written once per item, field and batch");
});

test("DRAIN-FIX-2 Trap A: an item whose brief is stored but whose sections are not cut from it is half applied and runs again; with its sections in place it is already applied", async () => {
  const w = batchWorld();
  await apply(w, [recordEntry(w.db)]);
  assert.equal((await apply(w, [recordEntry(w.db)])).counts.already_applied, 1, "sections derive from the brief: done");
  for (const s of w.db.rows("intelligence_item_sections")) s.content_md = "text of an older brief";
  const again = await apply(w, [recordEntry(w.db)], { options: { allowBriefOverwrite: true } });
  assert.equal(again.counts.already_applied ?? 0, 0, "stale sections: not already applied");
  assert.equal(again.counts.applied, 1, refusals(again));
  assert.equal(w.db.rows("intelligence_item_sections").some((s) => s.content_md === "text of an older brief"), false, "the sections were cut again from the brief");
});

test("INV-210: a structural defect refuses the whole file; a defective entry is refused alone with its reasons and never blocks the valid one", async () => {
  const w = batchWorld();
  for (const bad of [{ authored_by: "someone" }, { batch: "other-001" }, { generated_at: "yesterday" }]) {
    const r = await apply(w, [recordEntry(w.db)], { file: bad });
    assert.equal(r.outcome, "failed");
    assert.equal(r.counts.file_refused, 1, JSON.stringify(bad));
  }
  const notArray = await applyBatch("item-briefs", w.deps, { content: JSON.stringify({ batch: "item-briefs-001", generated_at: NOW.toISOString(), authored_by: "session-lane", entries: "x" }), dry: false });
  assert.equal(notArray.counts.file_refused, 1);
  assert.equal(w.db.writes("intelligence_items").length, 0, "no structural defect wrote anything");
  const second = "a0000000-0000-4000-8000-000000000002";
  w.db.seed("intelligence_items", [{ id: second, title: "Second", item_type: "market_signal", item_grade: "record", source_id: "b0000000-0000-4000-8000-000000000001", source_url: "https://eur-lex.europa.eu/x", provenance_status: "quarantined", is_archived: false, full_brief: null }]);
  const mixed = await apply(w, [recordEntry(w.db, { item_id: second, source_pool_hash: "0".repeat(64) }), recordEntry(w.db)]);
  assert.equal(mixed.counts.applied, 1);
  assert.equal(mixed.counts.refused, 1);
  assert.equal(mixed.outcome, "partial");
  assert.match(refusals(mixed), /stale pool/);
  assert.equal(((mixed.data as { residue: unknown[] }).residue).length, 1, "the refusal is kept as residue with its reasons");
});

test("INV-207: an entry authored against a pool that has since moved is refused and nothing is written", async () => {
  const w = batchWorld();
  const hash = recordEntry(w.db).source_pool_hash;
  w.db.seed("agent_run_searches", [{ intelligence_item_id: ITEM, result_url: "https://eur-lex.europa.eu/other", result_content: "y".repeat(400), result_index: 9 }]);
  const r = await apply(w, [recordEntry(w.db, { source_pool_hash: hash })]);
  assert.equal(r.counts.applied ?? 0, 0);
  assert.match(refusals(r), /stale pool/);
  assert.equal(item(w).full_brief, null);
  assert.equal(item(w).item_grade, "record");
});

// ---- INV-211: the adversarial entries, each refused before any write -------------------------------------------------------------
const attack = async (name: string, over: Record<string, unknown>, expect: RegExp) => {
  const w = batchWorld();
  const r = await apply(w, [recordEntry(w.db, over)]);
  assert.equal(r.counts.applied ?? 0, 0, `${name}: nothing applied`);
  assert.match(refusals(r), expect, name);
  assert.equal(w.db.writes("intelligence_items").length, 0, `${name}: nothing written`);
  assert.equal(w.db.writes("section_claim_provenance").length, 0, `${name}: no claim written`);
};
test("INV-211 attack: a figure the body states and no FACT covers is refused (Gate A mirror)", () => attack("uncovered figure", { body: goodBody({ sec1: " Late reporting costs EUR 7500 per vessel." }) }, /Gate A mirror.*"EUR 7500"/s));
test("INV-211 attack: a section that states a requirement with no label is refused (criterion 4 mirror)", () => attack("unlabelled modal", { body: goodBody({ sec1: " Every operator must register with the competent authority first." }) }, /criterion 4 mirror: unlabeled assertion in section "1"/));
test("INV-211 attack: a body whose own timeline section yields no dated row is refused (timeline mirror)", () => attack("empty timeline", { body: goodBody({ timeline: null }) }, /timeline mirror/));
test("INV-211 attack: a claim that declares a section its span does not appear in is refused (claim-section mirror)", () => attack("mis-declared claim section", { claims: [factClaim(SPAN_REPORT, { section: "6" }), claims()[1], claims()[2]] }, /claims\[0\]: source_span is not present in section "6"/));
test("INV-211 attack: a claim_text figure absent from its own span is refused (numeric-figure mirror)", () => attack("span-absent figure", { claims: [factClaim(SPAN_REPORT, { section: "1", claim_text: "Operators report 900 vessels before 30 April" }), claims()[1], claims()[2]] }, /claim_text figure "900" does not appear/));
test("INV-211: a FACT span that is not verbatim in the item's pool is refused (the forged span never reaches grounding)", () => attack("forged span", { claims: [factClaim("Operators are exempt from all reporting duties for the first five years of operation.", { section: "1" }), claims()[1], claims()[2]] }, /not a verbatim substring of the item's pool text/));

test("INV-211 (criterion 5): a required slot with no covering FACT is refused, and a GAP covers it only where the slot's description names a GAP form", async () => {
  const w = batchWorld();
  w.db.seed("item_type_required_slots", [{ item_type: "market_signal", slot_key: "tariff_schedule", description: "customs tariff schedule; emit a GAP claim (claim_kind=GAP) when the source is silent" }, { item_type: "market_signal", slot_key: "binding_position", description: "applicability of the instrument" }]);
  const body = goodBody({ sec1: " The applicability of the instrument and the customs tariff schedule are addressed in the claims." });
  const none = await apply(w, [recordEntry(w.db, { body })]);
  assert.match(refusals(none), /required slot "tariff_schedule".*no covering claim/s);
  assert.match(refusals(none), /required slot "binding_position".*no covering claim/s);
  const gap = { section: "1", claim_text: "[tariff_schedule] GAP: the customs tariff schedule is not stated in the pool", claim_kind: "GAP", source_span: null, source_id: null, source_url: null, slot_key: "tariff_schedule" };
  const hardGap = { ...gap, claim_text: "[binding_position] GAP: applicability is not stated", slot_key: "binding_position" };
  const onlyGaps = await apply(w, [recordEntry(w.db, { body, claims: [...claims(), gap, hardGap] })]);
  assert.doesNotMatch(refusals(onlyGaps), /tariff_schedule/, "a GAP covers a slot whose description names a GAP form");
  assert.match(refusals(onlyGaps), /binding_position.*only by a GAP claim/s, "and does not cover a binding-law slot, which stays HARD");
  const fact = factClaim(SPAN_REPORT, { section: "1", claim_text: `[binding_position] ${SPAN_REPORT}` });
  const ok = await apply(w, [recordEntry(w.db, { body, claims: [...claims(), gap, fact] })], { dry: true });
  assert.equal(ok.counts.valid, 1, refusals(ok));
  const silent = await apply(w, [recordEntry(w.db)]);
  assert.match(refusals(silent), /the body leaves 2 required slot\(s\) silently unaddressed \(tariff_schedule, binding_position\)|silently unaddressed/);
});

test("regulatory_fact_document accounting (the accounting-line-present rule, residue): depth accounting and qualification accounting route a thin 'Substantive Requirements' section to residue with the rule id", () => {
  const w = batchWorld();
  const live = (b: ReturnType<typeof batchWorld>) => ({ items: new Map([[ITEM, { itemType: "regulation", grade: "record", status: "quarantined", hash: String(recordEntry(b.db).source_pool_hash), poolText: SPAN_REPORT, bytes: 10, fullBrief: null }]]), slots: new Map(), adopted: {}, now: NOW, allowOverwrite: false, emit: new Map() });
  const regBody = (req: string) => {
    const heads = ["Purpose and Scope of This Document", "What This Regulation Is and Why It Applies to the Workspace", "Issues Requiring Immediate Action", "How the Workspace Sits in the Compliance Chain", "Authoritative Guidance Document Analysis", "Anticipated Authoritative Guidance and Pending Regulatory Events", "Threshold Questions", "Substantive Requirements", "Product-Specific Compliance Status", "Registration and Reporting Obligations", "Operational System Requirements", "Exemptions and Edge Cases", "Adjacent Industry Research and Alternatives", "Confirmed Regulatory Timeline", "Sources"];
    return heads.map((h, i) => `# ${i + 1}. ${h}\n\n${i === 7 ? req : i === 13 ? "- 1 January 2027: entry into force" : "Some prose about the regulation."}`).join("\n\n");
  };
  const e = (req: string) => ({ item_id: ITEM, source_pool_hash: recordEntry(w.db).source_pool_hash, body: regBody(req), metadata: metadata({ format_type: "regulatory_fact_document", signal_band: null, requirement_trajectory: null }), claims: [factClaim(SPAN_REPORT, { section: "8" })] });
  const missingLine = validateRecordBriefEntry(e(`${SPAN_REPORT}`), 0, live(w) as never).residue?.join("\n") ?? "";
  assert.match(missingLine, /accounting-line-present: depth accounting: "Substantive Requirements" must end with the line/);
  assert.match(missingLine, /qualification accounting: no per-year trajectory captured/);
  assert.match(missingLine, /no exceptions are stated|No exceptions are stated/i);
  const overstated = validateRecordBriefEntry(e(`${SPAN_REPORT}\n\nObligations surveyed: 5; workspace-adjacent: 4; extracted as FACT: 3.`), 0, live(w) as never).residue?.join("\n") ?? "";
  assert.match(overstated, /overstates the 1 FACT claim/);
  assert.match(overstated, /no "Shortfall: <reason>" line/);
  const trailing = validateRecordBriefEntry(e(`${SPAN_REPORT}\n\nObligations surveyed: 1; workspace-adjacent: 1; extracted as FACT: 1.\n\nA new uncounted obligation.`), 0, live(w) as never).residue?.join("\n") ?? "";
  assert.match(trailing, /content follows the accounting line/);
  const honest = validateRecordBriefEntry(e(`${SPAN_REPORT}\n\nNo phase-in is stated in Articles 1 to 4.\nNo exceptions are stated in Articles 1 to 4.\nNo scope limits are stated in Articles 1 to 4.\nObligations surveyed: 1; workspace-adjacent: 1; extracted as FACT: 1.`), 0, live(w) as never).residue?.join("\n") ?? "";
  assert.doesNotMatch(honest, /depth accounting|qualification accounting/, honest);
});

test("allowBriefOverwrite: an item that already holds a brief is regenerated only with the flag, and its prior claims are archived to claim_versions", async () => {
  const w = batchWorld({ briefGrade: true });
  const refused = await apply(w, [recordEntry(w.db)]);
  assert.match(refusals(refused), /allowBriefOverwrite/);
  assert.equal(refused.counts.applied ?? 0, 0);
  const ok = await apply(w, [recordEntry(w.db)], { options: { allowBriefOverwrite: true } });
  assert.equal(ok.counts.applied, 1, refusals(ok));
  assert.equal(item(w).item_grade, "brief");
});

test("the apply refuses inside the cooldown (read from harness_runs) and runs after it; the IO budget stops it cleanly before the next entry", async () => {
  const w = batchWorld();
  const mk = (id: string, finishedMinAgo: number, outcome = "success") => ({ id, family: "brief-apply", root_run_id: id, mode: "apply", outcome, started_at: new Date(NOW.getTime() - (finishedMinAgo + 1) * 60000).toISOString(), finished_at: new Date(NOW.getTime() - finishedMinAgo * 60000).toISOString(), inputs: {}, outputs: {} });
  w.db.seed("harness_runs", [mk("prev-1", 5)]);
  const held = await apply(w, [recordEntry(w.db)]);
  assert.equal(held.outcome, "failed");
  assert.match(refusals(held), /cooldown/);
  assert.equal(w.db.writes("intelligence_items").length, 0);
  const own = await applyBatch("item-briefs", w.deps, { content: JSON.stringify(batchFile("item-briefs", [recordEntry(w.db)])), dry: false, runId: "prev-1" });
  assert.equal(own.counts.applied, 1, "the firing's own ledger row is not its previous run");

  const w2 = batchWorld();
  const second = "a0000000-0000-4000-8000-000000000002";
  w2.db.seed("intelligence_items", [{ id: second, title: "Second", item_type: "market_signal", item_grade: "record", source_id: "b0000000-0000-4000-8000-000000000001", source_url: OFFICIAL_URL, provenance_status: "quarantined", is_archived: false, full_brief: null }]);
  w2.db.seed("agent_run_searches", [{ intelligence_item_id: second, result_url: OFFICIAL_URL, result_content: OFFICIAL_TEXT, result_index: 0 }]);
  const bytes = (id: string) => w2.db.rows("agent_run_searches").filter((r) => r.intelligence_item_id === id && String(r.result_content).trim().length > 200).reduce((n, r) => n + Buffer.byteLength(String(r.result_content)), 0);
  const entries = [recordEntry(w2.db), recordEntry(w2.db, { item_id: second, source_pool_hash: poolHashOf(w2.db, second) })];
  const stopped = await applyBatch("item-briefs", w2.deps, { content: JSON.stringify(batchFile("item-briefs", entries)), dry: false, options: { budgetBytes: bytes(ITEM) * 2 + 1 } });
  assert.equal(stopped.counts.applied, 1, refusals(stopped));
  assert.equal(stopped.counts.not_applied_io_budget, 1);
  assert.match(refusals(stopped), /io budget of \d+ byte\(s\) reached/);
  assert.equal(stopped.outcome, "partial");
  assert.equal((w2.db.rows("intelligence_items").find((r) => r.id === second) as Record<string, unknown>).item_grade, "record", "the entry past the budget was not applied");
  const resumed = await applyBatch("item-briefs", w2.deps, { content: JSON.stringify(batchFile("item-briefs", entries)), dry: false, options: { afterKey: ITEM } });
  assert.equal(resumed.counts.applied, 1, "the next dispatch resumes after the last applied key");
});

test("RUNS-FIX-1: the cooldown holds off only a repeat of the SAME bundle; a different bundle chained inside the window applies, and options.cooldownMinutes reaches the guard end to end", async () => {
  const prev = (batch: string, finishedMinAgo: number) => ({ id: `prev-${batch}`, family: "brief-apply", root_run_id: `prev-${batch}`, mode: "apply", outcome: "success", started_at: new Date(NOW.getTime() - (finishedMinAgo + 1) * 60000).toISOString(), finished_at: new Date(NOW.getTime() - finishedMinAgo * 60000).toISOString(), inputs: { batch: { kind: "item-briefs", content: JSON.stringify(batchFile("item-briefs", [], { batch })) }, ruled_plan: "plan.json#step" }, outputs: {} });
  // Two ruled plans in one push: the previous apply was another bundle (1c-meta), this one is 1c.
  const w = batchWorld();
  w.db.seed("harness_runs", [prev("item-briefs-2026-11-01-reg-backfill-1c-meta", 2)]);
  const chained = await apply(w, [recordEntry(w.db)], { file: { batch: "item-briefs-2026-11-01-reg-backfill-1c" } });
  assert.equal(chained.counts.applied, 1, refusals(chained));
  assert.equal(chained.counts.guard_refused ?? 0, 0);
  // The same bundle re-fired inside the window is still held: that repeat is the IO churn the cooldown exists for.
  const w2 = batchWorld();
  w2.db.seed("harness_runs", [prev("item-briefs-001", 2)]);
  const repeat = await apply(w2, [recordEntry(w2.db)]);
  assert.match(refusals(repeat), /cooldown/);
  assert.equal(w2.db.writes("intelligence_items").length, 0);
  // The option a plan's batch carries is honoured through applyBatch (the ruled-run path): a zero cooldown lets even the repeat through.
  const zero = await apply(w2, [recordEntry(w2.db)], { options: { cooldownMinutes: 0 } });
  assert.equal(zero.counts.applied, 1, refusals(zero));
});

test("the zero-model guard: the whole apply runs with every network call replaced by a throwing stub and the scrape gate closed, and reaches no model and no fetch", async () => {
  const w = batchWorld();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error("a network call was attempted");
  }) as never;
  try {
    const r = await apply(w, [recordEntry(w.db)]);
    assert.equal(r.counts.applied, 1, refusals(r));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("GROUND-FIX-1: a verified item whose brief changed has its authored claims stored (the ground runs and the old claim is archived); a verified item whose brief is unchanged is not re-grounded", async () => {
  const w = batchWorld();
  await apply(w, [recordEntry(w.db)]);
  assert.equal(item(w).provenance_status, "verified");
  const stored = () => w.db.rows("section_claim_provenance").map((c) => String(c.claim_text));
  const first = stored();
  const unchanged = await apply(w, [recordEntry(w.db)], { options: { allowBriefOverwrite: true } });
  assert.equal(unchanged.counts.already_applied, 1, "same brief, same claims, ledger holds them: done");
  assert.deepEqual(stored(), first);
  const revised = { body: goodBody({ sec1: " The revised brief restates the reporting duty." }), claims: [{ ...claims()[0], claim_text: "Reporting duty restated in the revised brief." }, claims()[1], claims()[2]] };
  const changed = await apply(w, [recordEntry(w.db, revised)], { options: { allowBriefOverwrite: true } });
  assert.equal(changed.counts.applied, 1, refusals(changed));
  assert.doesNotMatch(refusals(changed), /ground_skipped|ground_failed/);
  assert.ok(stored().includes("Reporting duty restated in the revised brief."), "the new brief's authored claim is in the ledger");
  assert.ok(w.db.rows("claim_versions").some((v) => v.claim_text === String(claims()[0]!.claim_text)), "the replaced claim is archived, not deleted");
});

test("GROUND-FIX-1: an item whose ledger lacks the entry's claims is half applied and runs again, however verified it is", async () => {
  const w = batchWorld();
  await apply(w, [recordEntry(w.db)]);
  w.db.rows("section_claim_provenance").length = 0;
  const again = await apply(w, [recordEntry(w.db)], { options: { allowBriefOverwrite: true } });
  assert.equal(again.counts.already_applied ?? 0, 0);
  assert.equal(again.counts.applied, 1, refusals(again));
  assert.equal(w.db.rows("section_claim_provenance").filter((c) => c.claim_kind === "FACT").length, 3);
});

test("GROUND-FIX-1 G2: a claim whose text is unchanged but which sits in another section after a re-section is not covered: the item runs again and the claim returns to its authored section", async () => {
  const w = batchWorld();
  await apply(w, [recordEntry(w.db)]);
  const secs = w.db.rows("intelligence_item_sections");
  const claim = w.db.rows("section_claim_provenance").find((c) => c.claim_kind === "FACT")!;
  const home = claim.section_row_id;
  claim.section_row_id = secs.find((s) => s.id !== home)!.id;
  const again = await apply(w, [recordEntry(w.db)], { options: { allowBriefOverwrite: true } });
  assert.equal(again.counts.already_applied ?? 0, 0, "a moved claim is half applied");
  assert.equal(again.counts.applied, 1, refusals(again));
  assert.equal(w.db.rows("section_claim_provenance").find((c) => c.id === claim.id || c.claim_text === claim.claim_text)?.section_row_id, home);
});

test("GROUND-FIX-1 G2 (duplicate sections): a claim authored in two sections and stored once, in either of them, reads as covered; stored in a third section, or not stored, it does not (b293a2b6 no longer loops)", () => {
  const sections = [{ id: "s1", section_key: "3", section_order: 1 }, { id: "s2", section_key: "8", section_order: 2 }, { id: "s3", section_key: "14", section_order: 3 }];
  const authored = [{ claim_text: "Scope widens in 2022", source_span: "From January 2022", section: "8" }, { claim_text: "Scope widens in 2022", source_span: "From January 2022", section: "14" }, { claim_text: "Other", source_span: "span", section: "3" }];
  const row = (text: string, span: string, section: string) => ({ claim_text: text, source_span: span, section_row_id: section });
  const other = row("Other", "span", "s1");
  assert.equal(ledgerCoversClaims([row("Scope widens in 2022", "From January 2022", "s2"), other], authored, sections), true, "stored in the first authored section");
  assert.equal(ledgerCoversClaims([row("Scope widens in 2022", "From January 2022", "s3"), other], authored, sections), true, "stored in the second authored section");
  assert.equal(ledgerCoversClaims([row("Scope widens in 2022", "From January 2022", "s1"), other], authored, sections), false, "stored in a section it was never authored in");
  assert.equal(ledgerCoversClaims([other], authored, sections), false, "a pair not stored at all");
});

test("INV-8 (ENGINE-JOIN-1): the flywheel learns from a brief: the entity its reader files the item under makes a new edge to the item already filed under it, in the same run", async () => {
  const w = batchWorld();
  w.deps.locate = locateSpan;
  const E = "cl:instrument:0000000000000099";
  const OTHER = "a0000000-0000-4000-8000-0000000000bb";
  const base = w.db.rows("intelligence_items")[0] as Record<string, unknown>;
  w.db.seed("entities", [{ entity_id: E, kind: "instrument", canonical_name: "the reporting standard", status: "active" }]);
  w.db.seed("intelligence_items", [{ ...base, id: OTHER, legacy_id: "other-item", title: "Other item", provenance_status: "verified", is_archived: false, replaced_by: null }]);
  w.db.seed("entity_refs", [{ ref_table: "intelligence_items", ref_id: OTHER, entity_id: E, role: "cites_instrument", asserted_by: "test", method_version: "refs@3.0.0" }]);
  const capture = w.db.rows("agent_run_searches").find((r) => r.intelligence_item_id === ITEM) as Record<string, unknown>;
  assert.equal(w.db.rows("item_cross_references").length, 0);
  const r = await apply(w, [recordEntry(w.db, { entity_ids: [{ entity_id: E, quote: { capture_id: capture.id, text: SPAN_REPORT } }] })]);
  assert.equal(r.counts.applied, 1, refusals(r));
  const edge = w.db.rows("item_cross_references").find((x) => x.source_item_id === ITEM && x.target_item_id === OTHER);
  assert.ok(edge, "the brief's new entity produced an edge to the item filed under it");
  assert.deepEqual([edge?.origin, (edge?.basis as { signal: string }[]).some((b) => b.signal === "shared_entity")], ["provenance_discovery", true]);
  const before = w.db.rows("item_cross_references").length;
  await apply(w, [recordEntry(w.db, { entity_ids: [{ entity_id: E, quote: { capture_id: capture.id, text: SPAN_REPORT } }] })], { options: { allowBriefOverwrite: true } });
  assert.equal(w.db.rows("item_cross_references").length, before, "idempotent: a second run makes no second edge");
});

// ---- REG-BACKFILL-1b: a metadata-only entry refreshes the context fields of a brief-grade item without regenerating its brief ----------------------
const WHY = "Operators that miss the April reporting date face enforcement, so the reporting calendar needs an owner in every operating unit this quarter.";
const CHANGES = "Sets a fixed annual reporting date for cargo operators, so the reporting calendar and its internal owners must be settled before the first report falls due.";
function refreshWorld(grade: "brief" | "record" = "brief") {
  const w = batchWorld({ briefGrade: grade === "brief" });
  w.deps.locate = locateSpan;
  const row = item(w);
  Object.assign(row, { what_is_it: "A new annual emissions reporting duty.", why_matters: null, what_it_changes: null, ...(grade === "brief" ? { full_brief: goodBody() } : {}) });
  const capture = w.db.rows("agent_run_searches").find((r) => r.intelligence_item_id === ITEM) as Record<string, unknown>;
  const quote = { capture_id: capture.id, text: SPAN_REPORT };
  const entry = (md: Record<string, unknown> = { why_matters: { value: WHY, quote }, what_it_changes: { value: CHANGES, quote } }, over: Record<string, unknown> = {}) => {
    const e = { item_id: ITEM, source_pool_hash: poolHashOf(w.db), metadata: md, ...over };
    return { ...e, review: { reviewed_by: "second-reader-test", judges: { J05: { pass: true, evidence: "J05: the fixture states it" }, J24: { pass: true, evidence: "J24: the fixture states it" } } } };
  };
  return { w, entry, quote };
}

test("INV-RB1b-1: a metadata-only entry on a brief-grade item writes the empty fields and leaves full_brief byte-identical, without allowBriefOverwrite", async () => {
  const { w, entry } = refreshWorld();
  const before = JSON.stringify([item(w).full_brief, item(w).item_grade, w.db.rows("section_claim_provenance").length, w.db.rows("intelligence_item_sections").length, item(w).what_is_it]);
  const dry = await apply(w, [entry()], { dry: true });
  assert.equal(dry.counts.metadata_refresh_planned, 1, refusals(dry));
  assert.equal(w.db.writes("intelligence_items").length, 0, "the dry run wrote nothing");
  const r = await apply(w, [entry()]);
  assert.equal(r.counts.metadata_refreshed, 1, refusals(r));
  assert.equal(r.counts.applied, 1);
  assert.equal(item(w).why_matters, WHY);
  assert.equal(item(w).what_it_changes, CHANGES);
  assert.equal(JSON.stringify([item(w).full_brief, item(w).item_grade, w.db.rows("section_claim_provenance").length, w.db.rows("intelligence_item_sections").length, item(w).what_is_it]), before, "brief, grade, claims, sections and the absent field are untouched");
  assert.equal((await apply(w, [entry()])).counts.already_applied, 1, "INV-210: a re-apply writes nothing new");
});

test("INV-RB1b-2: a metadata-only entry on a record-grade item is refused naming the reason, and writes nothing", async () => {
  const { w, entry } = refreshWorld("record");
  const r = await apply(w, [entry()]);
  assert.equal(r.counts.applied ?? 0, 0);
  assert.match(refusals(r), /record grade and needs the full brief/);
  assert.equal(w.db.writes("intelligence_items").length, 0);
});

test("INV-RB1b-3: a field whose quote is not in the pool is refused, and so is a bare string, a stray key and a metadata rule breach", async () => {
  const { w, entry, quote } = refreshWorld();
  const forged = await apply(w, [entry({ why_matters: { value: WHY, quote: { ...quote, text: "Operators are exempt from every reporting duty for five years." } } })]);
  assert.match(refusals(forged), /metadata\.why_matters: the quote is not in capture/);
  assert.match(refusals(await apply(w, [entry({ why_matters: WHY })])), /metadata\.why_matters: must be \{ value/);
  assert.match(refusals(await apply(w, [entry({ why_matters: { value: WHY, quote }, severity: "COST ALERT" })])), /nothing else \(found: severity\)/);
  assert.match(refusals(await apply(w, [entry({ what_it_changes: { value: "Too short to be a change.", quote } })])), /what-it-changes-length/);
  assert.match(refusals(await apply(w, [entry({ why_matters: { value: `${WHY} It is a T1 source.`, quote } })])), /tier-phrase-exposure/);
  assert.match(refusals(await apply(w, [entry({ why_matters: { value: "Operators face EUR 7500 per vessel if the April date is missed.", quote } })])), /Gate A mirror.*7500/);
  assert.match(refusals(await apply(w, [entry(undefined, { body: goodBody() })])), /nothing else|brief-grade|allowBriefOverwrite/);
  assert.equal(w.db.writes("intelligence_items").length, 0, "no refusal wrote anything");
  const unreviewed = { ...entry(), review: { reviewed_by: "second-reader-test", judges: { J24: { pass: true, evidence: "J24: the fixture states it" } } } };
  const held = await apply(w, [unreviewed]);
  assert.match(refusals(held), /J05 .*no verdict/);
  assert.equal(item(w).why_matters, null, "a refresh without both judges stays residue");
});

test("INV-RB1b-4: a metadata-only entry authored against a stale pool hash is refused", async () => {
  const { w, entry } = refreshWorld();
  const e = entry();
  w.db.seed("agent_run_searches", [{ intelligence_item_id: ITEM, result_url: "https://eur-lex.europa.eu/other", result_content: "y".repeat(400), result_index: 9 }]);
  const r = await apply(w, [e]);
  assert.match(refusals(r), /stale pool/);
  assert.equal(item(w).why_matters, null);
  const fresh = await apply(w, [{ ...e, source_pool_hash: poolHashOf(w.db) }]);
  assert.equal(fresh.counts.metadata_refreshed, 1, `re-authored against the live pool it applies: ${refusals(fresh)}`);
});
