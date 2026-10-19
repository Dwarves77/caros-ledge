import assert from "node:assert/strict";
import { test } from "node:test";

import { eraseQuarantined, idStamp, planQuarantine, rehomeQuarantined, resolveQuarantined } from "@/features/intake";
import { DEFERRAL_WINDOW_DAYS, DWELL_BOUND_DAYS, buildDeferralCandidate, computeQuarantineDwell, isValidDeferral, planDispositions, type ReasonClass } from "@/features/intake/quarantine/planner";
import { DELETABLE_REASONS } from "@/features/intake/quarantine/erase";
import { HOLD_TYPES } from "@/features/intake/quarantine/resolver";

import { installLedgerRpcs } from "../_support/ledger-rpcs.ts";

import { ITEM, NOW, OFFICIAL_URL, OTHER_URL, SOURCE, CORROB, SPAN_REPORT, makeWorld } from "./fixtures.ts";
import { MemDb } from "./memdb.ts";

const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();
const deferral = (over: Record<string, unknown> = {}) => ({ reason: "Needs-acquire: held pending a re-ground through the injected-brief seam by a session.", deferred_until: ahead(10), owner: "intake-session", resolution_event: "a session-authored ledger is grounded for this item", ...over });
const flag = (id: string, daysAgo: number, over: Record<string, unknown> = {}) => ({ subject_ref: id, created_at: ago(daysAgo), created_by: "investigation", recommended_actions: [], ...over });

test("INV-002 / INV-054 / ruling 3: a deferral is valid only with a named blocker, a disposition path, a checkable event, a real owner, a future date INSIDE the 14-day bound", () => {
  assert.equal(DWELL_BOUND_DAYS, 14);
  assert.equal(DEFERRAL_WINDOW_DAYS, 14);
  assert.deepEqual(isValidDeferral(deferral(), NOW), { ok: true });
  assert.deepEqual(isValidDeferral(deferral({ deferred_until: ahead(14) }), NOW).ok, true, "exactly at the bound");
  const bad = (over: Record<string, unknown>) => isValidDeferral(deferral(over), NOW);
  assert.match(String((bad({ deferred_until: ahead(30) }) as { error: string }).error), /beyond the 14-day dwell bound/, "the old 30-day window is refused");
  assert.match(String((bad({ deferred_until: ago(1) }) as { error: string }).error), /not in the future/);
  assert.match(String((bad({ deferred_until: "someday" }) as { error: string }).error), /does not parse/);
  assert.match(String((bad({ reason: "blocked" }) as { error: string }).error), /too short/);
  assert.match(String((bad({ reason: "This is a long enough reason that names nothing at all about the path forward." }) as { error: string }).error), /names no disposition path/);
  assert.match(String((bad({ resolution_event: "" }) as { error: string }).error), /resolution_event is required/);
  assert.match(String((bad({ owner: "TBD" }) as { error: string }).error), /placeholder/);
  assert.equal(isValidDeferral(null, NOW).ok, false);
});

test("INV-055 / proof 8: the dwell classifier: within bound, enqueue-missing, deferred, and undispositioned (resurrected when a deferral once existed)", () => {
  const items = [{ id: "within" }, { id: "missing" }, { id: "undisp" }, { id: "deferred" }, { id: "expired" }, { id: "toolong" }];
  const flags = [
    flag("within", 3),
    flag("undisp", 30),
    flag("deferred", 30), flag("deferred", 20, { created_by: "disposition_deferred", recommended_actions: [{ action: "defer", deferral: deferral() }] }),
    flag("expired", 40), flag("expired", 30, { created_by: "disposition_deferred", recommended_actions: [{ action: "defer", deferral: deferral({ deferred_until: "2000-01-01T00:00:00Z" }) }] }),
    flag("toolong", 40), flag("toolong", 10, { created_by: "disposition_deferred", recommended_actions: [{ action: "defer", deferral: deferral({ deferred_until: ahead(60) }) }] }),
  ];
  const d = computeQuarantineDwell({ items, flags, now: NOW });
  assert.deepEqual(d.withinBound.map((i) => i.id), ["within"]);
  assert.deepEqual(d.enqueueMissing.map((i) => i.id), ["missing"]);
  assert.deepEqual(d.deferred.map((i) => i.id), ["deferred"]);
  assert.deepEqual(d.undispositioned.map((i) => [i.id, i.resurrected]), [["undisp", false], ["expired", true], ["toolong", true]]);
  assert.ok(d.undispositioned.every((i) => i.ageDays > 14));
});

test("INV-114 / proof 8: every live-quarantined item has a planned disposition with a named reason class for each resolver outcome; every class builds a VALID deferral", () => {
  const items = [{ id: "a", item_type: "regulation" }, { id: "b", item_type: "regulation" }, { id: "c", item_type: "regulation" }, { id: "d", item_type: "regulation" }, { id: "e", item_type: "technology" }, { id: "f", item_type: "regulation" }];
  const flags = items.map((i) => flag(i.id, 30));
  const decisions = new Map([["a", { outcome: "needs-acquire" }], ["b", { outcome: "cheap-ok-still-quarantined" }], ["c", { outcome: "error" }], ["d", { outcome: "stale-snapshot" }]]);
  const { plan, counts, deferralCandidates } = planDispositions({ items, flags, cheapDecisionByItemId: decisions, now: NOW });
  const cls = Object.fromEntries(plan.map((p) => [p.item_id, p.reason_class]));
  assert.deepEqual(cls, { a: "needs_acquire", b: "provenance_gate_insufficient", c: "verify_error", d: "stale_snapshot", e: "held_type_q2_gate", f: "needs_acquire" });
  assert.equal(deferralCandidates.length, 6);
  assert.equal(counts["deferral_candidate:needs_acquire"], 2);
  for (const c of deferralCandidates) assert.equal(isValidDeferral(c, NOW).ok, true, `${c.reason_class} builds a valid deferral`);
  for (const k of ["needs_acquire", "stale_snapshot", "held_type_q2_gate", "provenance_gate_insufficient", "verify_error"] as ReasonClass[]) assert.ok(buildDeferralCandidate("x", k, NOW).deferred_until < ahead(15));
  assert.throws(() => buildDeferralCandidate("x", "nope" as ReasonClass, NOW), /unknown reason class/);
  assert.ok(HOLD_TYPES.has("research_finding") && !HOLD_TYPES.has("regulation"));
});

const quarantinedWorld = (daysOld: number) => {
  const w = makeWorld({ itemType: "regulation" });
  w.db.seed("integrity_flags", [flag(ITEM, daysOld, { status: "open", subject_type: "item" })]);
  return w;
};

test("INV-021: planQuarantine is dry by default (no flag written); apply writes ONE checked deferral flag per candidate and a rerun plans nothing new", async () => {
  const w = quarantinedWorld(30);
  const dry = await planQuarantine({ sb: w.deps.sb, now: () => NOW }, {});
  assert.equal(dry.counts.deferral_candidates, 1);
  assert.equal(w.db.writes("integrity_flags").length, 0);
  const applied = await planQuarantine({ sb: w.deps.sb, now: () => NOW }, { apply: true });
  assert.equal(applied.counts.deferrals_written, 1);
  const written = w.db.rows("integrity_flags").filter((f) => f.created_by === "disposition_deferred");
  assert.equal(written.length, 1);
  assert.equal(isValidDeferral((written[0]?.recommended_actions as { deferral: unknown }[])[0]?.deferral, NOW).ok, true);
  const again = await planQuarantine({ sb: w.deps.sb, now: () => NOW }, { apply: true });
  assert.equal(again.counts.deferral_candidates, 0, "the item is already deferred");
  assert.equal(again.counts.already_deferred, 1);
  const f = quarantinedWorld(30);
  f.db.failWhen = (c) => (c.table === "integrity_flags" && c.op === "insert" ? "flags readonly" : null);
  const fr = await planQuarantine({ sb: f.deps.sb, now: () => NOW }, { apply: true });
  assert.equal(fr.outcome, "partial");
  assert.equal(fr.counts.deferrals_failed, 1);
  const r = quarantinedWorld(30);
  r.db.failWhen = (c) => (c.table === "intelligence_items" && c.op === "select" ? "timeout" : null);
  assert.equal((await planQuarantine({ sb: r.deps.sb, now: () => NOW }, {})).outcome, "failed");
});

test("resolver: held item types are not attempted; a verified_cheap item re-runs the validation rpc and the read-back decides 'verified'; the rpc error is reported", async () => {
  const w = makeWorld({ itemType: "regulation" });
  const cap = w.db.rows("agent_run_searches")[0];
  w.db.seed("section_claim_provenance", [{ intelligence_item_id: ITEM, claim_kind: "FACT", claim_text: "c", source_span: SPAN_REPORT, search_result_id: cap?.id }]);
  const dry = await resolveQuarantined(w.deps.sb, {});
  assert.equal(dry.decisions[0]?.outcome, "cheap-ok");
  assert.equal(w.db.rpcCalls.length, 0, "dry: no rpc");
  const applied = await resolveQuarantined(w.deps.sb, { apply: true });
  assert.equal(applied.decisions[0]?.outcome, "verified");
  assert.equal(applied.counts.flipped, 1);
  const held = makeWorld({ itemType: "technology" });
  const hr = await resolveQuarantined(held.deps.sb, { apply: true });
  assert.equal(hr.counts.held_types, 1);
  assert.equal(hr.decisions.length, 0);
  const forged = makeWorld({ itemType: "regulation" });
  forged.db.seed("section_claim_provenance", [{ intelligence_item_id: ITEM, claim_kind: "FACT", claim_text: "c", source_span: "a span that is in no capture at all", search_result_id: forged.db.rows("agent_run_searches")[0]?.id }]);
  assert.equal((await resolveQuarantined(forged.deps.sb, { apply: true })).decisions[0]?.outcome, "needs-acquire", "a forged FACT is never 'cheap verified'");
  const broken = makeWorld({ itemType: "regulation" });
  broken.db.seed("section_claim_provenance", [{ intelligence_item_id: ITEM, claim_kind: "FACT", claim_text: "c", source_span: SPAN_REPORT, search_result_id: broken.db.rows("agent_run_searches")[0]?.id }]);
  broken.db.rpcs.validate_item_provenance = () => ({ error: { message: "rpc down" } });
  const br = await resolveQuarantined(broken.deps.sb, { apply: true });
  assert.equal(br.outcome, "partial");
  assert.equal(br.decisions[0]?.outcome, "error");
});

const rehomeWorld = (factTier: number | null = 5) => {
  const w = makeWorld({ itemType: "regulation" });
  // the set_provenance_status trigger: any item update re-derives the cached status through the validation function
  w.db.afterWrite = (c, db) => void (c.table === "intelligence_items" && c.op === "update" && db.rpcs.validate_item_provenance?.({ p_item_id: ITEM }, db));
  const official = w.db.rows("agent_run_searches").find((r) => r.result_url === OFFICIAL_URL);
  w.db.seed("section_claim_provenance", [{ intelligence_item_id: ITEM, claim_kind: "FACT", claim_text: "[report] duty", source_span: SPAN_REPORT, source_id: CORROB, search_result_id: official?.id, source_tier_at_grounding: factTier }]);
  return w;
};

test("INV-056: $0 floor-first re-attribution: a below-floor FACT whose span is verbatim in a held floor-tier primary is re-homed, the item flips at read-back, and nothing is fetched", async () => {
  const w = rehomeWorld();
  const dry = await rehomeQuarantined({ sb: w.deps.sb, sources: w.deps.sources, now: () => NOW }, {});
  assert.equal(dry.decisions[0]?.outcome, "WOULD-FLIP");
  assert.equal(w.db.writes("section_claim_provenance").length, 0);
  const applied = await rehomeQuarantined({ sb: w.deps.sb, sources: w.deps.sources, now: () => NOW }, { apply: true });
  assert.equal(applied.decisions[0]?.outcome, "VERIFIED-FREE");
  const claim = w.db.rows("section_claim_provenance")[0];
  assert.equal(claim?.source_id, SOURCE);
  assert.equal(claim?.source_tier_at_grounding, 1);
  assert.equal(w.db.rows("intelligence_items")[0]?.provenance_status, "verified");
  assert.equal(w.deps.sources.fetchAllowed(OFFICIAL_URL, null), false, "build mode: no fetch is possible");
});

test("INV-056: a span in no floor source is RESIDUAL (acquire), never forced; an exempt type, no FACTs, and a met floor are named; an error body is never a re-home target", async () => {
  const absent = rehomeWorld();
  absent.db.rows("section_claim_provenance")[0]!.source_span = "A claim that no held primary contains in any form whatever.";
  assert.equal((await rehomeQuarantined({ sb: absent.deps.sb, sources: absent.deps.sources, now: () => NOW }, { apply: true })).decisions[0]?.outcome, "RESIDUAL-ACQUIRE");
  assert.equal(absent.db.rows("section_claim_provenance")[0]?.source_id, CORROB, "nothing was re-attributed");
  const exempt = makeWorld({ itemType: "market_signal" });
  assert.equal((await rehomeQuarantined({ sb: exempt.deps.sb, sources: exempt.deps.sources, now: () => NOW }, {})).decisions[0]?.outcome, "EXEMPT");
  const none = makeWorld({ itemType: "regulation" });
  assert.equal((await rehomeQuarantined({ sb: none.deps.sb, sources: none.deps.sources, now: () => NOW }, {})).decisions[0]?.outcome, "NO-FACTS");
  const met = rehomeWorld(1);
  assert.equal((await rehomeQuarantined({ sb: met.deps.sb, sources: met.deps.sources, now: () => NOW }, {})).decisions[0]?.outcome, "NON-TIER-FAILURE");
  const wall = rehomeWorld();
  wall.db.rows("agent_run_searches").find((r) => r.result_url === OFFICIAL_URL)!.result_content = `Access Denied ${SPAN_REPORT} ${"x".repeat(300)}`;
  assert.equal((await rehomeQuarantined({ sb: wall.deps.sb, sources: wall.deps.sources, now: () => NOW }, {})).decisions[0]?.outcome, "RESIDUAL-ACQUIRE");
  const furniture = rehomeWorld();
  furniture.deps.sources.officialness = () => ({ path: "b", cleanBody: null });
  assert.equal((await rehomeQuarantined({ sb: furniture.deps.sb, sources: furniture.deps.sources, now: () => NOW }, {})).decisions[0]?.outcome, "RESIDUAL-ACQUIRE", "portal or consultation furniture (path b) is never a re-home target");
  const fail = rehomeWorld();
  fail.db.failWhen = (c) => (c.table === "section_claim_provenance" && c.op === "update" ? "denied" : null);
  const fr = await rehomeQuarantined({ sb: fail.deps.sb, sources: fail.deps.sources, now: () => NOW }, { apply: true });
  assert.equal(fr.decisions[0]?.outcome, "ERROR");
  assert.equal(fr.outcome, "partial");
  assert.ok(OTHER_URL);
});

test("INV-101: id-stamp needs the item's lease (no lease, no touch), a keyed lookup, and an identifier that is verbatim in the stored capture; the stamp is read back", async () => {
  const w = makeWorld({ itemType: "regulation" });
  const run = (over: Record<string, unknown> = {}) => idStamp({ sb: w.deps.sb, sources: w.deps.sources }, { itemKey: "t-9999", proposedId: "Regulation (EU) 2023/9999", holder: "session-A", apply: true, ...over });
  const noLease = await run();
  assert.equal(noLease.status, "lease_not_held");
  assert.equal(w.db.writes("intelligence_items").length, 0, "nothing was touched without the lease");
  w.db.seed("mutation_leases", [{ intelligence_item_id: ITEM, holder: "session-A" }]);
  const other = await run({ holder: "session-B" });
  assert.equal(other.status, "lease_not_held", "a lease held by another session is not ours");
  const forged = await run({ proposedId: "Regulation (EU) 2099/0001" });
  assert.equal(forged.status, "refused_not_id_confirmed", "an identifier absent from the capture never promotes the item");
  const dry = await run({ apply: false });
  assert.equal(dry.status, "would_stamp");
  assert.notEqual(w.db.rows("intelligence_items")[0]?.instrument_identifier, "Regulation (EU) 2023/9999");
  const done = await run();
  assert.equal(done.status, "stamped");
  assert.equal(w.db.rows("intelligence_items")[0]?.instrument_identifier, "Regulation (EU) 2023/9999");
  assert.equal((await run({ itemKey: "nope" })).status, "not_found");
  assert.equal((await run({ itemKey: ITEM })).status, "stamped", "a full id is a keyed lookup too");
  const mismatch = makeWorld({ itemType: "regulation" });
  mismatch.deps.sources.matchTarget = () => ({ verdict: "mismatch" });
  mismatch.db.seed("mutation_leases", [{ intelligence_item_id: ITEM, holder: "session-A" }]);
  assert.equal((await idStamp({ sb: mismatch.deps.sb, sources: mismatch.deps.sources }, { itemKey: "t-9999", proposedId: "Regulation (EU) 2023/9999", holder: "session-A", apply: true })).status, "refused_not_id_confirmed");
  const revert = makeWorld({ itemType: "regulation" });
  revert.db.seed("mutation_leases", [{ intelligence_item_id: ITEM, holder: "session-A" }]);
  revert.db.afterWrite = (c, d) => void (c.table === "intelligence_items" && c.op === "update" && (d.rows("intelligence_items")[0]!.instrument_identifier = "2023/9999"));
  const reverted = await idStamp({ sb: revert.deps.sb, sources: revert.deps.sources }, { itemKey: "t-9999", proposedId: "Regulation (EU) 2023/9999", holder: "session-A", apply: true });
  assert.equal(reverted.status, "failed", "a stamp that does not read back is a failure, not a success");
  const readFail = makeWorld({ itemType: "regulation" });
  readFail.db.seed("mutation_leases", [{ intelligence_item_id: ITEM, holder: "session-A" }]);
  readFail.db.failWhen = (c) => (c.table === "intelligence_items" && c.op === "update" ? "denied" : null);
  assert.equal((await idStamp({ sb: readFail.deps.sb, sources: readFail.deps.sources }, { itemKey: "t-9999", proposedId: "Regulation (EU) 2023/9999", holder: "session-A", apply: true })).status, "failed");
});

const archived = (id: string, over: Record<string, unknown> = {}) => ({ id, legacy_id: `L-${id}`, title: `T ${id}`, canonical_instrument_key: null, source_url: "https://a.test/x", source_id: SOURCE, is_archived: true, archive_reason: "duplicate", full_brief: null, ...over });
const eraseWorld = () => {
  const db = new MemDb();
  installLedgerRpcs(db);
  db.seed("intelligence_items", [archived("a1"), archived("a2", { full_brief: "real content" }), archived("a3", { source_id: "dead-source" }), archived("a4", { archive_reason: "off_vertical" }), archived("a5")]);
  db.seed("corpus_census", [{ intelligence_item_id: "a1", haiku_verdict: "archive_correct" }, { intelligence_item_id: "a2", haiku_verdict: "archive_correct" }, { intelligence_item_id: "a3", haiku_verdict: "archive_correct" }, { intelligence_item_id: "a5", haiku_verdict: "review_valuable" }]);
  db.seed("sources", [{ id: SOURCE, status: "active" }, { id: "dead-source", status: "suspended" }]);
  db.seed("section_claim_provenance", [{ intelligence_item_id: "a2", claim_kind: "FACT" }]);
  db.rpcs.acquire_mutation_lease = () => ({ data: [{ acquired: true, cur_holder: "h" }] });
  db.rpcs.release_mutation_lease = () => ({ data: [{ released: true }] });
  return db;
};

test("proof 8 / INV-101: erase: the tombstone exists BEFORE the delete; a content-bearing row and a row without an ACTIVE source are refused; accurate-but-archived reasons are never bucket-deleted", async () => {
  const db = eraseWorld();
  assert.equal(Object.keys(DELETABLE_REASONS).includes("off_vertical"), false);
  const refusedBucket = await eraseQuarantined({ sb: db.client }, { bucket: "off_vertical", holder: "h", apply: true });
  assert.equal(refusedBucket.outcome, "failed");
  assert.match(refusedBucket.notes[0] ?? "", /not in the deletable-reason allowlist/);
  const dry = await eraseQuarantined({ sb: db.client }, { bucket: "duplicate", holder: "h", emptyOnly: true, requireActiveSource: true });
  assert.deepEqual(dry.outcomes.map((o) => [o.itemId, o.outcome]).sort(), [["a1", "would_delete"], ["a2", "skipped_content"], ["a3", "refused_no_active_source"]].sort());
  assert.equal(db.writes("intelligence_items", "delete").length, 0);
  const res = await eraseQuarantined({ sb: db.client }, { bucket: "duplicate", holder: "h", apply: true, emptyOnly: true, requireActiveSource: true });
  assert.equal(res.counts.deleted, 1);
  assert.deepEqual(db.rows("intelligence_items").map((r) => r.id).sort(), ["a2", "a3", "a4", "a5"]);
  const order = db.calls.filter((c) => c.op === "insert" || c.op === "delete").map((c) => `${c.table}:${c.op}`);
  assert.ok(order.indexOf("disposition_ledger:insert") < order.indexOf("intelligence_items:delete"), "tombstone first");
  assert.equal(db.rows("disposition_ledger")[0]?.intelligence_item_id, "a1");
  assert.equal(db.rows("disposition_ledger")[0]?.disposition, "tombstone_delete_duplicate");
});

test("proof 8: if the tombstone cannot be written the item is NOT deleted; a lease held elsewhere is skipped; the census gate keeps non-correct rows out", async () => {
  const db = eraseWorld();
  db.failWhen = (c) => (c.table === "disposition_ledger" && c.op === "insert" ? "ledger readonly" : null);
  const res = await eraseQuarantined({ sb: db.client }, { bucket: "duplicate", holder: "h", apply: true });
  assert.equal(res.outcome, "partial");
  assert.ok(res.outcomes.every((o) => o.outcome === "failed"));
  assert.equal(db.writes("intelligence_items", "delete").length, 0, "the delete never ran");
  const leased = eraseWorld();
  leased.rpcs.acquire_mutation_lease = () => ({ data: [{ acquired: false, cur_holder: "other" }] });
  const lr = await eraseQuarantined({ sb: leased.client }, { bucket: "duplicate", holder: "h", apply: true });
  assert.ok(lr.outcomes.every((o) => o.outcome === "skipped_leased"));
  const census = eraseWorld();
  const cr = await eraseQuarantined({ sb: census.client }, { bucket: "duplicate", holder: "h" });
  assert.ok(!cr.outcomes.some((o) => o.itemId === "a5"), "a review_valuable row is not eligible");
  const keyed = eraseWorld();
  const kr = await eraseQuarantined({ sb: keyed.client }, { keys: ["L-a1", "missing"], disposition: "tombstone_delete_duplicate", holder: "h" });
  assert.deepEqual(kr.outcomes.map((o) => o.outcome).sort(), ["failed", "would_delete"]);
});
