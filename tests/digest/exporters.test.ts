// The digest's exporters (D1): the item bundle joins obligations, scores, source tiers with bias tags and the packet input; the theme bundle declares its packet; the admin export groups patterns by lens. Packets are
// absent from the database the exporter reads, so each bundle carries an empty list and says so; nothing here invents a packet.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { packetReader } from "@/core/digest/packets-client";
import { applyBatch, drainExporters, exportBatch } from "@/features/batches";
import type { BatchExport } from "@/features/batches";

import { ITEM, NO_PACKETS, noPackets, NOW, SOURCE } from "../batches/world.ts";
import { recordWorld, themeWorld } from "../batches/worlds.ts";
import { connect, patterns, propagate } from "../coupling/_world.ts";
import { plantReaderRefs, triangleFixture } from "../coupling/_triangles.ts";

const none = noPackets;
const V = (n: number) => `d1000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AGO = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const pattern = (n: number, method: string, over: Record<string, unknown> = {}) => ({ value_id: V(n), method_id: method, method_version: "1.0.0", entity_id: `e${n}`, derivation: "calculated", origin_class: "derived", lifecycle: "emerging", admissibility: "analysis_ok", base_confidence: 0.7, asserted_at: AGO(10), invalidated_at: null, ...over });

test("the packets door adds each member row's text and surface to packets.ts's packet, and answers the marker packets.ts states", async () => {
  const f = triangleFixture();
  assert.equal((await propagate(f)).exit, 0);
  plantReaderRefs(f);
  assert.equal((await connect(f)).exit, 0);
  const ids = patterns(f).map((r) => String(r.value_id));
  const read = await packetReader(f.d.sb)(ids);
  assert.equal(read.marker, null);
  const members = read.packets.flatMap((p) => p.members);
  assert.ok(members.length > 0 && members.every((m) => typeof m.text === "string" && m.text.length > 0), "every row offers text to cite");
  assert.ok(members.filter((m) => m.item_id).every((m) => m.surface !== null), "a row that belongs to an item sits on that item's surface");
  assert.deepEqual(await packetReader(f.d.sb)([]), { packets: [], marker: null });
});

test("item-briefs: the bundle carries the obligation objects, the scores, the cited sources with tier and bias tags, the role vocabulary and the packet input", async () => {
  const w = recordWorld();
  w.db.seed("obligation_objects", [{ obligation_id: "ob-1", instrument_item_id: ITEM, pinpoint_citation: "Article 5", verbatim_text: "Operators shall report.", binding_position: "binding", duty_holder_class: ["operator"], first_deadline: "2027-01-01", status: "current" }]);
  w.db.seed("item_impact_scores", [{ item_id: ITEM, cost: 3, compliance: 4, operational: 2, basis: {}, missing: [], method_version: "1.0.0" }]);
  w.db.seed("section_claim_provenance", [{ id: "c1000000-0000-4000-8000-0000000000aa", intelligence_item_id: ITEM, claim_kind: "FACT", claim_text: "t", source_span: "s", source_id: SOURCE }]);
  w.db.seed("source_bias_tags", [{ id: "a1000000-0000-4000-8000-0000000000aa", source_id: SOURCE, dimension: "institutional_stance", tag: "official", confidence: 0.9 }]);
  const out = (await drainExporters({ ...w.deps, packets: none })["item-briefs"]!({ limit: 5, mode: "pending" })) as BatchExport;
  assert.equal(out.ok, true, out.error);
  const item = out.items[0] as Record<string, unknown>;
  assert.deepEqual((item.obligation_objects as Array<Record<string, unknown>>).map((o) => [o.obligation_id, o.first_deadline]), [["ob-1", "2027-01-01"]]);
  assert.deepEqual((item.scores as { impact: Record<string, unknown> }).impact.compliance, 4);
  const src = (item.sources as Array<{ id: string; effective_tier?: unknown; base_tier: number; bias_tags: Array<{ tag: string }> }>)[0]!;
  assert.deepEqual([src.id, src.base_tier, src.bias_tags.map((b) => b.tag)], [SOURCE, 1, ["official"]]);
  assert.deepEqual(item.packets, []);
  assert.deepEqual((item.authoring_skills as string[])[0], "writer-market-signal-brief", "the writer skill of the item type's format leads");
  const summary = out.summary as { packets: string; workspace_role_vocabulary: Array<{ code: string }> };
  assert.equal(summary.packets, NO_PACKETS);
  assert.ok(summary.workspace_role_vocabulary.length > 3);
  assert.ok(Array.isArray(item.pool) && item.source_pool_hash, "the record export it extends is intact");
});

test("theme-briefs: each bundle declares its packet input, and the export says the packets are pending", async () => {
  const w = themeWorld();
  const out = (await drainExporters({ ...w.deps, packets: none })["theme-briefs"]!({ limit: 5, mode: "pending" })) as BatchExport;
  assert.equal(out.ok, true, out.error);
  assert.ok(out.items.length >= 1);
  assert.deepEqual((out.items[0] as Record<string, unknown>).packets, []);
  assert.equal((out.summary as { packets: string }).packets, NO_PACKETS);
  assert.ok((out.items[0] as Record<string, unknown>).member_hash, "the live validator's material is intact");
});

test("admin-opportunity-findings: patterns of the window that no current finding answers, grouped by lens; a P1 or P4 pattern is named residue while its packet is pending", async () => {
  const w = recordWorld();
  w.db.seed("derived_values", [
    pattern(1, "pattern_penalty_abatement", { asserted_at: AGO(5) }),
    pattern(2, "pattern_mandate_capacity", { asserted_at: AGO(9) }),
    pattern(3, "pattern_lead_lag", { asserted_at: AGO(7) }),
    pattern(4, "pattern_velocity_burst"),
    pattern(5, "pattern_mandate_capacity", { admissibility: "stale" }),
    pattern(6, "pattern_mandate_capacity", { asserted_at: AGO(400) }),
    pattern(7, "pattern_mandate_capacity", { lifecycle: "superseded" }),
    pattern(8, "pattern_mandate_capacity", { invalidated_at: AGO(1) }),
    pattern(9, "pattern_mandate_capacity"),
    pattern(10, "carbon_cost_per_feu"),
  ]);
  w.db.seed("admin_opportunity_findings", [{ id: V(90), lens: "supply_demand_bottleneck", window: "0-6m", pattern_value_id: V(9), title: "t", sourced_finding_md: "f", inferences: [], signpost_inference_ids: [], claim_provenance: [], created_at: AGO(1), superseded_by: null }]);
  const out = (await drainExporters({ ...w.deps, packets: none })["admin-opportunity-findings"]!({ limit: 20, mode: "pending" })) as BatchExport;
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.items.map((i) => [(i as Record<string, unknown>).lens, (i as Record<string, unknown>).pattern_value_id]), [["supply_demand_bottleneck", V(2)], ["penalty_abatement_crossover", V(1)], ["capital_offtake_grant", V(3)]], "grouped by lens, in lens order, oldest first within a lens");
  assert.deepEqual((out.items[0] as Record<string, unknown>).packets, []);
  const s = out.summary as { per_lens: Record<string, number>; already_answered: number; packets: string; windows: string[] };
  assert.deepEqual([s.per_lens.supply_demand_bottleneck, s.per_lens.penalty_abatement_crossover, s.per_lens.capital_offtake_grant, s.already_answered, s.packets], [1, 1, 1, 1, NO_PACKETS]);
  assert.deepEqual(s.windows, ["0-6m", "6-18m", "18-36m"]);
  assert.deepEqual((out.residue as Array<Record<string, unknown>>).map((r) => [r.id, r.reason]), [[V(4), NO_PACKETS]]);
});

test("admin-opportunity-findings: the kit exports it to numbered parts, and its apply refuses a file that is not a batch", async () => {
  const w = recordWorld();
  w.db.seed("derived_values", [pattern(1, "pattern_mandate_capacity")]);
  const dir = mkdtempSync(join(tmpdir(), "caros-admin-"));
  const r = await exportBatch("admin-opportunity-findings", { ...w.deps, packets: none }, { outDir: dir });
  assert.equal(r.outcome, "ok", r.notes.join(";"));
  const ids = (r.data as { ids: { exported_ids: string[]; parts: string[] } }).ids;
  assert.deepEqual(ids.exported_ids, [V(1)]);
  assert.equal((JSON.parse(readFileSync(ids.parts[0] as string, "utf8")) as { kind: string }).kind, "admin-opportunity-findings");
  const applied = await applyBatch("admin-opportunity-findings", w.deps, { content: "{}", dry: false });
  assert.equal(applied.outcome, "failed");
  assert.match(applied.notes[0] ?? "", /batch refused whole/);
});
