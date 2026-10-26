// The second reader (DIGEST-1 D4 as re-specified by the eval-audit ruling): binary judges, one failure mode each; every required judge passes or the brief is residue naming the criterion. INV-DIG-3 (a conditional section filled with no grounded claim),
// INV-DIG-6 (the regulation format's always-present sections), the version stamp of the reader's values, and the judges' own data (each carries its origin and, once measured, its TPR and TNR).
import assert from "node:assert/strict";
import { test } from "node:test";

import { KINDS_VERSION, MENU, READER_METHOD } from "@/core/digest/kinds";
import { JUDGES, requiredJudges, review } from "@/core/digest/review";
import { applyBatch } from "@/features/batches";
import { validateRecordBriefEntry } from "@/features/batches/kinds/item-briefs/validate";

import { batchFile, batchWorld, ITEM, metadata, NOW, passingReview, recordEntry, SPAN_REPORT, factClaim } from "../batches/world.ts";
import { recordWorld } from "../batches/worlds.ts";

const apply = (w: ReturnType<typeof batchWorld>, e: Record<string, unknown>) => applyBatch("item-briefs", w.deps, { content: JSON.stringify(batchFile("item-briefs", [e])), dry: false, runId: "r" });
const withJudge = (e: Record<string, unknown>, id: string, v: unknown) => ({ ...e, review: { ...(e.review as object), judges: { ...((e.review as { judges: object }).judges), [id]: v } } });

test("the registry stamps every reader value: the kinds version, the method string and the menu bounds are data", () => {
  assert.match(KINDS_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(READER_METHOD, `reader@${KINDS_VERSION}`);
  assert.deepEqual([MENU.cap, MENU.maxLinked, MENU.maxRegion, MENU.aliases], [64, 24, 3, 4]);
});

test("which judges apply: by kind, by format and by the typed block the entry carries", () => {
  const base = { metadata: { format_type: "market_signal_brief" } };
  const ids = (kind: string, e: Record<string, unknown>) => requiredJudges(kind, e).map((j) => j.criterion);
  assert.ok(!ids("item-briefs", base).includes("obligation-field-quote-states-it") && !ids("item-briefs", base).includes("connection-reason-in-quote"));
  assert.ok(ids("item-briefs", { ...base, obligation_fields: [{}] }).includes("obligation-field-quote-states-it"));
  assert.ok(ids("item-briefs", { ...base, connections: [{}] }).includes("connection-reason-in-quote"));
  assert.ok(!ids("item-briefs", base).includes("pico-and-dissent-fidelity") && ids("item-briefs", { metadata: { format_type: "research_summary" } }).includes("pico-and-dissent-fidelity"));
  assert.ok(ids("admin-opportunity-findings", {}).includes("cross-surface-direction") && !ids("item-briefs", base).includes("cross-surface-direction"));
  assert.ok(ids("item-briefs", base).includes("entity-ids-complete"), "the emission items apply to every item brief");
  assert.ok(JUDGES.every((j) => j.prompt.length >= 40 && j.origin), "each judge is one prompt for one failure mode, with where it came from");
});

test("review: a missing verdict set, a missing verdict, an unreasoned pass and a fail each keep the brief out and name the judge and its criterion; all pass keeps it in", () => {
  const e = { metadata: { format_type: "market_signal_brief" } } as Record<string, unknown>;
  const ok = { ...e, review: passingReview(e) };
  assert.deepEqual(review("item-briefs", ok), { score: 1, reasons: [], residue: false, reviewed_by: "second-reader-test" });
  assert.match(review("item-briefs", e).reasons[0] ?? "", /verdicts are missing/);
  const first = requiredJudges("item-briefs", e)[0]!;
  const dropped = { ...ok, review: { ...(ok.review as object), judges: Object.fromEntries(Object.entries((ok.review as { judges: object }).judges).filter(([k]) => k !== first.id)) } };
  assert.match(review("item-briefs", dropped).reasons.join(), new RegExp(`${first.id} ${first.criterion}: no verdict`));
  assert.match(review("item-briefs", withJudge(ok, first.id, { pass: true, evidence: "" })).reasons.join(), /a verdict without its evidence/);
  const failed = review("item-briefs", withJudge(ok, first.id, { pass: false, evidence: "the label overstates what the source says" }));
  assert.deepEqual([failed.residue, failed.reasons.length], [true, 1]);
  assert.match(failed.reasons[0] ?? "", new RegExp(`^${first.id} ${first.criterion}: failed \\(the label overstates`));
  assert.ok(failed.score < 1);
});

test("INV-DIG-3: a brief that fills a conditional section with no grounded claim is kept out by the second reader, naming the criterion; the same brief with the verdict pass applies", async () => {
  const w = recordWorld();
  const planted = { ...recordEntry(w.db), body: String(recordEntry(w.db).body).replace("Competitive Implications\n\n", "Competitive Implications\n\nNo guidance has been published; operators should expect none soon. ") };
  const judge = JUDGES.find((j) => j.criterion === "conditional-section-has-grounded-claim")!;
  const caught = await apply(w, withJudge(planted, judge.id, { pass: false, evidence: "section 5 states there is no guidance while holding no grounded claim" }));
  assert.equal(caught.counts.applied ?? 0, 0);
  assert.match(caught.notes.join("\n"), new RegExp(`second reader: ${judge.id} conditional-section-has-grounded-claim: failed`));
  assert.equal(w.db.rows("brief_reviews").length, 0, "a brief under the bar leaves no applied review row");
  assert.equal((await apply(w, planted)).counts.applied, 1);
});

test("INV-DIG-6: the regulation format's always-present sections are present or the brief is residue naming the rule", () => {
  const w = batchWorld();
  const live = { items: new Map([[ITEM, { itemType: "regulation", grade: "record", status: "quarantined", hash: String(recordEntry(w.db).source_pool_hash), poolText: SPAN_REPORT, bytes: 10, fullBrief: null }]]), slots: new Map(), adopted: {}, now: NOW, allowOverwrite: false, emit: new Map() };
  const heads = ["Purpose and Scope of This Document", "What This Regulation Is and Why It Applies to the Workspace", "Issues Requiring Immediate Action", "How the Workspace Sits in the Compliance Chain", "Authoritative Guidance Document Analysis", "Anticipated Authoritative Guidance and Pending Regulatory Events", "Threshold Questions", "Substantive Requirements", "Product-Specific Compliance Status", "Registration and Reporting Obligations", "Operational System Requirements", "Exemptions and Edge Cases", "Adjacent Industry Research and Alternatives", "Confirmed Regulatory Timeline", "Sources"];
  const body = (omit: string | null) => heads.flatMap((h, i) => (h === omit ? [] : [`# ${i + 1}. ${h}\n\n${i === 13 ? "- 1 January 2027: entry into force" : "Some prose about the regulation."}`])).join("\n\n");
  const entry = (omit: string | null) => { const e = { item_id: ITEM, source_pool_hash: recordEntry(w.db).source_pool_hash, body: body(omit), metadata: metadata({ format_type: "regulatory_fact_document", signal_band: null, requirement_trajectory: null }), claims: [factClaim(SPAN_REPORT, { section: "8" })] }; return { ...e, review: passingReview(e) }; };
  const missing = validateRecordBriefEntry(entry("How the Workspace Sits in the Compliance Chain"), 0, live as never).residue?.join("\n") ?? "";
  assert.match(missing, /required-sections-present/);
  assert.match(missing, /has no section 4/);
  assert.doesNotMatch(validateRecordBriefEntry(entry(null), 0, live as never).residue?.join("\n") ?? "", /required-sections-present/);
});
