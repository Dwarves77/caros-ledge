// The shared write-back (ENGINE-UNBLOCK-1 lane C, operator engine spec 2026-10-26): theme briefs write back signposts, coverage gaps and new connections under the same verification as the admin kind. A failing element refuses the entry by name; a coverage gap is queued once for the
// hunt (a holdings-need flag needs-search exports) and never fetched; the closed lists the module keeps are held equal to the sources they mirror.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { computeMemberHash } from "@/core/flywheel/themes";
import { applyBatch } from "@/features/batches";
import type { BatchExport } from "@/features/batches";
import { needsExporter } from "@/features/batches/kinds/needs-search/needs";
import { EDGE_TABLES, SOURCE_CLASSES, verifyWriteback, writeWriteback } from "@/features/batches/kit/writeback";

import { batchFile, ITEM, OFFICIAL_TEXT, passingReview } from "./world.ts";
import { CLAIM_A, EVENT_B, SECOND, THEME, themeWorld } from "./worlds.ts";

const E1 = "cl:mandate:ddd0000000000001";
const E2 = "cl:node:ddd0000000000002";
const hash = computeMemberHash([SECOND, ITEM]);
const QUOTE = OFFICIAL_TEXT.slice(0, 60);
const wbWorld = () => {
  const w = themeWorld();
  w.db.seed("entities", [{ entity_id: E1, status: "active" }, { entity_id: E2, status: "active" }]);
  w.db.rpcs.register_inference_record = (x, d) => {
    const id = `e0000000-0000-4000-8000-${String(d.rows("inference_records").length + 1).padStart(12, "0")}`;
    d.rows("inference_records").push({ inference_id: id, claim_text: x.p_claim_text, status_token: x.p_status_token, cited_item_ids: x.p_cited_item_ids, method_id: x.p_method_id });
    return { data: id };
  };
  return w;
};
const poolId = (w: ReturnType<typeof wbWorld>): string => String(w.db.rows("agent_run_searches").find((r) => r.intelligence_item_id === ITEM && String(r.result_content ?? "").includes(QUOTE))?.id);
const wbParts = (w: ReturnType<typeof wbWorld>) => ({
  signposts: [{ claim_text: "Carriers add the reporting surcharge to the rate card", observable: "the published carrier surcharge tariff for the next quarter", source_class: "news", confirms_if: "a surcharge line citing the reporting duty appears", falsified_if: "the next tariff carries no such line", by: "2028-01-31" }],
  coverage_gaps: [{ missing_input: "the carriers' published surcharge tariffs for the reporting duty", source_class: "analysis" }],
  connections: [{ from_entity_id: E1, to_entity_id: E2, relation: "competes_for_feedstock", reason_token: "duty_shapes_surcharge", quote: { capture_id: poolId(w), text: QUOTE } }],
});
const entry = (w: ReturnType<typeof wbWorld>, over: Record<string, unknown> = {}) => {
  const e = {
    theme_id: THEME, member_hash: hash, title: "The reporting duty and the surcharge it triggers",
    sections: { connection: "Both items concern the annual reporting duty and how carriers price it.", meaning: "A forwarder should expect the duty to reach the rate card.", ramifications: "### Regulations\nThe duty needs an owner in each operating unit.", watch: "Watch the next dated step.", gaps: "No operations item yet." },
    claims: [{ section: "connection", text: "annual reporting duty", member_id: ITEM, claim_ids: [CLAIM_A] }, { section: "watch", text: "Watch the next dated step.", member_id: SECOND, claim_ids: [EVENT_B] }],
    ...wbParts(w), ...over,
  };
  return { ...e, review: passingReview(e, "theme-briefs") };
};
const apply = (w: ReturnType<typeof wbWorld>, entries: unknown[], dry = false) => applyBatch("theme-briefs", w.deps, { content: JSON.stringify(batchFile("theme-briefs", entries)), dry });
const notes = (r: { notes: string[] }) => r.notes.join("\n");
const gapFlags = (w: ReturnType<typeof wbWorld>) => w.db.rows("integrity_flags").filter((f) => f.created_by === "holdings-need:synthesis-gap");

test("a theme brief writes back its signpost, its connection and its coverage gap, queued as a find-source need and never fetched; a re-apply writes nothing new", async () => {
  const w = wbWorld();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("a network call was attempted"); }) as never;
  try {
    const r = await apply(w, [entry(w)]);
    assert.equal(r.counts.applied, 1, notes(r));
    assert.deepEqual([r.counts.briefs_written, r.counts.signposts_registered, r.counts.connections_written, r.counts.gaps_queued], [1, 1, 1, 1]);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(w.db.rows("theme_briefs").length, 1);
  assert.equal(w.db.rows("entity_relations").length, 1);
  assert.deepEqual(w.db.rows("inference_records").map((i) => i.method_id), ["theme-briefs-signpost"]);
  const [f] = gapFlags(w);
  const action = (f?.recommended_actions as Record<string, unknown>[])[0]!;
  assert.deepEqual([f?.status, f?.subject_ref, action.action, action.source_class, action.subject, action.raised_by], ["open", `gap:${verifyWriteback({ coverage_gaps: wbParts(w).coverage_gaps }, "t", { captures: new Map(), ids: new Map(), now: new Date("2026-10-26"), itemIds: [] }).plan.gaps[0]?.key}`, "find-source", "analysis", THEME, "theme-briefs"]);
  const needs = (await needsExporter(w.db.client)({ limit: 50 })) as BatchExport;
  assert.ok((needs.items as { kind: string; text: string }[]).some((n) => n.kind === "holdings-need" && n.text.includes("surcharge tariffs")), "needs-search exports the gap as a need");
  const again = await apply(w, [entry(w)]);
  assert.equal(again.counts.already_applied, 1, notes(again));
  assert.deepEqual([w.db.rows("inference_records").length, w.db.rows("entity_relations").length, gapFlags(w).length], [1, 1, 1]);
});

test("a fabricated entity, a non-verbatim quote, a past signpost date and an unknown source class each refuse the theme entry by name, and the brief is not written", async () => {
  const w = wbWorld();
  const conn = (over: Record<string, unknown>) => ({ ...wbParts(w).connections[0]!, ...over });
  assert.match(notes(await apply(w, [entry(w, { connections: [conn({ to_entity_id: "cl:node:ffffffffffffffff" })] })])), /connections\[0\]\.to_entity_id: unknown entity id "cl:node:ffffffffffffffff"|does not exist/);
  assert.match(notes(await apply(w, [entry(w, { connections: [conn({ quote: { capture_id: poolId(w), text: "a sentence the capture never states" } })] })])), /connections\[0\]\.quote: the quote is not in capture/);
  assert.match(notes(await apply(w, [entry(w, { signposts: [{ ...wbParts(w).signposts[0]!, by: "2020-01-01" }] })])), /signposts\[0\]: by 2020-01-01 is not in the future/);
  assert.match(notes(await apply(w, [entry(w, { signposts: [{ ...wbParts(w).signposts[0]!, source_class: "rumour" }] })])), /signposts\[0\]: source_class "rumour" is not an institution class/);
  assert.match(notes(await apply(w, [entry(w, { coverage_gaps: [{ missing_input: "", source_class: "news" }] })])), /coverage_gaps\[0\]: must be \{ missing_input/);
  assert.deepEqual([w.db.rows("theme_briefs").length, w.db.rows("inference_records").length, w.db.rows("entity_relations").length, gapFlags(w).length], [0, 0, 0, 0]);
});

test("a coverage gap raised by two kinds, or twice, is one queued flag that gains the second raiser", async () => {
  const w = wbWorld();
  await apply(w, [entry(w)]);
  const plan = verifyWriteback({ coverage_gaps: [{ missing_input: "The carriers' published   surcharge tariffs for the reporting duty", source_class: "analysis" }] }, "t", { captures: new Map(), ids: new Map(), now: new Date("2026-10-26"), itemIds: [ITEM] });
  assert.deepEqual(plan.errors, []);
  const r = await writeWriteback(w.deps, plan.plan, { kind: "admin-opportunity-findings", batch: "b2", subject: "cluster-9", findingId: null, citedItemIds: [ITEM], inputs: [] });
  assert.deepEqual([r.counts.gaps_queued, r.counts.gaps_deduplicated, gapFlags(w).length], [0, 1, 1]);
  assert.deepEqual((gapFlags(w)[0]?.recommended_actions as Record<string, unknown>[]).map((a) => a.action === "raised-again" ? a.subject : a.action), ["find-source", "cluster-9"]);
  await writeWriteback(w.deps, plan.plan, { kind: "admin-opportunity-findings", batch: "b2", subject: "cluster-9", findingId: null, citedItemIds: [ITEM], inputs: [] });
  assert.equal((gapFlags(w)[0]?.recommended_actions as unknown[]).length, 2, "the same raiser is recorded once");
});

test("a signpost on rows that name no intelligence item is refused: it cites at least one", () => {
  const r = verifyWriteback({ signposts: wbParts(wbWorld()).signposts }, "t", { captures: new Map(), ids: new Map(), now: new Date("2026-10-26"), itemIds: [] });
  assert.match(r.errors.join("\n"), /signposts\[0\]: a signpost cites at least one intelligence item/);
});

test("the closed lists the write-back keeps equal the sources they mirror: source classes are keys of the host class table; evidence tables are the migration's derivation-edge list", () => {
  const classes = Object.keys(JSON.parse(readFileSync("src/core/sources/data/host-class.json", "utf8")) as Record<string, unknown>);
  for (const c of SOURCE_CLASSES) assert.ok(classes.includes(c), `${c} is not a key of the host class table`);
  const sql = readFileSync("supabase/migrations/0134_connect_2_spine.sql", "utf8");
  const line = sql.split("\n").find((l) => l.includes("ADD CONSTRAINT derivation_edges_from_table_allowed")) ?? "";
  const tables = [...line.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
  assert.deepEqual([...EDGE_TABLES].sort(), tables.sort());
});
