import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyLedgerDiff, buildCitationEdges, buildGateARow, citedHostGate, clearGateAState, diffLedger, eraseClaimWithProof, floorPool, groundBrief, groundRetryPlan, ledgerRegression, mintGates,
  nominateForSlot, poolHash, reattributeToFloor, scanGateA, summarizeLedger, uncoveredSlots, upsertGateAState, decideSlotClaim, hasValidWaiver,
} from "@/core/grounding";
import { mergeNullTierAggregate, summarizeNullTierAggregate } from "@/core/grounding/gates";
import { openFlagOnce } from "@/core/grounding/flags";

import { installLedgerRpcs } from "../_support/ledger-rpcs.ts";

import { factClaim, ITEM, makeWorld, OFFICIAL_TEXT, SOURCE, SPAN_FORCE, SPAN_PENALTY, SPAN_REPORT } from "./fixtures.ts";
import { MemDb } from "./memdb.ts";

const row = (text: string, over: Record<string, unknown> = {}) => ({ section_row_id: "s1", claim_text: text, claim_kind: "FACT", source_span: `span of ${text}`, source_id: SOURCE, search_result_id: "r1", source_tier_at_grounding: 1, ...over });

test("diffLedger is non-destructive: a result has no delete; a claim the new ledger omits is NOT-REPRODUCED, a duplicate collapses", () => {
  const existing = [row("a", { id: "1" }), row("b", { id: "2" })];
  const d = diffLedger(existing, [row("A"), row("c"), row("c")]);
  assert.equal(d.unchanged.length, 1, "text is matched normalised");
  assert.equal(d.add.length, 1);
  assert.deepEqual(d.notReproduced.map((x) => x.claim_text), ["b"]);
  assert.equal(diffLedger(existing, [row("a", { source_tier_at_grounding: 4 })]).change.length, 1, "a different tier is a change");
});

const REG_URL = "https://reg.test/law";
const OTHER = "b0000000-0000-4000-8000-0000000000bb";
/** A database with the ledger functions: the registered regulator source (tier 1), a news source (tier 6) and a capture of the regulator's page that holds the spans. */
const ledgerDb = (claims: Record<string, unknown>[]) => {
  const db = new MemDb();
  installLedgerRpcs(db);
  db.seed("intelligence_items", [{ id: ITEM }]);
  db.seed("sources", [{ id: SOURCE, url: REG_URL, base_tier: 1, status: "active" }, { id: OTHER, url: "https://news.test/story", base_tier: 6, status: "active" }]);
  db.seed("agent_run_searches", [{ id: "r1", intelligence_item_id: ITEM, result_url: REG_URL, result_content: "the span s is here, and the span two is here", result_index: 0 }]);
  db.seed("section_claim_provenance", claims);
  return db;
};
const stored = (over: Record<string, unknown> = {}) => ({ id: "c1", intelligence_item_id: ITEM, claim_text: "a", claim_kind: "FACT", source_span: "span s", source_id: SOURCE, source_tier_at_grounding: 4, section_row_id: "s1", search_result_id: "r1", ...over });

test("INV-158 / R2b I1: a change archives the prior state to claim_versions in the same call as the update; a refused write leaves the prior attribution and is counted failed, not changed; the tier written is the SOURCE's, not the incoming row's", async () => {
  const db = ledgerDb([stored()]);
  const diff = diffLedger(db.rows("section_claim_provenance") as never, [row("a", { source_tier_at_grounding: 6, source_span: "span s" })]);
  db.failWhen = (c) => (c.table === "claim_versions" && c.op === "insert" ? "disk full" : null);
  const failed = await applyLedgerDiff(db.client, ITEM, diff, { nowIso: "2026-10-15T00:00:00Z" });
  assert.deepEqual([failed.applied.failed, failed.applied.changed, failed.touchedFacts.length], [1, 0, 0], "a change that did not persist is not counted and is not a touched FACT");
  assert.match(failed.notes.join(" "), /change refused, the prior state stands/);
  assert.equal(db.rows("section_claim_provenance")[0]?.source_tier_at_grounding, 4, "the prior attribution survived");
  assert.equal(db.rows("claim_versions").length, 0, "nothing was archived by a call that did not complete");
  db.failWhen = null;
  const ok = await applyLedgerDiff(db.client, ITEM, diff, { nowIso: "2026-10-15T00:00:00Z" });
  assert.equal(ok.applied.changed, 1);
  assert.equal(db.rows("claim_versions").length, 1);
  assert.equal(db.rows("claim_versions")[0]?.source_tier_at_grounding, 4, "the archived state is the PRIOR one");
  assert.equal(db.rows("section_claim_provenance")[0]?.source_tier_at_grounding, 1, "the stored tier is the regulator source's (1), not the 6 the incoming row carried");
});

test("INV-158: a not-reproduced claim is KEPT unless replaceLedger, and then only after its archive and removal succeeded in one call", async () => {
  const mk = () => ledgerDb([stored({ claim_text: "old", source_tier_at_grounding: 1 })]);
  const kept = mk();
  const r1 = await applyLedgerDiff(kept.client, ITEM, diffLedger(kept.rows("section_claim_provenance") as never, []), {});
  assert.equal(r1.applied.notReproduced, 1);
  assert.equal(kept.rows("section_claim_provenance").length, 1);
  const failing = mk();
  failing.failWhen = (c) => (c.table === "claim_versions" && c.op === "insert" ? "boom" : null);
  const r2 = await applyLedgerDiff(failing.client, ITEM, diffLedger(failing.rows("section_claim_provenance") as never, []), { replaceLedger: true });
  assert.equal(failing.rows("section_claim_provenance").length, 1, "archive failed, so the claim is kept");
  assert.ok(r2.notes.some((n) => n.includes("claim kept")));
  const replaced = mk();
  const r3 = await applyLedgerDiff(replaced.client, ITEM, diffLedger(replaced.rows("section_claim_provenance") as never, []), { replaceLedger: true, batchId: "b1" });
  assert.equal(r3.applied.archived, 1);
  assert.equal(replaced.rows("section_claim_provenance").length, 0);
  assert.equal(replaced.rows("claim_versions")[0]?.supersede_reason, "superseded_by_record_briefs");
});

test("RD-45: eraseClaimWithProof needs a proof with a reason, archives FIRST, and deletes only in the same call as a successful archive", async () => {
  const db = ledgerDb([stored({ source_tier_at_grounding: 1 })]);
  const existing = db.rows("section_claim_provenance")[0] as never;
  await assert.rejects(eraseClaimWithProof(db.client, existing, ITEM, {} as never), /proof object with a `reason`/);
  await assert.rejects(eraseClaimWithProof(db.client, { claim_text: "x" } as never, ITEM, { reason: "r" }), /existing claim with an id/);
  assert.equal(db.rows("section_claim_provenance").length, 1);
  db.failWhen = (c) => (c.table === "claim_versions" && c.op === "insert" ? "no" : null);
  await assert.rejects(eraseClaimWithProof(db.client, existing, ITEM, { reason: "wrong" }), /ledger_remove_claim: no/);
  assert.equal(db.rows("section_claim_provenance").length, 1, "no delete when the archive failed");
  db.failWhen = null;
  await eraseClaimWithProof(db.client, existing, ITEM, { reason: "proven wrong by the primary" });
  assert.equal(db.rows("section_claim_provenance").length, 0);
  assert.equal(db.rows("claim_versions")[0]?.current_claim_id, null);
  assert.deepEqual(db.rows("claim_versions")[0]?.inaccuracy_proof, { reason: "proven wrong by the primary" });
});

test("INV-158 dominance: a weaker ledger is a regression on each axis; an equal-or-stronger one is not", () => {
  const prior = summarizeLedger([{ claim_kind: "FACT", source_tier_at_grounding: 1 }, { claim_kind: "FACT", source_tier_at_grounding: 1 }, { claim_kind: "FACT", source_tier_at_grounding: 1 }, { claim_kind: "FACT", source_tier_at_grounding: 1 }, { claim_kind: "ANALYSIS" }, { claim_kind: "ANALYSIS" }], 2);
  assert.equal(prior.facts, 4);
  assert.equal(prior.floorQualifying, 4);
  assert.equal(ledgerRegression(prior, { total: 6, facts: 4, floorQualifying: 4 }).regression, false);
  assert.equal(ledgerRegression(prior, { total: 6, facts: 4, floorQualifying: 0 }).regression, true, "floor-qualifying FACTs lost to zero");
  assert.equal(ledgerRegression(prior, { total: 1, facts: 1, floorQualifying: 1 }).regression, true, "total collapsed below half a non-trivial prior");
  assert.equal(ledgerRegression(summarizeLedger([], 2), { total: 0, facts: 0, floorQualifying: 0 }).regression, false, "an empty prior regresses to nothing");
});

test("INV-158 end to end: a re-ground that would weaken the prior ledger is refused, the prior ledger stands, and a flag is recorded", async () => {
  const w = makeWorld();
  w.db.seed("intelligence_item_sections", [{ item_id: ITEM, section_key: "1", section_order: 1, content_md: `${SPAN_REPORT} ${SPAN_PENALTY}` }]);
  const first = await groundBrief({ sb: w.deps.sb, sources: w.deps.sources, now: () => new Date("2026-10-15T00:00:00Z") }, { itemId: ITEM, ledger: [factClaim(SPAN_REPORT), factClaim(SPAN_PENALTY, { claim_text: "penalty" }), factClaim(SPAN_FORCE, { claim_text: "force" }), factClaim("This Regulation applies to operators of cargo aircraft and to operators of container vessels calling at Union ports.", { claim_text: "scope" }), factClaim("Regulation (EU) 2023/9999 of the European Parliament and of the Council on sustainable freight operations.", { claim_text: "title" })].map((c) => ({ ...c, search_result_id: null })) as never });
  assert.equal(first.ok, true, first.detail);
  w.db.rows("intelligence_items").find((r) => r.id === ITEM)!.provenance_status = "quarantined";
  const prior = w.db.rows("section_claim_provenance").length;
  const weak = await groundBrief({ sb: w.deps.sb, sources: w.deps.sources, now: () => new Date("2026-10-15T00:00:00Z") }, { itemId: ITEM, ledger: [{ ...factClaim("not in any capture at all"), search_result_id: null }] as never });
  assert.equal(weak.ok, false);
  assert.match(weak.detail, /REGRESSION/);
  assert.equal(w.db.rows("section_claim_provenance").length, prior, "the prior ledger stands");
  assert.ok(w.db.rows("integrity_flags").some((f) => f.created_by === "reground_regression_guard"));
});

test("groundRetryPlan: a source-less wall is structural (checked first), a deterministic brief flaw skips the re-roll, everything else is transient", () => {
  assert.equal(groundRetryPlan("no source_id"), "structural_hold");
  assert.equal(groundRetryPlan("validation failed [missing_required_slot]"), "reresearch_only");
  assert.equal(groundRetryPlan("validation failed [ungrounded_url, no source_id]"), "structural_hold");
  assert.equal(groundRetryPlan("rpc error: timeout"), "reground");
  assert.equal(groundRetryPlan(null), "reground");
});

test("INV-160: nominations are verbatim clauses of the pool; a FACT exists only on the author's confirmation, else GAP or RELABEL", () => {
  const noms = nominateForSlot("annual emissions reporting deadline", [{ url: "u", text: OFFICIAL_TEXT }], "reporting_deadline");
  assert.ok(noms.length > 0);
  for (const n of noms) assert.ok(OFFICIAL_TEXT.includes(n.span), "every nomination is a verbatim clause");
  assert.equal(decideSlotClaim({ slotKey: "s", nomination: noms[0] ?? null, confirmed: false, proseCovers: true }).kind, "RELABEL");
  assert.equal(decideSlotClaim({ slotKey: "s", nomination: noms[0] ?? null, confirmed: false, proseCovers: false }).kind, "GAP");
  assert.equal(decideSlotClaim({ slotKey: "s", nomination: noms[0] ?? null, confirmed: true, proseCovers: false }).kind, "FACT");
  assert.equal(decideSlotClaim({ slotKey: "s", nomination: null, confirmed: true, proseCovers: true }).kind, "RELABEL", "a confirmation with no nomination is no FACT");
  const slots = [{ slot_key: "tariff_schedule", description: "customs tariff schedule" }];
  assert.equal(uncoveredSlots("Nothing about duties here.", slots).length, 1);
  assert.equal(uncoveredSlots("[tariff_schedule] GAP not available.", slots).length, 0);
});

test("INV-160 end to end: ground forces a slot FACT only on a confirmation that is verbatim in a floor-pool source", async () => {
  const w = makeWorld({ itemType: "regulation" });
  w.db.seed("item_type_required_slots", [{ item_type: "regulation", slot_key: "reporting_deadline", description: "annual emissions report deadline" }]);
  w.db.seed("intelligence_item_sections", [{ item_id: ITEM, section_key: "1", section_order: 1, content_md: "Nothing relevant is stated." }]);
  const run = (confirmations?: Record<string, { span: string; url: string }>) => groundBrief({ sb: w.deps.sb, sources: w.deps.sources, now: () => new Date("2026-10-15T00:00:00Z") }, { itemId: ITEM, ledger: [], ...(confirmations ? { confirmations } : {}) });
  const forged = await run({ reporting_deadline: { span: "Operators may report whenever they like, at no cost.", url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R9999" } });
  assert.ok(forged.notes.some((n) => n.includes("confirmation is not a verbatim span")));
  assert.equal(w.db.rows("section_claim_provenance").filter((c) => c.claim_kind === "FACT").length, 0, "a forged confirmation never becomes a FACT");
  assert.equal(w.db.rows("section_claim_provenance").filter((c) => c.claim_kind === "GAP").length, 1, "the slot is an honest GAP");
});

test("CLASSIFY-FIX-2 A: S-NUMERIC reads a figure through an HTML space (&nbsp; and U+00A0 fold to a space); a span with no figure is still held", () => {
  const held = (claim_text: string, source_span: string) => mintGates([{ id: "n", claim_kind: "FACT", claim_text, source_span, source_id: SOURCE, source_tier_at_grounding: 1 }], { itemFloor: 2 }).numericHeldIds;
  assert.deepEqual(held("Recycled content of at least 15 % applies", "a share of at least 15&nbsp;% of the plastic"), []);
  assert.deepEqual(held("Recycled content of at least 50 % applies", "a share of at least 50 % of the plastic"), []);
  assert.deepEqual(held("Recycled content of at least 15 % applies", "a share of the plastic, no figure here"), ["n"]);
});

test("mint gates: S-CONFLATE and S-NUMERIC are HOLDS (the ids come back), below-floor and generic-source are counted", () => {
  const span = "Regulation (EU) 2023/1805 sets the FuelEU maritime requirements for ships.";
  const conflated = ["Regulation 2023/1805 applies", "Regulation 2022/999 applies", "ReFuelEU applies"].map((t, i) => ({ id: `f${i}`, claim_kind: "FACT", claim_text: t, source_span: span, source_id: SOURCE, source_tier_at_grounding: 1 }));
  const rep = mintGates(conflated, { itemFloor: 2 });
  assert.deepEqual(rep.conflateHeldIds.sort(), ["f0", "f1", "f2"]);
  assert.deepEqual(mintGates(conflated.slice(0, 2), { itemFloor: 2 }).conflateHeldIds, [], "two reuses are under the minimum");
  const numeric = (claim_text: string) => mintGates([{ id: "n", claim_kind: "FACT", claim_text, source_span: "A penalty of up to EUR 50 000 applies", source_id: SOURCE, source_tier_at_grounding: 1 }], { itemFloor: 2 }).numericHeldIds;
  assert.deepEqual(numeric("A penalty of EUR 75 000 applies"), ["n"]);
  assert.deepEqual(numeric("A penalty of EUR 50 000 applies"), []);
  const mixed = mintGates([{ id: "n1", claim_kind: "FACT", claim_text: "Fee of EUR 75 000", source_span: "Fee of EUR 50 000", source_id: null, source_tier_at_grounding: 4 }], { itemFloor: 2 });
  assert.equal(mixed.numericFacts.length, 1);
  assert.equal(mixed.belowFloor, 1);
  assert.equal(mixed.genericSource, 1);
  assert.equal(mintGates([{ id: "x", claim_kind: "FACT", claim_text: "t", source_span: "t", source_id: "susp", source_tier_at_grounding: 1 }], { itemFloor: 2, suspendedSourceIds: ["susp"] }).genericSource, 1, "a suspended source is generic");
});

test("INV-017/057: Gate A state has one writer shape: a figure or deadline in the brief with no FACT behind it is an orphan; the literal arm and the derived arm cover it", async () => {
  const brief = "The penalty is EUR 50 000. The regime enters into force on 1 January 2027.";
  const facts = [{ claim_text: "penalty", source_span: "A penalty of up to EUR 50 000 shall apply" }];
  const a = scanGateA(brief, facts);
  assert.ok(a.orphans.some((o) => o.class === "deadline" && /2027/.test(o.token)), JSON.stringify(a.orphans));
  assert.ok(!a.orphans.some((o) => o.class === "figure" && /50 000/.test(o.token)), "the figure is backed by a FACT");
  assert.equal(scanGateA(brief, [...facts, { claim_text: "x", source_span: "enters into force on 1 January 2027" }]).orphan_count, 0);
  assert.equal(scanGateA(brief, facts, new Set(["1 january 2027"])).orphan_count, 0, "a derived claim covers the deadline (arm B)");
  const gr = buildGateARow({ itemId: ITEM, fullBrief: brief, factClaims: facts, nowIso: "2026-10-15T00:00:00Z" });
  assert.match(gr.gate_a_version, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  assert.deepEqual(Object.keys(gr).sort(), ["gate_a_version", "intelligence_item_id", "orphan_count", "orphans", "scanned_at", "scanned_hash"]);
  const db = new MemDb();
  assert.deepEqual(await upsertGateAState(db.client, gr), { error: null });
  assert.deepEqual(await upsertGateAState(db.client, { ...gr, orphan_count: 0 }), { error: null });
  assert.equal(db.rows("item_gate_a_state").length, 1, "an upsert on the item, never a second row");
  db.failWhen = () => "locked";
  assert.deepEqual(await upsertGateAState(db.client, gr), { error: "locked" }, "a failure is returned, not swallowed");
  db.failWhen = null;
  assert.deepEqual(await clearGateAState(db.client, ITEM), { error: null });
  assert.equal(db.rows("item_gate_a_state").length, 0);
});

test("floor pool and re-attribution: best tier first, never below the floor, never from a span shorter than the minimum", () => {
  const pool = [{ url: "a", text: "x", tier: 5 }, { url: "b", text: SPAN_REPORT, tier: 2 }, { url: "c", text: SPAN_REPORT, tier: 1 }, { url: "d", text: "y", tier: null }];
  assert.deepEqual(floorPool(pool, 2).map((p) => p.url), ["c", "b"]);
  assert.deepEqual(floorPool(pool, null), []);
  assert.equal(reattributeToFloor(SPAN_REPORT, 5, floorPool(pool, 2), 2)?.url, "c");
  assert.equal(reattributeToFloor(SPAN_REPORT, 1, floorPool(pool, 2), 2), null, "already at the floor: not forced");
  assert.equal(reattributeToFloor("short span", 5, floorPool(pool, 2), 2), null);
  assert.equal(reattributeToFloor(SPAN_FORCE, 5, floorPool(pool, 2), 2), null, "a span in no floor source is not re-homed");
});

test("INV-157: the pool hash is order-independent and covers url and text", () => {
  const a = { url: "u1", text: "alpha" };
  const b = { url: "u2", text: "beta" };
  assert.equal(poolHash([a, b]), poolHash([b, a]));
  assert.notEqual(poolHash([a, b]), poolHash([a, { ...b, text: "beta2" }]));
  assert.notEqual(poolHash([{ url: "ab", text: "c" }]), poolHash([{ url: "a", text: "bc" }]), "the separator stops fields shifting across the boundary");
});

test("cited-host gate: a cited URL becomes a stub only on a known host or institution; a novel host is flagged and never stubbed", async () => {
  const db = new MemDb();
  db.seed("sources", [{ id: "s1", url: "https://a.test/rules" }]);
  const resolve = (url: string) => (/\/\/(b|b2)\.test/.test(url) ? ({ institution: "Known" } as never) : null);
  const sections = [{ content_md: "See https://a.test/page, https://b2.test/doc and https://c.test/page." }];
  const r = await citedHostGate(db.client, resolve, { itemId: ITEM, sourceUrl: "https://b.test/x", fullBrief: null, sections, usablePool: [], allPoolUrls: new Set(), nowIso: "2026-10-01T00:00:00Z", dry: true });
  assert.equal(r.stubbed, 2, "the known host and the known institution are stubbed");
  assert.deepEqual([...r.novel.keys()], ["https://c.test/page"], "the novel host is flagged, not stubbed");
});

test("null-tier aggregate: counts merge per item and the text follows rule 18 (register and rate, never refuse the figure)", () => {
  const a = mergeNullTierAggregate(null, "i1", { factCount: 2, samples: ["s1"] });
  const b = mergeNullTierAggregate(a, "i2", { factCount: 1, samples: ["s2"] });
  assert.deepEqual(b.perItemFacts, { i1: 2, i2: 1 });
  const s = summarizeNullTierAggregate("x.test", b);
  assert.equal(s.itemCount, 2);
  assert.equal(s.factCount, 3);
  assert.match(s.action, /register/i);
  assert.doesNotMatch(s.action, /relabel/i, "the old flag told the operator to relabel when the ruling says register and rate");
});

test("citation edges are one row per distinct source and drop falsy ids", () => {
  assert.deepEqual(buildCitationEdges(ITEM, [SOURCE, SOURCE, null, undefined, ""], "t").map((e) => e.source_id), [SOURCE]);
});

test("openFlagOnce dedupes on (created_by, subject_ref) while open and returns a note on any failure", async () => {
  const db = new MemDb();
  const f = { category: "data_quality", subject_type: "item" as const, subject_ref: ITEM, created_by: "t", description: "d" };
  assert.equal(await openFlagOnce(db.client, f), null);
  assert.equal(await openFlagOnce(db.client, f), null);
  assert.equal(db.rows("integrity_flags").length, 1);
  db.failWhen = (c) => (c.op === "insert" ? "denied" : null);
  assert.match(String(await openFlagOnce(db.client, { ...f, created_by: "u" })), /not written: denied/);
  db.failWhen = (c) => (c.op === "select" ? "down" : null);
  assert.match(String(await openFlagOnce(db.client, f)), /dedupe read failed/);
});

test("data-audit waiver: only an explicit, dated, unexpired waiver dispositions a block; time alone never clears it", () => {
  const now = new Date("2026-10-15T00:00:00Z");
  assert.equal(hasValidWaiver({ id: "1", recommended_actions: [] }, now), false);
  assert.equal(hasValidWaiver({ id: "1", recommended_actions: [{ action: "waiver", until: "2026-10-14" }] }, now), false);
  assert.equal(hasValidWaiver({ id: "1", recommended_actions: [{ action: "waiver", until: "2026-12-01" }] }, now), true);
  assert.equal(hasValidWaiver({ id: "1", recommended_actions: [{ action: "waiver", until: "garbage" }] }, now), false);
  assert.equal(hasValidWaiver(null, now), false);
});

test("error-body gate: a stored capture that is a failed fetch is excluded from grounding; a FACT only it contains is dropped and the capture is flagged for re-fetch", async () => {
  const claimOnlyInWall = "The bot page claims a rebate of EUR 99 applies to every operator at all times.";
  const w = makeWorld({ itemType: "regulation", pool: [{ url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R9999", text: OFFICIAL_TEXT }, { url: "https://example-news.test/wall", text: `Access Denied. ${claimOnlyInWall} ${"x".repeat(300)}` }] });
  w.db.seed("intelligence_item_sections", [{ item_id: ITEM, section_key: "1", section_order: 1, content_md: "Body." }]);
  const run = await groundBrief({ sb: w.deps.sb, sources: w.deps.sources, now: () => new Date("2026-10-15T00:00:00Z") }, { itemId: ITEM, ledger: [{ ...factClaim(claimOnlyInWall), search_result_id: null }, { ...factClaim(SPAN_REPORT), search_result_id: null }] as never });
  assert.equal(run.dropped, 1);
  assert.ok(!w.db.rows("section_claim_provenance").some((c) => String(c.source_span).includes("rebate")), "a span only the wall contains never reaches the ledger");
  const flag = w.db.rows("integrity_flags").find((f) => f.created_by === "error-body-gate");
  assert.ok(flag, "the failed fetch is surfaced");
  assert.match(String(flag?.description), /failed fetches/);
});

test("INV-HW-5: groundBrief (the owner under groundInjectedLedger) does not ground a span against a stored Cloudflare interstitial", async () => {
  const claimOnlyInWall = "The interstitial claims a rebate of EUR 77 applies to every operator at all times.";
  const w = makeWorld({ itemType: "regulation", pool: [{ url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R9999", text: OFFICIAL_TEXT }, { url: "https://example-news.test/cf", text: `Just a moment... Checking your browser. Enable JavaScript and cookies to continue. Cloudflare Ray ID 8a1b2c3d. ${claimOnlyInWall}` }] });
  w.db.seed("intelligence_item_sections", [{ item_id: ITEM, section_key: "1", section_order: 1, content_md: "Body." }]);
  const run = await groundBrief({ sb: w.deps.sb, sources: w.deps.sources, now: () => new Date("2026-10-15T00:00:00Z") }, { itemId: ITEM, ledger: [{ ...factClaim(claimOnlyInWall), search_result_id: null }] as never });
  assert.equal(run.dropped, 1);
  assert.ok(!w.db.rows("section_claim_provenance").some((c) => String(c.source_span).includes("rebate")));
});
