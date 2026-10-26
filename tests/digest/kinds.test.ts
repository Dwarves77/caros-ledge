// The digest's kinds registry (D1): seven kinds as data, each with its exporter, guide, validator, batch directory, lease key and apply path, every one of them real or its absence stated.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { FORMAT_SPECS } from "@/core/brief";
import { DIGEST_KINDS, digestKind, guideSkills } from "@/core/digest/kinds";
import { drainExporters } from "@/features/batches";
import { DRAIN_KINDS, KIND_ORDER, nextBatchPath } from "@/features/drain";

import { batchWorld } from "../batches/world.ts";

const SEVEN = ["ledger-verdicts", "host-verdicts", "needs-search", "question-answers", "theme-briefs", "item-briefs", "admin-opportunity-findings"];
const fileOf = (ref: string) => ref.split("#")[0] as string;
const exportsSymbol = (ref: string) => new RegExp(`export (?:async )?(?:function|const) ${ref.split("#")[1]}\\b`).test(readFileSync(fileOf(ref), "utf8"));

test("the registry holds the seven digest kinds, one each, and every one is a drain kind in plan order", () => {
  assert.deepEqual(DIGEST_KINDS.map((k) => k.id), SEVEN);
  assert.deepEqual(KIND_ORDER.slice(0, 7), SEVEN);
  assert.deepEqual(DRAIN_KINDS.map((k) => k.id).slice(7), ["theme-classification", "screen-verdict", "notification-outbox"], "the drain's own kinds follow; no kind is declared twice");
  assert.equal(new Set(DRAIN_KINDS.map((k) => k.id)).size, DRAIN_KINDS.length);
});

test("each kind's guide, validator and apply path exist", () => {
  for (const k of DIGEST_KINDS) {
    assert.ok(existsSync(k.authoringGuide.schema), `${k.id}: ${k.authoringGuide.schema} is missing`);
    assert.ok(k.authoringGuide.skills.length >= 2 && new Set(k.authoringGuide.skills).size === k.authoringGuide.skills.length, `${k.id}: skills`);
    for (const ref of [k.validator, k.applyPath]) assert.ok(existsSync(fileOf(ref)) && exportsSymbol(ref), `${k.id}: ${ref} is not an export of an existing file`);
    assert.ok(k.batchRe.test(`${k.batchPrefix}-001.json`) && k.batchDir === `drain/batches/${k.id}`, k.id);
    assert.equal(nextBatchPath(DRAIN_KINDS.find((d) => d.id === k.id)!, [`${k.batchPrefix}-004.json`]), `${k.batchDir}/${k.batchPrefix}-005.json`);
  }
});

test("the batch kit has an exporter for every registered kind, under the registry's id, and packet-reading kinds say so", () => {
  const exporters = drainExporters(batchWorld().deps);
  for (const k of DIGEST_KINDS) assert.equal(typeof exporters[k.exporter], "function", k.id);
  assert.deepEqual(DIGEST_KINDS.filter((k) => k.needsPackets).map((k) => k.id), ["theme-briefs", "item-briefs", "admin-opportunity-findings"]);
});

test("item briefs are authored under the writer skill of the format the item type demands: all five formats have one", () => {
  const item = digestKind("item-briefs");
  assert.deepEqual(Object.keys(item?.authoringGuide.byFormat ?? {}).sort(), FORMAT_SPECS.map((f) => f.formatType).sort());
  assert.equal(guideSkills(item!, "research_summary")[0], "writer-research-summary");
  assert.deepEqual(guideSkills(digestKind("theme-briefs")!), digestKind("theme-briefs")!.authoringGuide.skills);
});

test("the admin kind carries the three lenses and windows, and the pattern methods that map to them", () => {
  const admin = digestKind("admin-opportunity-findings")!;
  assert.deepEqual(Object.values(admin.lensOfMethod ?? {}).sort(), ["capital_offtake_grant", "penalty_abatement_crossover", "supply_demand_bottleneck"]);
  assert.deepEqual(admin.conditionalMethods, ["pattern_velocity_burst", "pattern_cross_modal"]);
});
