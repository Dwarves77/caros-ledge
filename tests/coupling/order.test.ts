// ENGINE-ORDER-1: what a connect step reads is written by a step before it, in the SAME turn. The reading of the backlog (forward events, obligation objects) and the ref mining run first; discovery, the corpus pass and the patterns run over what they wrote.
// The fixture plants no obligation, no forward event and no ref for the instrument item: a verified item with a capture that states a duty, and a claim that states a formal code. One connect stage must leave all three and a pattern whose evidence is the new event.
import assert from "node:assert/strict";
import { test } from "node:test";

import { runTurn } from "@/core/turn";

import { DUTY_TEXT } from "../impact/_world.ts";

import { claim, connect, countsOf, E, NOW, patternFixture, patterns } from "./_world.ts";

const X = "11111111-0000-4000-8000-0000000000aa";
const CAP = "22222222-0000-4000-8000-0000000000aa";
const CLAIM = "33333333-0000-4000-8000-0000000000aa";
const SRC = "b1000000-0000-4000-8000-0000000000aa";

/** The pattern world with its seeded obligations and forward events removed, plus one verified instrument item whose capture states a duty and whose claim states the CELEX number of ReFuelEU Aviation. */
function orderFixture() {
  const f = patternFixture();
  for (const t of ["obligation_objects", "item_forward_events"]) f.db.rows(t).length = 0;
  f.db.seed("sources", [{ id: SRC, name: "EUR-Lex", url: "https://eur-lex.example.test/", base_tier: 1, tier_override: null, status: "active" }]);
  f.db.seed("intelligence_items", [{ id: X, title: "Instrument X", is_archived: false, provenance_status: "verified", item_type: "regulation", domain: 1, source_id: SRC, jurisdiction_iso: ["EU"], instrument_identifier: "Regulation (EU) 2026/77", canonical_instrument_key: null, last_regenerated_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", added_date: "2026-01-01", transport_modes: [], operational_scenario_tags: [], compliance_object_tags: [], topic_tags: [], cost_mechanism: null, penalty_range: null, compliance_deadline: null }]);
  f.db.seed("agent_run_searches", [{ id: CAP, intelligence_item_id: X, result_url: "https://eur-lex.example.test/x", result_content: DUTY_TEXT, result_index: 0, search_query: "capture", searched_at: "2026-10-15T09:00:00Z" }]);
  f.db.seed("section_claim_provenance", [claim(X, "Regulation (EU) 2023/2405 sets the blending obligation.", "2026-10-01", SRC, 1, "FACT", CLAIM)]);
  return f;
}
const ofItem = (f: ReturnType<typeof orderFixture>, table: string, col: string) => f.db.rows(table).filter((r) => r[col] === X);

test("INV-2: one connect leaves the item's forward event, its obligation object and its entity refs, and a pattern whose evidence is that forward event (before the change this took two turns)", async () => {
  const f = orderFixture();
  assert.equal((await connect(f)).exit, 0);
  const events = ofItem(f, "item_forward_events", "intelligence_item_id");
  const objects = ofItem(f, "obligation_objects", "instrument_item_id");
  assert.ok(events.length >= 1, "the reading wrote the forward events");
  assert.ok(objects.length >= 1, "the reading wrote the obligation objects");
  const filed = (table: string, id: string) => f.db.rows("entity_refs").filter((r) => r.ref_table === table && r.ref_id === id && r.entity_id === E("instrument:32023R2405"));
  assert.ok(filed("intelligence_items", X).length >= 1, "the item is filed under the instrument its claim states");
  const eventIds = new Set(events.map((e) => String(e.id)));
  const cited = patterns(f).filter((p) => f.db.rows("derivation_edges").some((e) => e.to_value_id === p.value_id && e.from_table === "item_forward_events" && eventIds.has(String(e.from_pk))));
  assert.deepEqual(cited.map((p) => p.method_id), ["pattern_lead_lag"], "a pattern in the same turn cites the forward event the reading just wrote, joined by the item's mined ref");
});

test("INV-4: connecting the same fixture again changes no row count", async () => {
  const f = orderFixture();
  await connect(f);
  const tables = ["item_forward_events", "obligation_objects", "obligations", "entity_refs", "item_obligation_scan", "derived_values", "derivation_edges"];
  const before = tables.map((t) => f.db.rows(t).length);
  await connect(f);
  assert.deepEqual(tables.map((t) => f.db.rows(t).length), before);
  assert.equal(countsOf(f, "corpus-turn").refs_written, 0);
});
/** The fixture's database handle recording every table the stage opens, in call order. */
function recorded(f: ReturnType<typeof orderFixture>): { d: typeof f.d; log: string[] } {
  const log: string[] = [];
  const sb = new Proxy(f.d.sb as object, { get: (t, k) => (k === "from" ? (table: string) => (log.push(table), (t as { from: (n: string) => unknown }).from(table)) : Reflect.get(t, k)) }) as typeof f.d.sb;
  return { d: { ...f.d, sb }, log };
}
const stage = (f: ReturnType<typeof orderFixture>, name: "connect" | "propagate", d: ReturnType<typeof recorded>["d"]) => runTurn({ stage: name, mode: "apply", chain: false, input: { ids: [X] } } as never, { d, env: {}, now: () => NOW });

test("INV-1: the connect stage reads the backlog (forward events, obligations) first, mines the refs second, and only then reads the spine the corpus pass and the patterns read", async () => {
  const f = orderFixture();
  const { d, log } = recorded(f);
  assert.equal((await stage(f, "connect", d)).exit, 0);
  const [lastScan, firstMine, firstPatterns] = [log.lastIndexOf("item_obligation_scan"), log.indexOf("entity_identifiers"), log.indexOf("derived_values")];
  assert.ok(lastScan >= 0 && firstMine >= 0 && firstPatterns >= 0, `the steps ran: ${[lastScan, firstMine, firstPatterns]}`);
  assert.ok(lastScan < firstMine, "the reading of the backlog finishes before the refs are mined");
  assert.ok(firstMine < firstPatterns, "the refs are mined before the pattern detectors read the spine");
  assert.ok(log.indexOf("obligation_objects") < firstMine, "the obligation objects are written before they are filed");
});

test("INV-3: the propagate stage files the producer tables' rows in entity_refs in the same turn (a market_series row for a fuel entity), and files nothing for intelligence_items or claims: those are the connect stage's", async () => {
  const f = orderFixture();
  const { d } = recorded(f);
  const before = f.db.rows("entity_refs").length;
  assert.equal((await stage(f, "propagate", d)).exit, 0);
  const mined = f.db.rows("entity_refs").filter((r) => r.asserted_by === "coupling/refs");
  const series = f.db.rows("market_series").filter((r) => r.entity_id === E("carrier:hvo"));
  assert.ok(series.length >= 1 && series.every((m) => mined.some((r) => r.ref_table === "market_series" && r.ref_id === m.id && r.entity_id === E("carrier:hvo"))), "every series row of the fuel is filed under it before the turn ends");
  assert.deepEqual([...new Set(mined.map((r) => r.ref_table))].filter((t) => ["intelligence_items", "section_claim_provenance", "obligation_objects", "item_forward_events"].includes(String(t))), []);
  assert.ok(f.db.rows("entity_refs").length > before);
});
