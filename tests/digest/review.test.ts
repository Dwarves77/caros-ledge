// The second reader (DIGEST-1 D4 as re-specified by the eval-audit ruling): binary judges, one failure mode each; every required judge passes or the brief is residue naming the criterion. INV-DIG-3 (a conditional section filled with no grounded claim),
// INV-DIG-6 (the regulation format's always-present sections), the version stamp of the reader's values, and the judges' own data (each carries its origin and, once measured, its TPR and TNR).
import assert from "node:assert/strict";
import { test } from "node:test";

import { MENU, READER_METHOD } from "@/core/digest/kinds";
import raw from "@/core/digest/data/judges.json";
import { review, secondReaderBlock } from "@/core/digest/review";
import { applyBatch } from "@/features/batches";
import { validateRecordBriefEntry } from "@/features/batches/kinds/item-briefs/validate";

import { batchFile, batchWorld, ITEM, metadata, NOW, passingReview, recordEntry, SPAN_REPORT, factClaim } from "../batches/world.ts";
import { recordWorld } from "../batches/worlds.ts";

const apply = (w: ReturnType<typeof batchWorld>, e: Record<string, unknown>) => applyBatch("item-briefs", w.deps, { content: JSON.stringify(batchFile("item-briefs", [e])), dry: false, runId: "r" });
const names = (kind: string) => new Map(secondReaderBlock(kind).judges.map((s) => [s.slice(0, 3), s.slice(4)]));
const withJudge = (e: Record<string, unknown>, id: string, v: unknown) => ({ ...e, review: { ...(e.review as object), judges: { ...((e.review as { judges: object }).judges), [id]: v } } });

test("the registry stamps every reader value: the kinds version, the method string and the menu bounds are data", () => {
  assert.match(READER_METHOD, /^reader@\d+\.\d+\.\d+$/);
  assert.deepEqual([MENU.cap, MENU.maxLinked, MENU.maxRegion, MENU.aliases], [64, 24, 3, 4]);
});

test("which judges apply: by kind, by format and by the typed block the entry carries", () => {
  const base = { metadata: { format_type: "market_signal_brief" } };
  const ids = (kind: string, e: Record<string, unknown>) => review(kind, e).required.map((id) => names(kind).get(id));
  assert.ok(!ids("item-briefs", base).includes("obligation-field-quote-states-it") && !ids("item-briefs", base).includes("connection-reason-in-quote"));
  assert.ok(ids("item-briefs", { ...base, obligation_fields: [{}] }).includes("obligation-field-quote-states-it"));
  assert.ok(ids("item-briefs", { ...base, connections: [{}] }).includes("connection-reason-in-quote"));
  assert.ok(!ids("item-briefs", base).includes("pico-and-dissent-fidelity") && ids("item-briefs", { metadata: { format_type: "research_summary" } }).includes("pico-and-dissent-fidelity"));
  assert.ok(ids("admin-opportunity-findings", {}).includes("cross-surface-direction") && !ids("item-briefs", base).includes("cross-surface-direction"));
  assert.ok(ids("item-briefs", base).includes("entity-ids-complete"), "the emission items apply to every item brief");
  assert.ok(raw.judges.every((j) => j.prompt.length >= 40 && j.origin), "each judge is one prompt for one failure mode, with where it came from");
  assert.ok(raw.judges.every((j) => j.validation && j.validation.n_pass > 0 && j.validation.n_fail > 0), "each judge carries its measured TPR and TNR with the counts they rest on");
});

test("review: a missing verdict set, a missing verdict, an unreasoned pass and a fail each keep the brief out and name the judge and its criterion; all pass keeps it in", () => {
  const e = { metadata: { format_type: "market_signal_brief" } } as Record<string, unknown>;
  const ok = { ...e, review: passingReview(e) };
  assert.deepEqual(review("item-briefs", ok), { required: review("item-briefs", e).required, failed: [], score: 1, reasons: [], residue: false, reviewed_by: "second-reader-test" });
  assert.match(review("item-briefs", e).reasons[0] ?? "", /verdicts are missing/);
  const first = { id: review("item-briefs", e).required[0]!, criterion: names("item-briefs").get(review("item-briefs", e).required[0]!)! };
  const dropped = { ...ok, review: { ...(ok.review as object), judges: Object.fromEntries(Object.entries((ok.review as { judges: object }).judges).filter(([k]) => k !== first.id)) } };
  assert.match(review("item-briefs", dropped).reasons.join(), new RegExp(`${first.id} ${first.criterion}: no verdict`));
  assert.match(review("item-briefs", withJudge(ok, first.id, { pass: true, evidence: "" })).reasons.join(), /a verdict without its evidence/);
  const failed = review("item-briefs", withJudge(ok, first.id, { pass: false, evidence: "the label overstates what the source says" }));
  assert.deepEqual([failed.residue, failed.reasons.length, failed.failed], [true, 1, [first.id]]);
  assert.match(failed.reasons[0] ?? "", new RegExp(`^${first.id} ${first.criterion}: failed \\(the label overstates`));
  assert.ok(failed.score < 1);
});

test("INV-DIG-3: a brief that fills a conditional section with no grounded claim is kept out by the second reader, naming the criterion; the same brief with the verdict pass applies", async () => {
  const w = recordWorld();
  const planted = { ...recordEntry(w.db), body: String(recordEntry(w.db).body).replace("Competitive Implications\n\n", "Competitive Implications\n\nNo guidance has been published; operators should expect none soon. ") };
  const judge = raw.judges.find((j) => j.criterion === "conditional-section-has-grounded-claim")!;
  const caught = await apply(w, withJudge(planted, judge.id, { pass: false, evidence: "section 5 states there is no guidance while holding no grounded claim" }));
  assert.equal(caught.counts.applied ?? 0, 0);
  // TRAP B: reviewed residue cleanly recorded in brief_reviews is not a failure of the step (an unrecorded one, or a refused entry, still is: tests/batches/kit.test.ts INV-210).
  assert.equal(caught.outcome, "ok");
  assert.equal(caught.counts.residue, 1);
  assert.match(caught.notes.join("\n"), new RegExp(`second reader: ${judge.id} conditional-section-has-grounded-claim: failed`));
  // DRAIN-FIX-2 D1: no applied review row, but the residue entry is recorded as residue with its failing criterion and reviewer.
  const rows = w.db.rows("brief_reviews") as { residue: boolean; reasons: string; reviewed_by: string; subject_id: string; kind: string }[];
  assert.equal(rows.filter((r) => !r.residue).length, 0, "a brief under the bar leaves no applied review row");
  assert.deepEqual(rows.map((r) => [r.kind, r.subject_id, r.residue, r.reviewed_by]), [["item-briefs", ITEM, true, "second-reader-test"]]);
  assert.match(rows[0]!.reasons, new RegExp(`${judge.id} conditional-section-has-grounded-claim: failed`));
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

test("the judges' failure modes are the error-discovery taxonomy: every error code a judge cites exists and lists it; a code-eval mode has no judge", () => {
  const codes = new Map(raw.failure_modes.map((f) => [f.code, f]));
  for (const j of raw.judges) for (const c of /error code (B-\d+)/.exec(j.origin)?.slice(1) ?? []) assert.ok(codes.get(c)?.judges.includes(j.id), `${j.id} cites ${c}`);
  assert.ok(raw.failure_modes.filter((f) => f.kind === "code-eval").every((f) => f.judges.length === 0));
  assert.ok(raw.failure_modes.filter((f) => f.kind === "judge").every((f) => f.judges.length > 0 && f.judges.every((id) => raw.judges.some((j) => j.id === id))));
});
