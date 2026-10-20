// What a list row draws (IMPACT-1, I4): INV-IMP-3 (a NULL dimension is never drawn as 0 and its missing input is named on the row), INV-IMP-4 (every list row's impact equals item_impact_scores for that item, over every reader), INV-IMP-5 (the client score of
// one item differs between two workspaces and is not stored).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { composeImpact } from "@/core/impact/read";
import { toListRowFields } from "@/core/lists";
import { mapRows } from "@/features/lists";

import schema from "../_support/schema.json" with { type: "json" };

import { I1, I2, I3, item, world } from "./_world.ts";

const O1 = "00000000-0000-4000-8000-0000000000a1";
const O2 = "00000000-0000-4000-8000-0000000000a2";
const rpcRow = (id: string) => ({ id, legacy_id: null, title: `Row ${id.slice(-1)}`, item_type: "regulation", effective_priority: "HIGH", added_date: "2026-01-01", transport_modes: ["ocean"], jurisdiction_iso: ["EU"] });
const score = (item_id: string, over: Record<string, unknown> = {}) => ({ item_id, cost: 1, compliance: 2, operational: 3, basis: {}, missing: [], method_version: "impact_scores@1.0.0", computed_at: "2026-10-15T12:00:00.000Z", ...over });
const settings = (org_id: string, modes: string[], jurisdictions: Record<string, number>) => ({ org_id, sector_profile: [], jurisdiction_weights: jurisdictions, profile: { transport_modes: modes, roles: [] } });
const made = () =>
  world(
    [item(I1, { transport_modes: ["ocean"] }), item(I2, { transport_modes: ["ocean"] }), item(I3, { transport_modes: ["ocean"] })],
    [],
    {
      item_impact_scores: [score(I1), score(I2, { cost: null, missing: ["cost"] }), score(I3, { compliance: null, operational: null, missing: ["obligations", "operational"] })],
      workspace_settings: [settings(O1, ["ocean"], { EU: 1 }), settings(O2, ["air"], { US: 1 })],
    },
  );

test("INV-IMP-3 on the row: a score with every dimension known is drawn with the workspace's client score; a NULL dimension, a missing score row and a missing workspace each leave no score and name the first input the row waits for", async () => {
  const db = made();
  const { active } = await mapRows(db.client, [rpcRow(I1), rpcRow(I2), rpcRow(I3), rpcRow("11111111-0000-4000-8000-000000000009")], { orgId: O1 });
  const by = Object.fromEntries(active.map((r) => [r.id, r]));
  assert.deepEqual(by[I1]?.impactScores, { cost: 1, compliance: 2, client: 2, operational: 3 });
  assert.equal(by[I1]?.impactAbsence, undefined);
  assert.deepEqual([by[I2]?.impactScores, by[I2]?.impactAbsence], [undefined, "No cost figure yet"], "a NULL cost is not a 0: the row draws the dash and says what it needs");
  assert.deepEqual([by[I3]?.impactScores, by[I3]?.impactAbsence], [undefined, "No obligations extracted yet"], "the first missing input, in the order obligations, cost, modes and scenarios");
  assert.deepEqual([by["11111111-0000-4000-8000-000000000009"]?.impactScores, by["11111111-0000-4000-8000-000000000009"]?.impactAbsence], [undefined, "No obligations extracted yet"], "an item with no score row is waiting for its first reading");
  const anon = await mapRows(db.client, [rpcRow(I1)], {});
  assert.deepEqual([anon.active[0]?.impactScores, anon.active[0]?.impactAbsence], [undefined, "No workspace profile yet"], "no workspace to read relevance for: the client dimension is unknown, not 0");
  assert.equal(composeImpact(undefined, 2).absence, "No obligations extracted yet");
  assert.deepEqual(composeImpact({ item_id: I3, cost: 1, compliance: null, operational: 1, missing: ["obligations"] }, null).absence, "No obligations extracted yet", "a stored absence outranks the missing workspace");
  const fields = toListRowFields(by[I2]!, new Date("2026-10-15T00:00:00Z"));
  assert.deepEqual([fields.impact, fields.impactAbsence, fields.dueAbsence], [null, "No cost figure yet", "No milestone dates"], "the row fields carry the sentences the row draws beside its dashes");
});

test("INV-IMP-4: every row the list readers build has the impact item_impact_scores holds for its item, and the readers that build rows all go through the one function", async () => {
  const db = made();
  const { active } = await mapRows(db.client, [rpcRow(I1)], { orgId: O1 });
  const stored = db.rows("item_impact_scores").find((r) => r.item_id === I1)!;
  assert.deepEqual([active[0]?.impactScores?.cost, active[0]?.impactScores?.compliance, active[0]?.impactScores?.operational], [stored.cost, stored.compliance, stored.operational]);
  assert.equal(db.writes().filter((c) => c.op !== "select").length, 0, "reading writes nothing");
  // The structure over the readers: the two functions that turn listing rows into Resources each call attachImpact, and nothing else assigns a Resource's impact.
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : /\.tsx?$/.test(n) ? [join(dir, n)] : []));
  const src = files("src").map((f) => [f.replaceAll("\\", "/"), readFileSync(f, "utf8")] as const);
  const callers = (needle: string) => src.filter(([f, t]) => t.includes(needle) && !f.endsWith("map-rows.ts") && !f.endsWith("lists/index.ts")).map(([f]) => f);
  assert.deepEqual(callers("categoryResourceFields"), ["src/features/lists/category.ts"], "one reader builds category rows");
  for (const f of ["src/features/lists/map-rows.ts", "src/features/lists/category.ts"]) assert.match(src.find(([n]) => n === f)![1], /await attachImpact\(/, `${f} gives its rows their impact`);
  assert.deepEqual(src.filter(([, t]) => /\.impactScores\s*=[^=]|impactScores:\s*\{/.test(t)).map(([f]) => f).filter((f) => !f.includes("/privacy/ui-fixtures/") && !f.startsWith("src/core/types")), ["src/features/lists/impact.ts"], "the one writer of a Resource's impactScores");
});

test("INV-IMP-5: the client score of one item differs between two workspaces with different relevance, and it is computed at read time, never stored", async () => {
  const db = made();
  const a = await mapRows(db.client, [rpcRow(I1)], { orgId: O1 });
  const b = await mapRows(db.client, [rpcRow(I1)], { orgId: O2 });
  assert.deepEqual([a.active[0]?.impactScores?.client, b.active[0]?.impactScores?.client], [2, 1], "the ocean workspace in the EU against the air workspace in the US");
  assert.deepEqual([a.active[0]?.impactScores?.cost, b.active[0]?.impactScores?.cost], [1, 1], "the stored dimensions are the same for both");
  assert.ok(!(schema as { tables: Record<string, { columns: string[] }> }).tables.item_impact_scores!.columns.includes("client"), "the table has no client column");
  assert.ok(!db.rows("item_impact_scores").some((r) => "client" in r), "and no row carries one");
});

test("a failed read of the scores, the profile or the item's tags fails the read (never a row with no impact that says nothing); the pending-migration state reads as no scores", async () => {
  const bad = (table: string) => {
    const db = made();
    db.fail(table, "select", "read error");
    return mapRows(db.client, [rpcRow(I1)], { orgId: O1 });
  };
  await assert.rejects(() => bad("item_impact_scores"), /item_impact_scores read failed/);
  await assert.rejects(() => bad("workspace_settings"), /workspace_settings read failed/);
  await assert.rejects(() => bad("intelligence_items"), /intelligence_items read failed/);
  const pending = made();
  pending.fail("item_impact_scores", "select", "relation does not exist", { code: "42P01" });
  const r = await mapRows(pending.client, [rpcRow(I1)], { orgId: O1 });
  assert.equal(r.active[0]?.impactAbsence, "No obligations extracted yet");
});
