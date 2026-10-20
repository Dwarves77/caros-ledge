// The database the impact tests read: verified items with captures, claims and sources, in the shared memory database (tests/_support/memdb.ts).
import { MemDb, type Row } from "../_support/memdb.ts";

export const NOW = new Date("2026-10-15T12:00:00.000Z");
export const SOURCE = "a0000000-0000-4000-8000-000000000001";
export const I1 = "11111111-0000-4000-8000-000000000001";
export const I2 = "11111111-0000-4000-8000-000000000002";
export const I3 = "11111111-0000-4000-8000-000000000003";
export const C1 = "22222222-0000-4000-8000-000000000001";
export const C2 = "22222222-0000-4000-8000-000000000002";
export const C3 = "22222222-0000-4000-8000-000000000003";

/** An instrument's text as the publisher serves it: the Article heading, then the duty. Long enough to be a usable capture. */
export const DUTY_TEXT = `${[
  "Regulation (EU) 2026/77 on voyage emissions reporting.",
  "Article 5 Reporting",
  "1. Carriers shall report the emissions of each voyage to the competent authority before 30 April 2027.",
  "Article 6 Records",
  "Shippers shall keep the voyage records for five years and the penalty for failing to do so is set out in Article 9 of Directive 2003/87/EC.",
  "Article 7 Entry into force",
  "This Regulation shall enter into force on 1 January 2027.",
].join("\n")}\n${"Notice. This text is provided for information only and is not the authentic version. ".repeat(4)}`;
/** A text with no duty a holder bears: a holder named after the verb, and an Article that cites another instrument. */
export const NO_DUTY_TEXT = `${[
  "Guidance note on voyage reporting.",
  "This Regulation shall be binding in its entirety and directly applicable in all Member States.",
  "The Commission shall review Article 3(1) of Directive (EU) 2019/883 by the end of the period.",
].join("\n")}\n${"Notice. This text is provided for information only and is not the authentic version. ".repeat(4)}`;

export const item = (id: string, over: Row = {}): Row => ({
  id, title: `Instrument ${id.slice(-1)}`, is_archived: false, provenance_status: "verified", item_type: "regulation", source_id: SOURCE, jurisdiction_iso: ["EU"],
  instrument_identifier: "Regulation (EU) 2026/77", canonical_instrument_key: null, last_regenerated_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  transport_modes: [], operational_scenario_tags: [], compliance_object_tags: [], topic_tags: [], cost_mechanism: null, penalty_range: null, compliance_deadline: null, ...over,
});
export const capture = (id: string, itemId: string, text: string): Row => ({ id, intelligence_item_id: itemId, result_url: `https://eur-lex.example.test/${id.slice(-1)}`, result_content: text, result_index: 0, search_query: "capture" });

export function world(items: Row[], captures: Row[], extra: Record<string, Row[]> = {}): MemDb {
  const db = new MemDb();
  db.seed("sources", [{ id: SOURCE, name: "EUR-Lex", url: "https://eur-lex.example.test/", base_tier: 1, tier_override: null, status: "active" }]);
  db.seed("intelligence_items", items);
  db.seed("agent_run_searches", captures);
  for (const [t, rows] of Object.entries(extra)) db.seed(t, rows);
  return db;
}
