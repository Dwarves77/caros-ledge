import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import type { AttentionCounts } from "@/features/admin/api/attention";
import { PLATFORM_CATEGORIES } from "@/features/admin/vocab";
import { flagKinds, issueRows, issueTotal, kindLabel, SECTIONS, subTabCount, tileCount, valueCell } from "@/features/admin/ui/console-math";

const counts: AttentionCounts = {
  provisional_sources_pending: 3,
  staged_updates_pending: 2,
  staged_updates_materialization_failed: 1,
  integrity_flags_unresolved: 4,
  platform_integrity_flags_open: 5,
  source_attribution_mismatches: 0,
  auto_approved_awaiting_spotcheck: 6,
  coverage_gaps_critical: 7,
  ingest_rejections_untriaged: 8,
  total: 36,
};

test("INV-290: the platform category list equals the integrity_flags CHECK in the schema", () => {
  const sql = readFileSync("supabase/schema.sql", "utf8");
  const check = /integrity_flags_category_check CHECK \(\(category = ANY \(ARRAY\[([^\]]*)\]/.exec(sql)?.[1] ?? "";
  const inSchema = [...check.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
  assert.deepEqual([...PLATFORM_CATEGORIES].sort(), [...inSchema].sort());
});

test("INV-281: the issues rail total is the sum of the rows drawn, a badge equals its list, and a count the database has not reported is neither a zero nor a row", () => {
  const rows = issueRows(counts);
  assert.equal(issueTotal(rows), counts.total, "the rail total equals the database total");
  assert.equal(flagKinds(counts).reduce((t, k) => t + (k.count ?? 0), 0), counts.integrity_flags_unresolved + counts.platform_integrity_flags_open + counts.ingest_rejections_untriaged!);
  assert.equal(subTabCount("Flags & rejections", { attention: counts, sources: null, disagreements: null }), 17, "the sub-tab badge equals the flags list");
  const old = { ...counts };
  delete old.ingest_rejections_untriaged;
  assert.ok(!issueRows(old).some((r) => r.key === "rejections"), "an unreported count is not a row");
  assert.equal(flagKinds(old)[2]!.count, null, "its badge renders bare");
});

test("a tile or sub-tab with no successful read renders bare, never a fabricated zero; a zero count renders bare too", () => {
  for (const s of SECTIONS) assert.equal(tileCount(s.name, { orgs: null, attention: null, counts: null }), null, `${s.name} tile`);
  assert.equal(tileCount("Workspaces", { orgs: 0, attention: null, counts: null }), 0, "a real zero from a read that succeeded is a zero");
  assert.equal(subTabCount("Provisional review", { attention: { ...counts, provisional_sources_pending: 0 }, sources: null, disagreements: null }), null);
  assert.equal(subTabCount("Source registry", { attention: null, sources: 12, disagreements: null }), 12);
  assert.equal(subTabCount("Nope", { attention: counts, sources: 1, disagreements: 1 }), null);
});

test("a factor shows every populated leg and the absence of a value is stated, never a zero", () => {
  assert.equal(valueCell({ wtt_co2e: 1.5, ttw_co2e: null, wtw_co2e: 3 }), "WTT 1.5 · WTW 3");
  assert.equal(valueCell({ wtt_co2e: null, ttw_co2e: null, wtw_co2e: null }), "not stated");
  assert.equal(valueCell({ wtt_co2e: 0, ttw_co2e: null, wtw_co2e: null }), "WTT 0", "a stated zero is shown");
  assert.equal(kindLabel({ mode: "road", vehicle_class: null, energy_carrier: "diesel", jurisdiction: "EU", operator_key: "acme", corridor_id: null }), "road · diesel · EU · operator:acme");
});
