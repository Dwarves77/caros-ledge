// Shared fixtures for the mint tests: a stateful memory database (with an optional PostgREST-style 1,000-row cap on an unranged read), the dependency bundle
// (entities, flywheel, recorder, identity helpers, fetch), one registered EUR-Lex source, census rows and a stored capture, so every flow runs against the same small world.
import { isVerbatim } from "@/core/contracts/verbatim";
import { buildPayload, type ExportRow, type MintRunDeps } from "@/features/mint";

import { installProvenanceRpc, OFFICIAL_TEXT, OFFICIAL_URL } from "../intake/fixtures.ts";
import { MemDb, type Row } from "../intake/memdb.ts";

export const NOW = new Date("2026-10-15T12:00:00.000Z");
export const SOURCE = "b0000000-0000-4000-8000-000000000001";
export const CENSUS = "c0000000-0000-4000-8000-000000000001";
export const TITLE = "Regulation (EU) 2023/9999 establishing greenhouse gas emissions reduction duties for freight operators";
export const CELEX_URL = OFFICIAL_URL;
export { OFFICIAL_TEXT };

/** The shared memory database; with `capped`, the server's max_rows cut applies to an UNRANGED select (a ranged read is not cut), which is what made the old dedup see at most 1,000 rows. */
export class WorldDb extends MemDb {
  constructor(capped = false) {
    super(capped ? { cap: 1000 } : {});
  }
}

export interface Rec { runs: { family: string; itemId?: string | null; outcome: string; counts: Record<string, number>; notes: string[] }[]; connects: string[]; flushed: string[][] }

export function makeDeps(db: MemDb, over: Partial<MintRunDeps> = {}): { deps: MintRunDeps; rec: Rec } {
  const rec: Rec = { runs: [], connects: [], flushed: [] };
  const deps: MintRunDeps = {
    sb: db.client,
    now: () => NOW,
    entities: {
      sourceRole: (url) => (/\/news\/|prnewswire/.test(url) ? "news" : /eur-lex|legislation\.gov\.uk/.test(url) ? "primary" : "other"),
      congruence: (type, url) => (/\/news\//.test(url) && ["regulation", "directive", "standard", "guidance", "framework"].includes(String(type)) ? { itemType: "market_signal", changed: true, incongruentSource: false } : /\/news\//.test(url) && type === "research_finding" ? { itemType: type ?? "", changed: false, incongruentSource: true } : { itemType: type ?? "", changed: false, incongruentSource: false }),
      matchExistingSubject: (seed, corpus) => corpus.filter((c) => (c.instrument_identifier && c.instrument_identifier === seed.instrument_identifier) || c.title === seed.title).map((c) => ({ id: c.id, how: "instrument" })),
    },
    connect: {
      connect: async (id) => (rec.connects.push(`connect:${id}`), { written: 1 }),
      extractAndInsertForwardEvents: async (id) => (rec.connects.push(`events:${id}`), { attempted: 0, inserted: 0, collision: false, staleIds: [] }),
      deriveObligations: async (id) => (rec.connects.push(`obligations:${id}`), { derived: 0 }),
      linkEntities: async (id) => (rec.connects.push(`entities:${id}`), { refs: 0 }),
    },
    recorder: { recordRun: async (e) => (rec.runs.push(e), { error: null }), now: () => NOW },
    identity: {
      deriveKey: (identifier, url) => /CELEX:([0-9A-Z()]+)/.exec(String(url ?? ""))?.[1] ?? identifier,
      sameInstitution: (a, b) => !!a && !!b && new URL(String(a)).hostname === new URL(String(b)).hostname,
    },
    fetch: { db: db.client, env: {}, caller: "manual-intake-run", fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch },
    isSeriesKey: (id) => id === "oil_bulletin_diesel",
    flushCache: async (tags) => (rec.flushed.push(tags), { error: null }),
    ...over,
  };
  return { deps, rec };
}

const SLOTS = [{ item_type: "regulation", slot_key: "binding_position", description: "applicability" }, { item_type: "regulation", slot_key: "due_date", description: "due date" }];

/** One registered source, one would_mint census row with a stored capture, the required slots, and the database's provenance gate. */
export function makeWorld(opts: { capped?: boolean; census?: Row[]; items?: Row[]; storedText?: string | null; skipScreenTable?: boolean } = {}) {
  const db = new WorldDb(!!opts.capped);
  db.seed("sources", [{ id: SOURCE, name: "EUR-Lex", url: "https://eur-lex.europa.eu/", base_tier: 1, tier_override: null, status: "active", institution_id: null, category: "regulatory" }]);
  db.seed("census_worklist", opts.census ?? [{ id: CENSUS, source_id: SOURCE, document_url: CELEX_URL, title: TITLE, surface_tags: [], instrument_identifier: "32023R9999", dryrun_disposition: "would_mint", hold_reason: null, notes: null, is_archived: false, enumeration_status: "discovered" }]);
  db.seed("intelligence_items", opts.items ?? []);
  db.seed("item_type_required_slots", SLOTS);
  db.seed("screen_verdicts", []);
  if (opts.storedText !== null) db.seed("agent_run_searches", [{ intelligence_item_id: null, result_url: CELEX_URL, result_content: opts.storedText ?? OFFICIAL_TEXT, result_index: 0, search_query: "stored" }]);
  installProvenanceRpc(db);
  return db;
}

/** The trigger stand-in for a freshly inserted item: criterion 3 (every FACT span verbatim in its capture) is the only criterion the memory database models. */
export const verbatimIn = (db: MemDb, itemId: string): boolean => db.rows("section_claim_provenance").filter((c) => c.intelligence_item_id === itemId && c.claim_kind === "FACT").every((f) => isVerbatim(String(db.rows("agent_run_searches").find((r) => r.id === f.search_result_id)?.result_content ?? ""), String(f.source_span ?? "")));

/** The exported row for the fixture census row (on_vertical by rule), ready for buildPayload. */
export function exportRow(over: Partial<ExportRow> = {}): ExportRow {
  return {
    census_id: CENSUS, source_url: CELEX_URL, item_type: "regulation", title: "Regulation (EU) 2023/9999 on sustainable freight operations", title_origin: "captured_title", instrument_identifier: "32023R9999",
    canonical_instrument_key: "32023R9999", jurisdiction_iso: "EU", priority: "MODERATE",
    source: { id: SOURCE, url: "https://eur-lex.europa.eu/", name: "EUR-Lex", base_tier: 1, tier_override: null, status: "active", institution_id: null, category: "regulatory" },
    captured_text: OFFICIAL_TEXT, fetched_length: OFFICIAL_TEXT.length,
    screen: { verdict: "on_vertical", rule: "core_sustainability_climate_environment", basis: "rule", provenance: "rule" },
    ...over,
  };
}
export function builtPayload(over: Partial<ExportRow> = {}, slots: string[] = ["binding_position", "due_date"]) {
  const r = buildPayload(exportRow(over), slots);
  if (!r.ok) throw new Error(r.error);
  return r.built;
}
