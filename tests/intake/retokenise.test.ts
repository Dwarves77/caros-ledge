// MINT-1 (ADR-050): the record mint's absence is a token, the readers take both forms, the backfill rewrites the old sentence once and then writes nothing.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";

import { ABSENCE_TOKEN, parseRecordSections } from "@/core/brief";
import { buildGateARow } from "@/core/grounding";
import { retokeniseRecordGaps } from "@/features/intake/record-facts/retokenise";
import { runBriefs } from "@/core/turn/stages/briefs";
import { ResearchDetail, type ResearchDetailProps } from "@/features/research/ui/ResearchDetail";

import { connectDb } from "../connect/world.ts";
import { renderApp, textOf } from "../_support/render.ts";

const END = "A full-brief regrounding will re-examine this gap when this item upgrades from record to brief.";
const legacy = (slot: string, what: string) => `[${slot}] No verbatim ${what} statement was located in the captured source text for this record-grade item. ${END}`;
const FACT = "[effective_date] The captured source states, verbatim: «shall enter into force on the day of publication»";
const STUB = "Catalogue record: extracted facts only, full brief pending.";
const now = () => new Date("2026-10-25T00:00:00Z");

const world = (extra: Record<string, unknown[]> = {}) => {
  const gaps = [legacy("penalty_summary", "penalty summary"), legacy("due_date", "due-date")];
  const brief = ["*" + STUB + "*", "", "## Verbatim facts", "", `- ${FACT}`, "", "## Not stated in the captured source", "", ...gaps.map((g) => `- ${g}`), "", "Source: https://example.test/a"].join("\n");
  const stateRow = buildGateARow({ itemId: "i1", fullBrief: brief, factClaims: [{ claim_text: FACT, source_span: "shall enter into force on the day of publication" }], nowIso: "2026-10-01T00:00:00Z" });
  return connectDb({
    intelligence_items: [{ id: "i1", item_grade: "record", full_brief: brief, updated_at: "2026-10-01T00:00:00Z" }, { id: "i2", item_grade: "brief", full_brief: "A written brief.", updated_at: "2026-10-01T00:00:00Z" }],
    intelligence_item_sections: [{ id: "s1", item_id: "i1", section_key: "record_facts", content_md: [FACT, ...gaps].join("\n"), updated_at: "2026-10-01T00:00:00Z" }, { id: "s2", item_id: "i1", section_key: "sources_and_citations", content_md: "Source: https://example.test/a" }],
    section_claim_provenance: [
      { id: "c1", intelligence_item_id: "i1", claim_kind: "FACT", claim_text: FACT, source_span: "shall enter into force on the day of publication" },
      { id: "c2", intelligence_item_id: "i1", claim_kind: "GAP", claim_text: gaps[0] },
      { id: "c3", intelligence_item_id: "i1", claim_kind: "GAP", claim_text: gaps[1] },
      { id: "c4", intelligence_item_id: "i2", claim_kind: "ANALYSIS", claim_text: "Written by a reader." },
    ],
    item_gate_a_state: [{ ...stateRow }],
    ...extra,
  });
};
const rows = (w: ReturnType<typeof world>, t: string) => (w.tables[t] ?? []) as Record<string, unknown>[];

test("INV-MINT-2 the backfill rewrites every legacy line once, keeps Gate A current, and a second pass writes nothing", async () => {
  const w = world();
  const first = await retokeniseRecordGaps(w.db, { limit: 200, now });
  assert.equal(first.outcome, "ok");
  assert.deepEqual(first.counts, { items_scanned: 1, items_rewritten: 1, items_failed: 0, lines_rewritten: 6, remaining: 0 });
  const [item] = rows(w, "intelligence_items");
  assert.match(String(item?.full_brief), new RegExp(`- \\[penalty_summary\\] ${ABSENCE_TOKEN}\\n- \\[due_date\\] ${ABSENCE_TOKEN}\\n`));
  assert.doesNotMatch(String(item?.full_brief), /A full-brief regrounding/);
  assert.ok(String(item?.full_brief).includes(FACT), "a FACT line is untouched");
  assert.equal(rows(w, "intelligence_item_sections")[0]?.content_md, [FACT, `[penalty_summary] ${ABSENCE_TOKEN}`, `[due_date] ${ABSENCE_TOKEN}`].join("\n"));
  const claims = rows(w, "section_claim_provenance");
  assert.deepEqual(claims.map((c) => c.claim_text), [FACT, `[penalty_summary] ${ABSENCE_TOKEN}`, `[due_date] ${ABSENCE_TOKEN}`, "Written by a reader."]);
  const state = rows(w, "item_gate_a_state")[0];
  assert.equal(state?.scanned_hash, buildGateARow({ itemId: "i1", fullBrief: String(item?.full_brief), factClaims: [{ claim_text: FACT, source_span: "shall enter into force on the day of publication" }], nowIso: "x" }).scanned_hash);
  const before = JSON.stringify(w.tables);
  const writes = w.writes.length;
  const second = await retokeniseRecordGaps(w.db, { limit: 200, now });
  assert.deepEqual(second.counts, { items_scanned: 0, items_rewritten: 0, items_failed: 0, lines_rewritten: 0, remaining: 0 });
  assert.equal(w.writes.length, writes, "a second pass writes nothing");
  assert.equal(JSON.stringify(w.tables), before, "every row, updated_at included, is as the first pass left it");
});

test("a refused transaction leaves the legacy lines and the old Gate A state, reports the item, and the next pass finishes it", async () => {
  const w = world({});
  const broken = connectDb({ ...w.tables }, { rpc: (name) => (name === "ledger_apply_ops" ? { error: { message: "refused" } } : undefined) });
  const oldHash = rows(broken, "item_gate_a_state")[0]?.scanned_hash;
  const r = await retokeniseRecordGaps(broken.db, { limit: 200, now });
  assert.equal(r.outcome, "partial");
  assert.equal(r.counts.items_failed, 1);
  assert.equal(r.counts.items_rewritten, 0);
  assert.ok((r.counts.remaining ?? 0) > 0);
  assert.equal(rows(broken, "item_gate_a_state")[0]?.scanned_hash, oldHash, "the Gate A state is put back");
  assert.ok(rows(broken, "section_claim_provenance").some((c) => String(c.claim_text).includes(END)));
  const fixed = await retokeniseRecordGaps(w.db, { limit: 200, now });
  assert.equal(fixed.counts.remaining, 0);
});

test("a dry pass counts what it would rewrite and writes nothing; the bound is the limit", async () => {
  const w = world();
  const dry = await retokeniseRecordGaps(w.db, { limit: 200, dry: true, now });
  assert.deepEqual(dry.counts, { items_scanned: 1, items_planned: 1, items_failed: 0, lines_planned: 6, remaining: 2 });
  assert.equal(w.writes.length, 0);
});

test("the briefs stage runs the backfill alone on retokenise: { limit }", async () => {
  const w = world();
  const r = await runBriefs({ input: { retokenise: { limit: 5 } }, dry: false } as never, { sb: w.db, now } as never);
  assert.equal(r.counts.lines_rewritten, 6);
  assert.equal(r.counts.remaining, 0);
});

test("the reader takes the token and the old sentence as the same stated absence, shown by the copy map's label", () => {
  const sections = [{ section_key: "record_facts", content_md: [FACT, `[penalty_summary] ${ABSENCE_TOKEN}`, legacy("due_date", "due-date")].join("\n") }];
  const parsed = parseRecordSections(sections);
  assert.deepEqual(parsed?.gaps.map((g) => [g.slotKey, g.kind, g.text]), [["penalty_summary", "GAP", "No verbatim statement in the captured source"], ["due_date", "GAP", "No verbatim statement in the captured source"]]);
  assert.equal(parsed?.facts.length, 1);
  assert.equal(parsed?.slotFieldCount, 3);
});

test("INV-MINT-3 a record page shows the label beside each slot and the counts line, as text only", () => {
  const props = {
    resource: { id: "r1", title: "A finding", priority: "MODERATE", fullBrief: "", sources: [], itemGrade: "record" },
    sections: [{ section_key: "record_facts", section_order: 2, content_md: [FACT, `[penalty_summary] ${ABSENCE_TOKEN}`].join("\n") }],
    claimTiers: {}, recommendedActions: [], connectionRows: [],
    crossPage: { intersections: null, theme: null, inferences: [], degraded: [] },
    related: { items: [], failed: false, reason: null },
    nowIso: "2026-10-25T00:00:00.000Z",
    assessment: { assessment: null, signposts: [], history: [], historyComplete: true, failed: false },
  } as unknown as ResearchDetailProps;
  const html = renderApp(createElement(ResearchDetail, props));
  const text = textOf(html);
  assert.match(text, /1 of 2 record fields not stated by the source/);
  assert.match(text, /Penalty summary: No verbatim statement in the captured source/);
  assert.doesNotMatch(text, /full-brief regrounding/);
  const gap = /<p[^>]*>[^<]*1 of 2 record fields.*?<\/p>/s.exec(html)?.[0] ?? "";
  assert.ok(gap && !/<(?:a|button|input|select)\b/.test(gap), "the absence lines add no interactive target");
});
