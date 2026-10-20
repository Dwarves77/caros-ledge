import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { makeEnvelope, propagateEnvelope, stalenessOf } from "@/core/contracts/envelope";
import { renderEnvelopeColumnsSql, renderFactorCandidateViewSql, renderTierConstraintsSql, resolveActiveFactor, validateFactor, FACTOR_TIERS } from "@/core/contracts/factor-tier";
import { attributionsFor, licenceGate, mayEmbedAsSeed, renderDataSourceSeedSql, SOURCE_KEYS, SOURCE_LICENCES } from "@/core/contracts/source-licence";
import { assertVerbatim, groundCandidate, isVerbatim } from "@/core/contracts/verbatim";
import { isValid, LEG_MODE_CODES, MODE_CODES, normaliseMode, VOCABULARIES } from "@/core/contracts/vocabularies";
import { authorityFloorFor, authorityFloorForFact } from "@/core/grounding";

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
  assert.equal(authorityFloorForFact("standard", true), 4, "an own-authoring-body FACT of the voluntary family grounds at the issuing-body tier");
  assert.equal(authorityFloorForFact("standard", false), 2);
  assert.equal(authorityFloorForFact("regulation", true), 2, "a regulation has no own-body relaxation");
});

test("vocabularies: canonical transport mode is ocean; sea and maritime are input aliases; multimodal is corridor-only", () => {
  assert.equal(normaliseMode("sea"), "ocean");
  assert.equal(normaliseMode("Maritime"), "ocean");
  assert.equal(normaliseMode("ocean"), "ocean");
  assert.equal(normaliseMode("air"), "air");
  assert.equal(normaliseMode("teleport"), null);
  assert.equal(normaliseMode(null), null);
  assert.ok(MODE_CODES.includes("multimodal") && !LEG_MODE_CODES.includes("multimodal"));
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

test("INV-173: freshness is derived from the as-of date and the cadence, never asserted; an aggregate takes the weakest, least contractable and worst of its inputs", () => {
  const now = "2026-10-15";
  assert.equal(stalenessOf({ expected_refresh: "monthly", as_of: { event_date: "2026-10-01" } }, now), "current");
  assert.equal(stalenessOf({ expected_refresh: "monthly", as_of: { event_date: "2026-08-20" } }, now), "ageing");
  assert.equal(stalenessOf({ expected_refresh: "monthly", as_of: { event_date: "2026-06-30" } }, now), "stale");
  assert.equal(stalenessOf({ expected_refresh: "monthly", as_of: { event_date: "2025-01-01" } }, now), "frozen");
  assert.equal(stalenessOf({ expected_refresh: "irregular", as_of: { event_date: "2026-10-01" } }, now), "unknown");
  assert.equal(stalenessOf({ as_of: { event_date: "2026-10-01" } }, now), "unknown");
  const p = propagateEnvelope(
    [
      { origin_class: "official", derivation: "statutory_fixed", expected_refresh: "monthly", as_of: { event_date: "2026-10-10" } },
      { origin_class: "modelled", derivation: "estimated", expected_refresh: "monthly", as_of: { event_date: "2026-08-20" } },
      { origin_class: "verified", derivation: "observed", expected_refresh: "monthly", as_of: { event_date: "2026-10-12" } },
    ],
    now,
  );
  assert.deepEqual([p.origin_class, p.derivation, p.freshness, p.count], ["modelled", "estimated", "ageing", 3]);
  const unknown = propagateEnvelope([{ origin_class: "official" }, { origin_class: "made_up" }], now);
  assert.equal(unknown.origin_class, "community", "an unknown class falls to the weakest, with a note");
  assert.ok(unknown.notes.length > 0);
  assert.deepEqual(propagateEnvelope([], now), { origin_class: null, derivation: null, freshness: "unknown", count: 0, notes: [] });
});

const factor = (over: Record<string, unknown>) => ({ tier: "modal_default", scope_kind: "modal", source_key: "desnz_ghg_factors", as_at_date: "2026-01-01", valid_from: "2026-01-01", quantity_basis: "tonne_km", gwp_basis: "AR5_GWP100", wtt_co2e: 1, ttw_co2e: 2, wtw_co2e: 3, pedigree: 3, vehicle_class: "hgv", energy_carrier: "diesel", jurisdiction: "GB", mode: "road", ...over });

test("INV-174: a factor is selected by tier rank then scope specificity then recency; an unlicensed tier-1 row is skipped and reported, the licensed tier-4 row is served", () => {
  const cands = [
    factor({ tier: "carrier_primary", scope_kind: "movement", movement_ref: "m1", pedigree: 1, source_key: "clean_cargo_carrier" }),
    factor({ id: "licensed", as_at_date: "2026-02-01" }),
    factor({ id: "older", as_at_date: "2025-02-01" }),
  ];
  const r = resolveActiveFactor(cands as never);
  assert.equal((r.factor as { id?: string }).id, "licensed");
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0]?.reason, "licence");
  assert.deepEqual(r.attribution, attributionsFor(["desnz_ghg_factors"]));
  // recency breaks a tier + scope tie
  assert.equal((resolveActiveFactor([factor({ id: "older", as_at_date: "2025-02-01" }), factor({ id: "newer", as_at_date: "2026-02-01" })] as never).factor as { id?: string }).id, "newer");
  // invalid, superseded, out of window
  const out = resolveActiveFactor([factor({ id: "bad", pedigree: 1 }), factor({ id: "sup", superseded_by: "x" }), factor({ id: "old", valid_to: "2026-03-01" })] as never, { onDate: "2026-06-01" });
  assert.equal(out.factor, null);
  assert.deepEqual(out.skipped.map((s) => s.reason).sort(), ["invalid", "out_of_window", "superseded"]);
  // an unregistered source key fails the embed gate closed
  assert.equal(mayEmbedAsSeed("not_in_register"), false);
  assert.equal(licenceGate("not_in_register").ok, false);
  assert.equal(licenceGate("glec_framework").ok, false);
  assert.equal(licenceGate("desnz_ghg_factors").ok, true);
  assert.equal(resolveActiveFactor([factor({ source_key: "not_in_register" })] as never).factor, null);
});

test("validateFactor: a default may not present as primary data; a proxy names its donor; the three splits must add up", () => {
  assert.match(validateFactor(factor({ pedigree: 1 })).join("|"), /better than tier/);
  assert.match(validateFactor(factor({ tier: "proxy_estimate", pedigree: 4 })).join("|"), /donor/);
  assert.match(validateFactor(factor({ wtw_co2e: 99 })).join("|"), /does not equal/);
  assert.match(validateFactor(factor({ vehicle_class: null })).join("|"), /requires vehicle_class/);
  assert.deepEqual(validateFactor(factor({})), []);
  assert.ok(FACTOR_TIERS.carrier_primary?.isPrimaryData);
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
  assert.equal(sha(renderDataSourceSeedSql()), "270e0b0328e3da9b6b669fd734299ea7c9fc835352d7c037a470037ba2965ebb");
});

test("INV-174: tier rank decides before scope specificity, and scope specificity before recency", () => {
  const onlyTier = resolveActiveFactor([
    factor({ id: "modal", as_at_date: "2026-06-01" }),
    factor({ id: "operator-avg", tier: "verified_operator_avg", scope_kind: "operator_lane", operator_key: "op1", pedigree: 2, as_at_date: "2025-01-01" }),
  ] as never);
  assert.equal((onlyTier.factor as { id?: string }).id, "operator-avg", "the better tier wins even though it is older");
  const sameTier = resolveActiveFactor([
    factor({ id: "operator", tier: "programme_lane_avg", scope_kind: "operator_lane", operator_key: "op1", pedigree: 2, as_at_date: "2026-06-01" }),
    factor({ id: "carrier-lane", tier: "programme_lane_avg", scope_kind: "carrier_lane", operator_key: "op1", corridor_id: "cl:corridor:0123456789abcdef", pedigree: 2, as_at_date: "2025-01-01" }),
  ] as never);
  assert.equal((sameTier.factor as { id?: string }).id, "carrier-lane", "at one tier the more specific scope wins even though it is older");
});
