import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { makeEnvelope, stalenessOf } from "@/core/contracts/envelope";
import { renderEnvelopeColumnsSql, renderFactorCandidateViewSql, renderTierConstraintsSql } from "@/core/contracts/factor-tier";
import { renderDataSourceSeedSql, SOURCE_KEYS, SOURCE_LICENCES } from "@/core/contracts/source-licence";
import { assertVerbatim, groundCandidate, isVerbatim } from "@/core/contracts/verbatim";
import { isValid, LEG_MODE_CODES, normaliseMode, VOCABULARIES } from "@/core/contracts/vocabularies";
import { authorityFloorFor } from "@/core/grounding";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("INV-156 / ruling 1: ONE verbatim rule that mirrors criterion 3: case-insensitive, SPACE-trim only, null and empty never match", () => {
  const cap = "Operators shall report\tverified Emissions.\nBefore 30 April.";
  assert.equal(isVerbatim(cap, "operators shall report"), true, "case-insensitive");
  assert.equal(isVerbatim(cap, "  Operators shall report  "), true, "spaces are trimmed");
  assert.equal(isVerbatim(cap, "\tOperators shall report"), false, "a tab is not trimmed (btrim trims spaces only)");
  assert.equal(isVerbatim(cap, "report verified"), false, "a tab inside the capture is not a space");
  assert.equal(isVerbatim(cap, "Emissions.\nBefore 30 April"), true, "a newline inside the span matches a newline in the capture");
  assert.equal(isVerbatim(null, "x"), false);
  assert.equal(isVerbatim("abc", null), false);
  assert.equal(isVerbatim("abc", "   "), false, "an all-space span is empty after trim");
  assert.equal(assertVerbatim(cap, "operators shall report"), "operators shall report");
  assert.throws(() => assertVerbatim(cap, "a paraphrase"), /not a substring/);
  assert.equal(groundCandidate({ span_text: "Operators shall report" }, cap).ok, true);
  assert.equal(groundCandidate({ span_text: "" }, cap).ok, false);
  assert.equal(groundCandidate({ span_text: "Operators shall report" }, "").ok, false);
  assert.equal(groundCandidate({ span_text: "invented clause" }, cap).ok, false);
});

test("the verbatim rule cites the database function and the schema still has that function (a drift in the SQL fails here)", () => {
  const schema = readFileSync("supabase/schema.sql", "utf8");
  assert.match(schema, /position\(lower\(btrim\(/, "criterion 3 uses lower(btrim(span)) IN lower(content)");
});

test("PROP-157 / INV-081: the per-type authority floor mirrors the schema CASE (drift fails)", () => {
  const schema = readFileSync("supabase/schema.sql", "utf8");
  const m = /v_floor_max := CASE([\s\S]*?)END;/.exec(schema);
  assert.ok(m, "the v_floor_max CASE is in the schema");
  const sqlFloor = new Map<string, number | null>();
  for (const line of (m?.[1] ?? "").split("\n")) {
    const types = [...line.matchAll(/'([a-z_]+)'/g)].map((x) => x[1] as string);
    const n = /THEN (\d+)/.exec(line)?.[1];
    if (n) for (const t of types) sqlFloor.set(t, Number(n));
  }
  assert.ok(sqlFloor.size >= 9);
  for (const [t, n] of sqlFloor) assert.equal(authorityFloorFor(t), n, `floor for ${t}`);
  for (const t of ["market_signal", "regional_data", "initiative", "unknown_type"]) assert.equal(authorityFloorFor(t), null, `${t} is floor-exempt like the ELSE branch`);
});

test("vocabularies: canonical transport mode is ocean; sea and maritime are input aliases; multimodal is corridor-only", () => {
  assert.equal(normaliseMode("sea"), "ocean");
  assert.equal(normaliseMode("Maritime"), "ocean");
  assert.equal(normaliseMode("ocean"), "ocean");
  assert.equal(normaliseMode("air"), "air");
  assert.equal(normaliseMode("teleport"), null);
  assert.equal(normaliseMode(null), null);
  assert.ok(isValid("transport_mode", "multimodal") && !LEG_MODE_CODES.includes("multimodal"));
  assert.equal(isValid("transport_mode", "ocean"), true);
  assert.equal(isValid("transport_mode", "sea"), false, "sea is an input alias, never a stored value");
  assert.ok(Object.keys(VOCABULARIES.duty_holder_class ?? {}).length >= 12, "duty_holder_class is the authoritative list");
});

test("INV-173: makeEnvelope refuses a missing observation that carries a value; a missing observation is value-null", () => {
  const base = { unit: "EUR/t", derivation: "observed", as_of: { event_date: "2026-09-01" } };
  assert.throws(() => makeEnvelope({ ...base, obs_status: "M", value: 0 }), /zero-fill guard/);
  assert.throws(() => makeEnvelope({ ...base, obs_status: "M", value: 12 }), /zero-fill guard/);
  assert.equal(makeEnvelope({ ...base, obs_status: "M" }).value, null);
  assert.equal(makeEnvelope({ ...base, value: 12 }).value, 12);
  assert.throws(() => makeEnvelope({ derivation: "observed", as_of: { event_date: "2026-09-01" } }), /missing required field: unit/);
  assert.throws(() => makeEnvelope({ ...base, derivation: "guessed" }), /unknown derivation/);
  assert.throws(() => makeEnvelope({ ...base, low: 5 }), /low and high must be provided together/);
  assert.throws(() => makeEnvelope({ ...base, low: 5, high: 3 }), /low must be <= high/);
  assert.throws(() => makeEnvelope({ ...base, value: 9, low: 1, high: 3 }), /within \[low, high\]/);
  assert.ok(Object.isFrozen(makeEnvelope({ ...base, value: 1 })));
});

test("INV-173: freshness is derived from the as-of date and the cadence, never asserted", () => {
  const now = "2026-10-15";
  assert.equal(stalenessOf({ expected_refresh: "monthly", as_of: { event_date: "2026-10-01" } }, now), "current");
  assert.equal(stalenessOf({ expected_refresh: "monthly", as_of: { event_date: "2026-08-20" } }, now), "ageing");
  assert.equal(stalenessOf({ expected_refresh: "monthly", as_of: { event_date: "2026-06-30" } }, now), "stale");
  assert.equal(stalenessOf({ expected_refresh: "monthly", as_of: { event_date: "2025-01-01" } }, now), "frozen");
  assert.equal(stalenessOf({ expected_refresh: "irregular", as_of: { event_date: "2026-10-01" } }, now), "unknown");
  assert.equal(stalenessOf({ as_of: { event_date: "2026-10-01" } }, now), "unknown");
});


test("the register: every entry has a verdict, the count line matches SOURCE_KEYS, and the licence triage partitions the register", () => {
  assert.equal(SOURCE_KEYS.length, Object.keys(SOURCE_LICENCES).length);
  const sql = renderDataSourceSeedSql();
  assert.match(sql, new RegExp(`-- Register verified through \\d{4}-\\d{2}-\\d{2}\\. ${SOURCE_KEYS.length} sources:`));
  assert.equal((sql.match(/^ {2}\('/gm) ?? []).length, SOURCE_KEYS.length);
});

test("proof 6: the SQL generators reproduce migration 258's generated blocks (pinned from a byte comparison against the migration; the register adds migration 281's row)", () => {
  // Verified 2026-10-15 against old_repo/supabase/migrations/258_emission_factors_and_licence_gate.sql: the tier_constraints,
  // candidate_view and envelope_columns blocks are byte-identical after the "GENERATED by <path>" line; the data_source_seed block is
  // identical except the register line, the one row (ecb) added by migration 281 and the nine rows R2g added on 2026-10-20. A change to the register or the tiers changes a pin.
  assert.equal(sha(renderEnvelopeColumnsSql()), "0bf06c03b80acd5b6c3f22e4d5ae6226ecfa29ebe4543ed44ec1c9c67558a82c");
  assert.equal(sha(renderTierConstraintsSql()), "bb88f6aeaae15a989337f5617c319da1a76384bc4a3f042b569a8a648a546bcb");
  assert.equal(sha(renderFactorCandidateViewSql()), "21d18a0016b7bd9b1d2b5ba3a3c84198ff7b4f06c1fb0590793d731ee65113e9");
  assert.equal(sha(renderDataSourceSeedSql()), "eae05af95a884c6067594ef6bd08a4e6abaf144e97ae0466c7d8165b4d6b36d9");
});

