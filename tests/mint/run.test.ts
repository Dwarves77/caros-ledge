// The mint run end to end on a memory database: select, hold, screen, identity, capture, build, preflight, apply, and the flywheel hand-off in the same run.
// INV-003/008/025/028 at the run level, INV-294, INV-297, B-2186 (reconciled only for a verified mint), the P6 falsification attacks, and dry/apply agreement.
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyPayload, reopenHolds, runMint } from "@/features/mint";

import type { MemDb } from "../intake/memdb.ts";

import { OFFICIAL_TEXT, SOURCE, WorldDb, builtPayload, makeDeps, makeWorld } from "./world.ts";

const GOOD = "Regulation (EU) 2023/NNNN establishing greenhouse gas emissions reduction duties for freight operators";
const OFF = "Corrigendum to Regulation (EU) 2022/1 (language corrections)";
const AMBIGUOUS = "Zebra grazing programme";
const urlOf = (n: number) => `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R${String(n).padStart(4, "0")}`;
const textOf = (n: number) => OFFICIAL_TEXT.split("2023/9999").join(`2023/${n}`);

/** A would_mint census row for CELEX 32023R<n> with its stored capture; `over` adjusts the census row. */
function addRow(db: MemDb, n: number, over: Record<string, unknown> = {}, text: string | null = textOf(n)) {
  const id = `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  db.seed("census_worklist", [{ id, source_id: SOURCE, document_url: urlOf(n), title: GOOD.replace("NNNN", String(n)), surface_tags: [], instrument_identifier: `32023R${String(n).padStart(4, "0")}`, dryrun_disposition: "would_mint", hold_reason: null, notes: null, is_archived: false, enumeration_status: "discovered", ...over }]);
  if (text) db.seed("agent_run_searches", [{ intelligence_item_id: null, result_url: (over.document_url as string) ?? urlOf(n), result_content: text, result_index: 0, search_query: "stored" }]);
  return id;
}
const census = (db: MemDb, id: string) => db.rows("census_worklist").find((r) => r.id === id)!;
const emptyWorld = () => makeWorld({ census: [], storedText: null });
const rejectProvenance = (db: MemDb) => {
  db.rpcs.validate_item_provenance = (args, d) => {
    const item = d.rows("intelligence_items").find((r) => r.id === args.p_item_id);
    if (item) item.provenance_status = "quarantined";
    return { data: [{ valid: false, recommended_status: "quarantined", failures: [{ criterion: 3, reason: "fact_span_not_in_source" }] }] };
  };
};

test("apply: a verified mint inserts the item with its grounding rows, stamps the census row reconciled, connects ONCE in the same run, records one ledger row, and flushes the cache", async () => {
  const db = emptyWorld();
  const id = addRow(db, 1);
  const { deps, rec } = makeDeps(db);
  const r = await runMint(deps, { mode: "apply", limit: 10 });
  assert.equal(r.outcome, "ok", r.notes.join("; "));
  assert.deepEqual([r.counts.minted, r.counts.minted_verified, r.counts.minted_unverified], [1, 1, 0]);
  const item = db.rows("intelligence_items")[0]!;
  assert.deepEqual([item.item_type, item.item_grade, item.domain, item.source_id, item.provenance_status], ["regulation", "record", 1, SOURCE, "verified"]);
  assert.deepEqual(r.mintedIds, [item.id]);
  assert.ok(db.rows("section_claim_provenance").some((c) => c.claim_kind === "FACT" && c.intelligence_item_id === item.id && c.source_tier_at_grounding === 1), "the FACT carries the source's grounding tier (base_tier)");
  assert.equal(census(db, id).enumeration_status, "reconciled");
  const facts = db.rows("section_claim_provenance").filter((c) => c.intelligence_item_id === item.id && c.claim_kind === "FACT");
  assert.ok(facts.some((c) => !String(c.claim_text).startsWith("[title]")), "INV-025: a verified record carries more than its title as a FACT");
  assert.ok(facts.every((c) => c.search_result_id && db.rows("agent_run_searches").some((r) => r.id === c.search_result_id && String(r.result_content).toLowerCase().includes(String(c.source_span).toLowerCase()))), "INV-003/156: every FACT span is verbatim in the capture it is attributed to");
  assert.equal(rec.connects.filter((c) => c.startsWith("connect:")).length, 1, "rule 17: the flywheel ran in the same run");
  assert.equal(rec.runs.length, 1);
  assert.deepEqual([rec.runs[0]?.family, rec.runs[0]?.itemId, rec.runs[0]?.outcome], ["mint", item.id, "ok"]);
  assert.equal(rec.flushed.length, 1);
  assert.ok(rec.flushed[0]?.includes("regulations-detail"));
});

test("plan (dry) writes nothing and reports what apply would do; apply then does exactly that (dry and apply agree)", async () => {
  const mk = () => {
    const db = emptyWorld();
    const ids = [addRow(db, 1), addRow(db, 2, { title: OFF }), addRow(db, 3, { title: AMBIGUOUS })];
    return { db, ids };
  };
  const a = mk();
  const dry = await runMint(makeDeps(a.db).deps, { mode: "plan" });
  assert.equal(a.db.calls.filter((c) => c.op !== "select").length, 0, "a plan writes nothing at all");
  const b = mk();
  const { deps, rec } = makeDeps(b.db);
  const apply = await runMint(deps, { mode: "apply" });
  assert.deepEqual([dry.counts.would_mint, dry.counts.held, dry.counts.screened_out], [apply.counts.minted, apply.counts.held, apply.counts.screened_out]);
  assert.deepEqual(dry.rows.map((x) => [x.rowId, x.outcome === "would_mint" ? "mint" : x.outcome]), apply.rows.map((x) => [x.rowId, x.outcome.startsWith("minted") ? "mint" : x.outcome]));
  assert.equal(rec.flushed.length, 1);
  assert.equal(dry.outcome, "ok");
});

test("INV-297 and INV-294: every row ends with its disposition on census_worklist; off-vertical and AMBIGUOUS rows are held (never minted) with a stage-qualified reason, the ambiguous one with its 14-day maximum age", async () => {
  const db = emptyWorld();
  const good = addRow(db, 1);
  const off = addRow(db, 2, { title: OFF });
  const amb = addRow(db, 3, { title: AMBIGUOUS });
  const heldByUrl = addRow(db, 4);
  db.seed("intelligence_items", [{ id: "old1", source_url: urlOf(4), instrument_identifier: "32023R0004", canonical_instrument_key: null, is_archived: false }]);
  db.seed("sources", [{ id: "b0000000-0000-4000-8000-000000000009", name: "Trade press", url: "https://press.example/", base_tier: 5, tier_override: null, status: "active", institution_id: null, category: "market_news" }]);
  const noIdentity = addRow(db, 5, { document_url: "https://press.example/doc/5", source_id: "b0000000-0000-4000-8000-000000000009" }, textOf(5));
  const thin = addRow(db, 6, {}, "too short");
  const garbled = addRow(db, 7, {}, `${textOf(7)} cdm:CDM_2.1.7 tdm:1523 xslt:3945 saxon:9.0.0.1J JVM:1.6.0_29 metaconvJar:1.1.9 builddate:21/01/2014 17:28:36`);
  const repealed = addRow(db, 8, {}, `<p class="forceIndicator forceIndicatorRED"><span class="i"></span>No longer in force</p> ${textOf(8)}`);
  const { deps } = makeDeps(db);
  const r = await runMint(deps, { mode: "apply", limit: 50 });
  assert.equal(census(db, good).enumeration_status, "reconciled");
  const reason = (id: string) => [census(db, id).dryrun_disposition, census(db, id).hold_reason];
  assert.deepEqual(reason(off), ["hold", "screen:off_vertical:denylist_language_correction"]);
  assert.deepEqual(reason(amb), ["hold", "screen:ambiguous:no_signal_ambiguous"]);
  assert.deepEqual(reason(heldByUrl), ["hold", "held:already_held_by_url:old1"]);
  assert.deepEqual(reason(noIdentity), ["hold", "identity:institution_category_unmapped"]);
  assert.deepEqual(reason(thin), ["hold", "capture:capture_blocked"], "a stored capture under 200 characters is no capture: the free transports are tried, and a refusal holds the row");
  assert.deepEqual(reason(garbled), ["hold", "capture:capture_garbled_metadata"]);
  assert.deepEqual(reason(repealed), ["hold", "capture:not_in_force"]);
  const notes = JSON.parse(String(census(db, amb).notes)) as { held_by: string; max_age_days: number; expires_at: string; export_kind: string; held_at: string };
  assert.deepEqual([notes.held_by, notes.max_age_days, notes.export_kind], ["mint", 14, "screen-verdict"]);
  assert.equal(notes.expires_at, new Date(Date.parse(notes.held_at) + 14 * 86_400_000).toISOString());
  assert.equal(db.rows("intelligence_items").length, 2, "only the good row minted (plus the pre-existing holder)");
  for (const row of db.rows("census_worklist")) assert.ok(row.enumeration_status === "reconciled" || row.dryrun_disposition === "hold", `${String(row.id)} has no recorded disposition`);
  assert.equal(db.rows("census_worklist").filter((c) => c.dryrun_disposition === "would_mint" && c.enumeration_status !== "reconciled").length, 0, "INV-008: nothing off-vertical or ambiguous is left in the would_mint pool");
  assert.equal(r.counts.held, 7);
});

test("INV-294: a reviewed verdict (screen_verdicts) turns an ambiguous row into a mint; a reviewed off_vertical keeps it out", async () => {
  const db = emptyWorld();
  const a = addRow(db, 1, { title: AMBIGUOUS });
  const b = addRow(db, 2, { title: AMBIGUOUS });
  db.seed("screen_verdicts", [{ census_id: a, verdict: "on_vertical", basis: "operator ruling: freight emissions record", reviewer: "x" }, { census_id: b, verdict: "off_vertical", basis: "not freight", reviewer: "x" }]);
  const { deps } = makeDeps(db);
  const r = await runMint(deps, { mode: "apply" });
  assert.equal(census(db, a).enumeration_status, "reconciled");
  assert.equal(census(db, b).hold_reason, "screen:ambiguous:no_signal_ambiguous".replace("ambiguous:no_signal_ambiguous", "off_vertical:reviewed"));
  assert.equal(r.counts.minted, 1);
  assert.equal(db.rows("intelligence_items").length, 1);
});

test("B-2186: a mint the database does not verify is NOT stamped reconciled; the census row is held with the failed criterion, and the run is partial", async () => {
  const db = emptyWorld();
  const id = addRow(db, 1);
  rejectProvenance(db);
  const { deps } = makeDeps(db);
  const r = await runMint(deps, { mode: "apply" });
  assert.deepEqual([r.counts.minted_unverified, r.counts.minted_verified], [1, 0]);
  assert.notEqual(census(db, id).enumeration_status, "reconciled");
  assert.deepEqual([census(db, id).dryrun_disposition, census(db, id).hold_reason], ["hold", "validation_failed:3:fact_span_not_in_source"]);
  assert.equal(r.outcome, "partial");
  assert.equal(db.rows("intelligence_items").length, 1, "the item exists (quarantined) for the heal");
});

test("P6 falsification: a FACT whose span is not verbatim in its capture is quarantined by the database gate (not minted verified); a duplicate key is refused outright", async () => {
  const db = makeWorld({ census: [], storedText: null });
  const { deps } = makeDeps(db);
  const ctx = { sb: deps.sb, entities: deps.entities, connect: deps.connect, now: deps.now };
  const forged = builtPayload();
  const fact = forged.payload.claims.find((c) => c.claim_kind === "FACT")!;
  fact.source_span = "a sentence the source never contained";
  const src = { id: SOURCE, url: "https://eur-lex.europa.eu/", name: "EUR-Lex", base_tier: 1, tier_override: null, status: "active", institution_id: null, category: "regulatory" };
  const bad = await applyPayload(forged, src, ctx, { dry: false });
  assert.equal(bad.outcome, "minted_unverified");
  assert.equal(db.rows("intelligence_items")[0]?.provenance_status, "quarantined");
  assert.match(bad.hold?.reason ?? "", /^validation_failed:3:span_not_in_capture$/);
  const again = await applyPayload(builtPayload({ source_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R9999&from=EN" }), src, ctx, { dry: false });
  assert.equal(again.outcome, "refused", "the canonical key is already held, whatever the URL");
  assert.match(again.hold?.reason ?? "", /^held:duplicate:/);
  assert.equal(db.rows("intelligence_items").length, 1);
});

test("a source-less seed is refused by the batch path too: a host that is never registered (a hosting platform) is refused and nothing is inserted", async () => {
  const db = makeWorld({ census: [], storedText: null });
  const { deps } = makeDeps(db);
  const ctx = { sb: deps.sb, entities: deps.entities, connect: deps.connect, now: deps.now };
  const p = builtPayload({ source_url: "https://consult.citizenspace.com/doc/1", canonical_instrument_key: null, source: { id: "ghost", url: "https://consult.citizenspace.com/", name: "Consultation", base_tier: null, tier_override: null, status: "inactive", institution_id: null, category: "regulatory" } });
  const r = await applyPayload(p, p.payload.source as never, ctx, { dry: false });
  assert.equal(r.outcome, "refused");
  assert.match(r.hold?.reason ?? "", /^source:refused:/);
  assert.equal(db.rows("intelligence_items").length, 0);
});

test("the limit applies to the MINTABLE rows that remain after the held exclusion and the screen, never above the ceiling of 100", async () => {
  const db = emptyWorld();
  for (const n of [1, 2, 3]) addRow(db, n);
  addRow(db, 4, { title: OFF });
  const { deps } = makeDeps(db);
  const r = await runMint(deps, { mode: "apply", limit: 2 });
  assert.deepEqual([r.counts.minted, r.counts.selected, r.counts.screened_out], [2, 2, 1]);
  assert.equal(db.rows("census_worklist").filter((c) => c.dryrun_disposition === "would_mint" && c.enumeration_status !== "reconciled").length, 1, "the third mintable row waits for the next run; a reconciled row is never selected again");
  const over = await runMint(makeDeps(db).deps, { mode: "plan", limit: 101 });
  assert.equal(over.outcome, "failed");
  assert.match(over.notes[0] ?? "", /ceiling of 100/);
});

test("a fetch hold DEFERS the row (it stays would_mint, no hold is written, nothing is fetched); a usable capture mints through the free transport", async () => {
  const db = emptyWorld();
  const id = addRow(db, 1, {}, null);
  const held = makeDeps(db, { fetch: { db: db.client, env: { SCRAPE_HOLD: "engaged" }, caller: null, fetchImpl: (async () => { throw new Error("must not fetch"); }) as typeof fetch } });
  const r1 = await runMint(held.deps, { mode: "apply" });
  assert.deepEqual([r1.counts.deferred, r1.counts.held ?? 0], [1, 0]);
  assert.equal(census(db, id).dryrun_disposition, "would_mint");
  const html = `<html><head><title>x</title></head><body>${textOf(1).split("\n").map((l) => `<p>${l}</p>`).join("")}</body></html>`;
  const calls: string[] = [];
  const open = makeDeps(db, { fetch: { db: db.client, env: {}, caller: "manual-intake-run", sleep: async () => undefined, fetchImpl: (async (u: string) => (calls.push(String(u)), new Response(html, { headers: { "content-type": "text/html" } }))) as typeof fetch } });
  const r2 = await runMint(open.deps, { mode: "apply" });
  assert.equal(r2.counts.minted, 1, r2.notes.join("; "));
  assert.ok(calls.filter((u) => !u.endsWith("/robots.txt"))[0]?.startsWith("https://publications.europa.eu/resource/celex/"), "Cellar first (robots.txt is asked before it)");
  assert.equal(census(db, id).enumeration_status, "reconciled");
});

test("a failed census write is counted and reported (the row would otherwise be re-selected silently); a failed ledger row makes the run partial", async () => {
  const db = emptyWorld();
  addRow(db, 1);
  addRow(db, 2, { title: OFF });
  db.failWhen = (c) => (c.table === "census_worklist" && c.op === "update" ? "row is locked" : null);
  const { deps } = makeDeps(db);
  const r = await runMint(deps, { mode: "apply" });
  assert.equal(r.counts.census_write_failed, 2);
  assert.equal(r.outcome, "partial");
  assert.ok(r.notes.some((n) => /not written: row is locked/.test(n)));
  const db2 = emptyWorld();
  addRow(db2, 1);
  const d2 = makeDeps(db2, { recorder: { recordRun: async () => ({ error: "ledger unavailable" }), now: () => new Date("2026-10-15T12:00:00.000Z") } });
  const r2 = await runMint(d2.deps, { mode: "apply" });
  assert.equal(r2.outcome, "partial");
  assert.ok(r2.notes.some((n) => n.startsWith("ledger row")));
});

test("an unreadable census, holder table or screen table FAILS the run before anything is held or minted", async () => {
  for (const table of ["census_worklist", "intelligence_items", "screen_verdicts"]) {
    const db = emptyWorld();
    addRow(db, 1);
    db.failWhen = (c) => (c.table === table ? "relation does not exist" : null);
    const r = await runMint(makeDeps(db).deps, { mode: "apply" });
    assert.equal(r.outcome, "failed", table);
    assert.equal(db.writes("intelligence_items").length + db.writes("census_worklist").length, 0, table);
  }
});

test("INV-028: a reopen needs a stated reason, matches only mint-written holds containing it, keeps the held evidence, and a dry reopen writes nothing", async () => {
  const db = emptyWorld();
  const hollow = addRow(db, 1, { dryrun_disposition: "hold", hold_reason: "validation_failed:5:record_hollow", notes: JSON.stringify({ held_by: "mint" }) });
  const other = addRow(db, 2, { dryrun_disposition: "hold", hold_reason: "validation_failed:3:fact_span_not_in_source", notes: null });
  const foreign = addRow(db, 3, { dryrun_disposition: "hold", hold_reason: "manual:record_hollow", notes: null });
  const deps = makeDeps(db).deps;
  assert.equal((await reopenHolds(deps, { reasonContains: "  " })).outcome, "failed", "never a blanket reopen");
  const dry = await reopenHolds(deps, { reasonContains: "record_hollow" });
  assert.deepEqual([dry.counts.matched, dry.counts.written], [1, 0]);
  assert.equal(census(db, hollow).dryrun_disposition, "hold");
  const done = await reopenHolds(deps, { reasonContains: "record_hollow", dry: false });
  assert.deepEqual([done.counts.matched, done.counts.written, done.outcome], [1, 1, "ok"]);
  assert.deepEqual([census(db, hollow).dryrun_disposition, census(db, hollow).hold_reason], ["would_mint", null]);
  assert.match(String(census(db, hollow).notes), /held_by[\s\S]*\[reopened 2026-10-15/);
  assert.equal(census(db, other).dryrun_disposition, "hold", "a different reason stays held");
  assert.equal(census(db, foreign).dryrun_disposition, "hold", "a hold the mint did not write is never reopened by it");
  db.failWhen = (c) => (c.table === "census_worklist" && c.op === "update" ? "row is locked" : null);
  assert.equal((await reopenHolds(deps, { reasonContains: "fact_span", dry: false })).outcome, "partial");
});

test("the ledger and the held index agree with a re-run: a row held or minted in one run is not selected, held or minted again in the next", async () => {
  const db = emptyWorld();
  addRow(db, 1);
  addRow(db, 2, { title: OFF });
  addRow(db, 3, { title: AMBIGUOUS });
  const first = await runMint(makeDeps(db).deps, { mode: "apply" });
  assert.equal(first.counts.candidates, 3);
  const second = await runMint(makeDeps(db).deps, { mode: "apply" });
  assert.equal(second.counts.candidates, 0, "B-2187: held rows are not re-fetched every run");
  assert.equal(db.rows("intelligence_items").length, 1);
  assert.ok(db instanceof WorldDb);
});

test("migration 302: the authority floor RATES and never refuses: a regulation from a tier-5 source mints, its FACTs carry the source's tier as the rating, and nothing is held for it", async () => {
  const db = emptyWorld();
  const low = "b0000000-0000-4000-8000-000000000005";
  db.seed("sources", [{ id: low, name: "Regulatory portal", url: "https://eur-lex.europa.eu/", base_tier: 5, tier_override: null, status: "active", institution_id: null, category: "regulatory" }]);
  const id = addRow(db, 1, { source_id: low });
  const { deps } = makeDeps(db);
  const r = await runMint(deps, { mode: "apply" });
  assert.equal(r.counts.minted_verified, 1, r.notes.join("; "));
  assert.equal(census(db, id).enumeration_status, "reconciled");
  const tiers = db.rows("section_claim_provenance").filter((c) => c.claim_kind === "FACT").map((c) => c.source_tier_at_grounding);
  assert.ok(tiers.length > 0 && tiers.every((t) => t === 5), "the rating is recorded, the item is published");
});
