// The per-rule cases of the brief validator (VALID-1): every rule runs on its planted violation (the register's sample or one built from the rule's definition, tests/fixtures/validator-report/rows.ts) and on a clean brief of the same format.
import assert from "node:assert/strict";
import { test } from "node:test";

import { REGISTRY, runRule, type BriefModel, type ItemColumns, type Violation } from "@/core/brief/rules";

import { ROWS } from "../fixtures/validator-report/rows.ts";

export const rowOf = (id: string) => REGISTRY.find((r) => r.id === id) ?? assert.fail(`${id} is not in data/rules.json`);
/** One registered rule over one brief, as the validator runs it (the registry row decides the prose view). */
export const run = (id: string, brief: BriefModel, item: ItemColumns): Violation | null => runRule(rowOf(id), brief, item);
export const fixtureRow = (id: string) => ROWS.find((r) => r.id === id) ?? assert.fail(`no fixture row ${id}`);

export function ruleTests(id: string): void {
  test(`${id}: the planted violation returns a Violation carrying the rule id`, () => {
    const plant = fixtureRow(id);
    assert.ok(rowOf(id).applies_to.includes(plant.brief.format), "the registry row applies to the plant's format");
    const v = run(id, plant.brief, plant.item);
    assert.equal(v?.rule, id);
    assert.ok(v && v.detail.length > 0 && v.excerpt.length <= 80);
  });
  test(`${id}: a clean brief of the same format returns null`, () => {
    const format = fixtureRow(id).brief.format;
    const clean = fixtureRow(format === "regulatory_fact_document" ? "clean-regulatory" : "clean-market");
    assert.equal(run(id, clean.brief, clean.item), null);
  });
}
