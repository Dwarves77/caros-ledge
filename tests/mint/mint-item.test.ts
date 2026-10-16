// The one mint function: INV-169 (every probe fail-closed, dedup over the full corpus), INV-293, INV-295 (a failing write at each step leaves no item row), the dry/apply
// agreement, the source-link invariant, markers never persist, and exactly one flywheel connect per mint.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { MintDeps } from "@/features/intake";
import { bindMint, canonicalDomainOverride, mintItem, sourceLinkDecision, unconditionalDomain, type MintCtx, type MintRequest } from "@/features/mint";

import type { MemCall } from "../intake/memdb.ts";

import { CELEX_URL, SOURCE, WorldDb, builtPayload, makeDeps, makeWorld } from "./world.ts";

const seed = (over: Record<string, unknown> = {}) => ({ title: "Regulation (EU) 2023/9999 on sustainable freight operations", item_type: "regulation", domain: 1, source_url: CELEX_URL, source_id: SOURCE, instrument_identifier: "32023R9999", canonical_instrument_key: "32023R9999", jurisdiction_iso: ["EU"], ...over });
const req = (over: Partial<MintRequest> & { seed?: Record<string, unknown> } = {}): MintRequest => ({ seed: seed(), origin: "test", grade: "record", ...over }) as MintRequest;
const ctxOf = (db: WorldDb, over: Partial<ReturnType<typeof makeDeps>["deps"]> = {}) => {
  const { deps, rec } = makeDeps(db, over);
  const ctx: MintCtx = { sb: deps.sb, entities: deps.entities, connect: deps.connect, now: deps.now };
  return { ctx, rec, deps };
};
const inserts = (db: WorldDb) => db.writes("intelligence_items", "insert");
const readsOf = (c: MemCall, table: string, col: string) => c.table === table && c.op === "select" && c.filters.some(([, f]) => f === col);

test("INV-169: a read error on each idempotency probe, the dedup corpus and the source registry REFUSES the mint: no insert, no flywheel call", async () => {
  const cases: [string, (c: MemCall) => boolean, string, RegExp][] = [
    ["source_url probe", (c) => readsOf(c, "intelligence_items", "source_url"), "duplicate", /source_url probe read failed/],
    ["legacy_id probe", (c) => readsOf(c, "intelligence_items", "legacy_id"), "duplicate", /legacy_id probe read failed/],
    ["canonical key probe", (c) => readsOf(c, "intelligence_items", "canonical_instrument_key"), "duplicate", /canonical key probe read failed/],
    ["dedup corpus", (c) => c.table === "intelligence_items" && c.op === "select" && c.filters.some(([, f, v]) => f === "is_archived" && v === false), "duplicate", /dedup corpus read failed/],
    ["source registry", (c) => c.table === "sources", "unsourced", /source registry probe read failed/],
  ];
  for (const [name, hit, outcome, why] of cases) {
    const db = makeWorld();
    const { ctx, rec } = ctxOf(db);
    db.failWhen = (c) => (hit(c) ? "canceling statement due to statement timeout" : null);
    const r = await mintItem(req({ legacyId: "L-1", seed: seed({ source_id: undefined }) } as never), ctx, { dry: false });
    assert.equal(r.outcome, outcome, name);
    assert.match(r.reasons.join(" | "), why, name);
    assert.equal(inserts(db).length, 0, `${name}: nothing inserted`);
    assert.equal(rec.connects.length, 0, `${name}: the flywheel was not called`);
  }
});

test("INV-169 / B-0267 / B-1988: a 1,500-row corpus under a 1,000-row server cap finds the duplicate in row 1,400", async () => {
  const items = Array.from({ length: 1500 }, (_, i) => ({ id: `i-${String(i).padStart(5, "0")}`, title: `Other instrument ${i}`, instrument_identifier: i === 1400 ? "32023R9999" : `X-${i}`, source_url: `https://elsewhere.example/${i}`, canonical_instrument_key: null, is_archived: false }));
  const db = makeWorld({ capped: true, items });
  const { ctx } = ctxOf(db);
  const r = await mintItem(req({ seed: seed({ canonical_instrument_key: null, source_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R9999&x=1" }) }), ctx, { dry: false });
  assert.equal(r.outcome, "duplicate");
  assert.match(r.reasons.join(" "), /i-01400\(instrument\)/);
  assert.equal(inserts(db).length, 0);
});

test("INV-293: a key held by any row (archived included) is a duplicate; the same URL with the same identity is `exists`; a sibling identifier at one URL mints", async () => {
  const items = [{ id: "k1", source_url: "https://old.example/k", canonical_instrument_key: "32023R9999", instrument_identifier: "A", archive_reason: "off_vertical", is_archived: true }, { id: "u1", source_url: "https://bulletin.example/oil", instrument_identifier: "diesel", canonical_instrument_key: null, is_archived: false, title: "Diesel" }];
  const db = makeWorld({ items });
  const { ctx } = ctxOf(db);
  const byKey = await mintItem(req(), ctx, { dry: false });
  assert.deepEqual([byKey.outcome, byKey.itemId], ["duplicate", null]);
  assert.match(byKey.reasons.join(" "), /k1 \(archived\)/);
  const same = await mintItem(req({ seed: seed({ canonical_instrument_key: null, source_url: "https://bulletin.example/oil", instrument_identifier: "Diesel" }) }), ctx, { dry: false });
  assert.deepEqual([same.outcome, same.itemId], ["exists", "u1"]);
  const sibling = await mintItem(req({ seed: seed({ canonical_instrument_key: null, source_url: "https://bulletin.example/oil", instrument_identifier: "petrol", title: "Petrol", item_type: "market_signal", domain: 4, source_id: SOURCE }) }), ctx, { dry: false });
  assert.equal(sibling.outcome, "minted", "a labelled, different identifier at the same URL is a sibling series");
  assert.equal(inserts(db).length, 1);
  const legacy = await mintItem(req({ legacyId: "L-7", seed: seed({ legacy_id: "L-7", canonical_instrument_key: null, source_url: "https://fresh.example/a" }) }), ctx, { dry: false });
  const again = await mintItem(req({ legacyId: "L-7", seed: seed({ canonical_instrument_key: null, source_url: "https://fresh.example/b" }) }), ctx, { dry: false });
  assert.equal(legacy.outcome, "minted");
  assert.deepEqual([again.outcome, again.itemId], ["exists", legacy.itemId]);
});

test("congruence 1a retypes a primary-artifact type on a news source to market_signal (domain 1 follows to 4); 1b keeps research_finding and opens the seek-study flag", async () => {
  const db = makeWorld();
  const { ctx } = ctxOf(db);
  const a = await mintItem(req({ seed: seed({ canonical_instrument_key: null, source_url: "https://wire.example/news/cbam-update", instrument_identifier: "N-1", title: "News about CBAM" }) }), ctx, { dry: false });
  assert.equal(a.outcome, "retyped");
  assert.ok(a.reasons.includes("congruence:1a"));
  const row = db.rows("intelligence_items").find((r) => r.id === a.itemId);
  assert.deepEqual([row?.item_type, row?.domain], ["market_signal", 4]);
  const b = await mintItem(req({ seed: seed({ item_type: "research_finding", domain: 7, canonical_instrument_key: null, source_url: "https://wire.example/news/study", instrument_identifier: "N-2", title: "Press release about a study" }) }), ctx, { dry: false });
  assert.equal(b.outcome, "minted");
  assert.ok(b.reasons.includes("seek-study:1b"));
  assert.equal(db.rows("integrity_flags").filter((f) => f.created_by === "intake-seek-study" && f.subject_ref === b.itemId).length, 1);
});

test("a news item duplicating an existing subject is minted as a market_signal linked to the primary (related edge); a primary duplicate is refused", async () => {
  const items = [{ id: "p1", title: "Regulation (EU) 2023/9999 on sustainable freight operations", instrument_identifier: "32023R9999", source_url: "https://eur-lex.europa.eu/x", canonical_instrument_key: null, is_archived: false }];
  const db = makeWorld({ items });
  const { ctx } = ctxOf(db);
  const linked = await mintItem(req({ seed: seed({ canonical_instrument_key: null, source_url: "https://wire.example/news/a", title: "Wire story" }) }), ctx, { dry: false });
  assert.equal(linked.outcome, "linked");
  assert.ok(linked.reasons.includes("dedup:linked"));
  const edge = db.rows("item_cross_references")[0];
  assert.deepEqual([edge?.source_item_id, edge?.target_item_id, edge?.relationship], [linked.itemId, "p1", "related"]);
  const dup = await mintItem(req({ seed: seed({ canonical_instrument_key: null, source_url: "https://elsewhere.example/primary" }) }), ctx, { dry: false });
  assert.equal(dup.outcome, "duplicate");
});

test("domain and format_type: an unconditional type is re-domained and stamped; a conditional type keeps its domain; a preset format_type stands", async () => {
  assert.equal(unconditionalDomain("regulation"), 1);
  assert.equal(unconditionalDomain("market_signal"), 4);
  for (const conditional of ["framework", "tool", "initiative"]) assert.equal(unconditionalDomain(conditional), null, conditional);
  assert.equal(canonicalDomainOverride("regulation", 4), 1);
  assert.equal(canonicalDomainOverride("regulation", 1), null);
  assert.equal(canonicalDomainOverride("framework", 4), null);
  const db = makeWorld();
  const { ctx } = ctxOf(db);
  const r = await mintItem(req({ seed: seed({ domain: 4 }) }), ctx, { dry: false });
  assert.ok(r.reasons.includes("domain-canonicalized:4->1"));
  const row = db.rows("intelligence_items").find((x) => x.id === r.itemId);
  assert.equal(row?.domain, 1);
  assert.ok(typeof row?.format_type === "string" && row.format_type.length > 0, "format_type stamped from the same registry generation forces");
  const preset = await mintItem(req({ seed: seed({ format_type: "custom_format", canonical_instrument_key: null, source_url: "https://eur-lex.europa.eu/other", instrument_identifier: "Z" }) }), ctx, { dry: false });
  assert.equal(db.rows("intelligence_items").find((x) => x.id === preset.itemId)?.format_type, "custom_format");
});

test("source-link invariant: a source-less seed is refused, a registered URL links, a preset source_id is trusted; no auto-registration", async () => {
  assert.deepEqual(sourceLinkDecision({ source_id: "s" }, null), { kind: "preset" });
  assert.deepEqual(sourceLinkDecision({ source_url: "https://a.example" }, "s9"), { kind: "link", sourceId: "s9" });
  assert.equal(sourceLinkDecision({ source_url: "https://a.example" }, null).kind, "reject");
  assert.equal(sourceLinkDecision({}, null).kind, "reject");
  const db = makeWorld();
  const { ctx } = ctxOf(db);
  const unsourced = await mintItem(req({ seed: seed({ source_id: undefined, source_url: "https://unregistered.example/doc", canonical_instrument_key: null, instrument_identifier: "U" }) }), ctx, { dry: false });
  assert.equal(unsourced.outcome, "unsourced");
  assert.equal(db.writes("sources").length, 0, "the chokepoint never registers a source");
  const linked = await mintItem(req({ seed: seed({ source_id: undefined, canonical_instrument_key: null, source_url: "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R0001", instrument_identifier: "L" }) }), ctx, { dry: false });
  assert.ok(linked.reasons.includes("source-linked"));
  assert.equal(db.rows("intelligence_items").find((r) => r.id === linked.itemId)?.source_id, SOURCE);
  const nothing = await mintItem(req({ seed: seed({ source_id: undefined, source_url: undefined }) }), ctx, { dry: false });
  assert.equal(nothing.outcome, "unsourced");
});

test("dry and apply agree on every fixture: the same outcome and the same gate decisions, and a dry run writes nothing and calls nothing", async () => {
  const fixtures: [string, Record<string, unknown>[], Partial<MintRequest> & { seed?: Record<string, unknown> }][] = [
    ["fresh", [], {}],
    ["exists by url", [{ id: "u", source_url: CELEX_URL, instrument_identifier: "32023R9999" }], { seed: seed({ canonical_instrument_key: null }) }],
    ["key held", [{ id: "k", canonical_instrument_key: "32023R9999", source_url: "https://o.example" }], {}],
    ["subject duplicate", [{ id: "d", title: "Regulation (EU) 2023/9999 on sustainable freight operations", instrument_identifier: "OTHER", source_url: "https://o.example", is_archived: false }], { seed: seed({ canonical_instrument_key: null, source_url: "https://p.example/a" }) }],
    ["news linked", [{ id: "d2", title: "Same", instrument_identifier: "ID-5", source_url: "https://o.example", is_archived: false }], { seed: seed({ title: "Same", canonical_instrument_key: null, source_url: "https://wire.example/news/x", instrument_identifier: "ID-5" }) }],
    ["retyped", [], { seed: seed({ canonical_instrument_key: null, source_url: "https://wire.example/news/y", instrument_identifier: "ID-6" }) }],
    ["unsourced", [], { seed: seed({ source_id: undefined, canonical_instrument_key: null, source_url: "https://nowhere.example/z", instrument_identifier: "ID-7" }) }],
    ["low relevance", [], { relevance: 12 }],
  ];
  const gateFlags = (reasons: string[]) => reasons.filter((r) => r !== "dry" && !/^(discovery|forward-events|obligations|entities|timeline|lineage|compliance-deadline|stale-events|steps)/.test(r) && !/-failed$/.test(r));
  for (const [name, items, extra] of fixtures) {
    const dryDb = makeWorld({ items });
    const dry = ctxOf(dryDb);
    const d = await mintItem(req(extra), dry.ctx, { dry: true });
    assert.equal(dryDb.calls.filter((c) => c.op !== "select").length, 0, `${name}: dry writes nothing`);
    assert.equal(dry.rec.connects.length, 0, `${name}: dry calls nothing`);
    const applyDb = makeWorld({ items });
    const apply = ctxOf(applyDb);
    const a = await mintItem(req(extra), apply.ctx, { dry: false });
    assert.equal(d.outcome, a.outcome, `${name}: outcome`);
    assert.deepEqual(gateFlags(d.reasons), gateFlags(a.reasons), `${name}: gate decisions`);
    assert.equal(d.itemId, ["minted", "retyped", "linked"].includes(a.outcome) ? null : a.itemId, `${name}: item id`);
  }
});

test("INV-295: a failing write at each step of the grounding sequence leaves NO item row, no flywheel call, and names the step", async () => {
  const steps: [string, string, "insert" | "upsert"][] = [["agent_run_searches", "agent_run_searches", "insert"], ["intelligence_item_sections", "intelligence_item_sections", "insert"], ["item_gate_a_state", "item_gate_a_state", "upsert"], ["section_claim_provenance", "section_claim_provenance", "insert"], ["intelligence_item_citations", "intelligence_item_citations", "insert"]];
  for (const [name, table, op] of steps) {
    const db = makeWorld();
    const { ctx, rec } = ctxOf(db);
    db.failWhen = (c) => (c.table === table && c.op === op ? "disk full" : null);
    const built = builtPayload();
    const r = await mintItem(req({ seed: seed(), payload: built.payload, sourceTier: 1 }), ctx, { dry: false });
    assert.equal(r.outcome, "rejected", name);
    assert.match(r.reasons.join(" | "), new RegExp(`write sequence failed at ${name}`), name);
    assert.ok(r.reasons.includes("partial_item_deleted"), `${name}: compensated`);
    assert.equal(db.rows("intelligence_items").length, 0, `${name}: no item row`);
    assert.equal(r.itemId, null);
    assert.equal(rec.connects.length, 0, `${name}: no flywheel call on a failed write`);
  }
});

test("INV-295: when the compensating delete itself fails, the item row is REPORTED (cleanup_failed with its id), never claimed gone", async () => {
  const db = makeWorld();
  const { ctx } = ctxOf(db);
  db.failWhen = (c) => (c.table === "section_claim_provenance" && c.op === "insert" ? "disk full" : c.table === "intelligence_items" && c.op === "delete" ? "permission denied" : null);
  const r = await mintItem(req({ payload: builtPayload().payload, sourceTier: 1 }), ctx, { dry: false });
  assert.equal(r.outcome, "rejected");
  assert.match(r.reasons.join(" | "), /cleanup_failed: permission denied/);
  assert.equal(db.rows("intelligence_items").length, 1);
  assert.equal(r.itemId, db.rows("intelligence_items")[0]?.id);
});

test("GATES-2: a full_brief carrying an internal marker never persists", async () => {
  for (const marker of ["text <<< open", "x _PROVENANCE y"]) {
    const db = makeWorld();
    const { ctx } = ctxOf(db);
    const r = await mintItem(req({ seed: seed({ full_brief: marker }) }), ctx, { dry: false });
    assert.equal(r.outcome, "rejected", marker);
    assert.match(r.reasons.join(" "), /internal_marker_in_body/);
    assert.equal(inserts(db).length, 0);
  }
});

test("rule 17: connect.connect runs exactly once per mint, through the one participation list, and never in a dry run or for an `exists`", async () => {
  const db = makeWorld();
  const { ctx, rec } = ctxOf(db);
  const first = await mintItem(req({ payload: builtPayload().payload, sourceTier: 1 }), ctx, { dry: false });
  assert.equal(first.outcome, "minted");
  assert.equal(rec.connects.filter((c) => c.startsWith("connect:")).length, 1);
  assert.deepEqual(rec.connects.map((c) => c.split(":")[0]).sort(), ["connect", "entities", "events", "obligations"]);
  assert.equal(first.participation?.outcome, "ok");
  const again = await mintItem(req({ payload: builtPayload().payload, sourceTier: 1 }), ctx, { dry: false });
  assert.equal(again.outcome, "exists");
  assert.equal(rec.connects.filter((c) => c.startsWith("connect:")).length, 1, "a re-mint does not connect twice");
  assert.equal(db.rows("agent_run_searches").length > 0 && db.rows("section_claim_provenance").length > 0, true, "the grounding rows were written with the item");
});

test("a flywheel step failure is a recorded defect flag, never a failed mint", async () => {
  const db = makeWorld();
  const { deps } = makeDeps(db, {});
  const failing = { ...deps.connect, deriveObligations: async () => { throw new Error("obligations store down"); } };
  const r = await mintItem(req(), { sb: deps.sb, entities: deps.entities, connect: failing, now: deps.now }, { dry: false });
  assert.equal(r.outcome, "minted");
  assert.ok(r.reasons.includes("obligations-failed"));
  assert.equal(r.participation?.outcome, "partial");
  assert.equal(db.rows("integrity_flags").filter((f) => f.created_by === "flywheel-defect:obligations").length, 1);
});

test("bindMint gives intake the exact MintDeps shape", async () => {
  const db = makeWorld();
  const { ctx } = ctxOf(db);
  const bound: MintDeps = bindMint(ctx);
  const r = await bound.mintItem({ seed: seed(), origin: "test" }, { dry: true });
  assert.equal(r.outcome, "minted");
  assert.equal(r.itemId, null);
});

test("INV-295: a delete that reports success but removes nothing (a policy filtering the row out) is still a cleanup failure: the row is re-read, never assumed gone", async () => {
  const db = makeWorld();
  const { ctx } = ctxOf(db);
  let kept: Record<string, unknown> | null = null;
  db.afterWrite = (c, d) => {
    if (c.table === "intelligence_items" && c.op === "insert") kept = { ...(d.rows("intelligence_items")[0] as Record<string, unknown>) };
    if (c.table === "intelligence_items" && c.op === "delete" && kept) d.rows("intelligence_items").push(kept);
  };
  db.failWhen = (c) => (c.table === "section_claim_provenance" && c.op === "insert" ? "disk full" : null);
  const r = await mintItem(req({ payload: builtPayload().payload, sourceTier: 1 }), ctx, { dry: false });
  assert.equal(r.outcome, "rejected");
  assert.match(r.reasons.join(" | "), /cleanup_failed: item row still present after delete/);
  assert.equal(r.itemId, db.rows("intelligence_items")[0]?.id);
});
