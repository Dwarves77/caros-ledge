// Shared fixtures for the intake slice tests: a memory database, the four dependency stubs (sources, mint, connect, recorder), a
// stand-in for the database's validate_item_provenance (criterion 3: every FACT span verbatim in the capture it is attributed to),
// and one fixture item with a stored pool, so every flow runs against the same small world.
import { isVerbatim } from "@/core/contracts/verbatim";
import { poolHash } from "@/core/grounding";
import type { IntakeDeps, MintInput, MintResult } from "@/features/intake/deps";

import { installLedgerRpcs } from "../_support/ledger-rpcs.ts";

import { MemDb, type Row } from "./memdb.ts";

export const NOW = new Date("2026-10-15T12:00:00.000Z");
export const ITEM = "a0000000-0000-4000-8000-000000000001";
export const SOURCE = "b0000000-0000-4000-8000-000000000001";
export const CORROB = "b0000000-0000-4000-8000-000000000002";
export const OFFICIAL_URL = "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32023R9999";
export const OTHER_URL = "https://example-news.test/article/9999";
export const OFFICIAL_TEXT = [
  "Regulation (EU) 2023/9999 of the European Parliament and of the Council on sustainable freight operations.",
  "Article 1. This Regulation applies to operators of cargo aircraft and to operators of container vessels calling at Union ports.",
  "Article 2. Operators shall report verified annual emissions to the competent authority before 30 April of each year.",
  "Article 3. A penalty of up to EUR 50 000 shall apply to an operator that fails to report within the period set out in Article 2.",
  "Article 4. This Regulation shall enter into force on 1 January 2027 and shall be binding in its entirety.",
].join("\n");
export const OTHER_TEXT = "Industry observers expect the freight reporting regime to tighten over the next three years, according to several carriers. ".repeat(4);

/** A span of OFFICIAL_TEXT, verbatim. */
export const SPAN_REPORT = "Operators shall report verified annual emissions to the competent authority before 30 April of each year.";
export const SPAN_PENALTY = "A penalty of up to EUR 50 000 shall apply to an operator that fails to report within the period set out in Article 2.";
export const SPAN_FORCE = "This Regulation shall enter into force on 1 January 2027 and shall be binding in its entirety.";

export interface Recorded { runs: unknown[]; mints: { input: MintInput; dry: boolean }[]; connects: string[] }

export function makeWorld(opts: { itemType?: string; briefGrade?: boolean; pool?: { url: string; text: string }[]; withSource?: boolean } = {}) {
  const db = new MemDb();
  const itemType = opts.itemType ?? "market_signal";
  db.seed("sources", [
    { id: SOURCE, name: "EUR-Lex", url: "https://eur-lex.europa.eu/", base_tier: 1, tier_override: null, status: "active" },
    { id: CORROB, name: "News", url: "https://example-news.test/", base_tier: 5, tier_override: null, status: "active" },
  ]);
  db.seed("intelligence_items", [{ id: ITEM, title: "Sustainable freight operations regulation", item_type: itemType, item_grade: opts.briefGrade ? "brief" : "record", source_id: opts.withSource === false ? null : SOURCE, source_url: OFFICIAL_URL, provenance_status: "quarantined", is_archived: false, full_brief: null, legacy_id: "t-9999", instrument_type: null, instrument_identifier: "2023/9999", canonical_instrument_key: null, jurisdiction_iso: ["EU"] }]);
  (opts.pool ?? [{ url: OFFICIAL_URL, text: OFFICIAL_TEXT }, { url: OTHER_URL, text: OTHER_TEXT }]).forEach((p, i) => db.seed("agent_run_searches", [{ intelligence_item_id: ITEM, result_url: p.url, result_content: p.text, result_index: i, search_query: "canonical ground" }]));

  const rec: Recorded = { runs: [], mints: [], connects: [] };
  let minted = 0;
  const hostTier: Record<string, { tier: number; institution: string; id: string }> = {
    "eur-lex.europa.eu": { tier: 1, institution: "European Union", id: SOURCE },
    "example-news.test": { tier: 5, institution: "News", id: CORROB },
  };
  const deps: IntakeDeps = {
    sb: db.client,
    sources: {
      resolveSource: (url) => {
        const h = hostTier[new URL(url).hostname];
        return h ? { tier: h.tier, institution: h.institution, sourceId: h.id } : null;
      },
      registerAndRate: async (url) => {
        const known = db.rows("sources").find((r) => new URL(String(r.url)).hostname === new URL(url).hostname);
        if (known) return { sourceId: known.id as string, tier: (known.tier_override ?? known.base_tier) as number };
        const id = `b0000000-0000-4000-8000-0000000001${String(db.rows("sources").length).padStart(2, "0")}`;
        db.seed("sources", [{ id, name: new URL(url).hostname, url, base_tier: 4, status: "active" }]);
        return { sourceId: id, tier: 4 };
      },
      matchTarget: () => ({ verdict: "match" }),
      officialness: () => ({ path: "a", cleanBody: null }),
      classifyBody: (b) => (b.startsWith("Access Denied") ? { errorBody: true, reason: "bot wall" } : { errorBody: false }),
      classTierForHost: (h) => (h.endsWith(".europa.eu") ? 1 : null),
      holdingsGate: () => ({ present: true, detail: "ok" }),
      fetchAllowed: () => false,
      capture: async () => ({ ok: false, text: "", reason: "fetch not allowed in build mode" }),
    },
    mint: {
      mintItem: async (input, o): Promise<MintResult> => {
        rec.mints.push({ input, dry: o.dry });
        if (typeof input.seed.source_url === "string" && input.seed.source_url.includes("reject-me")) return { itemId: null, outcome: "rejected", reasons: ["entity-gate: refused by the fixture"] };
        if (o.dry) return { itemId: null, outcome: "minted", reasons: ["dry"] };
        const id = `a0000000-0000-4000-8000-0000000009${String(++minted).padStart(2, "0")}`;
        db.seed("intelligence_items", [{ id, ...input.seed, item_grade: input.grade ?? "record", provenance_status: "quarantined" }]);
        return { itemId: id, outcome: "minted", reasons: [] };
      },
    },
    connect: {
      connect: async (id) => (rec.connects.push(`connect:${id}`), { written: 1 }),
      extractAndInsertForwardEvents: async (id) => (rec.connects.push(`events:${id}`), { attempted: 1, inserted: 1, collision: false, staleIds: [] }),
      deriveObligations: async (id) => (rec.connects.push(`obligations:${id}`), { derived: 1 }),
      linkEntities: async (id) => (rec.connects.push(`entities:${id}`), { refs: 1 }),
    },
    recorder: { recordRun: async (e) => (rec.runs.push(e), { error: null }), now: () => NOW },
  };
  installProvenanceRpc(db);
  return { db, deps, rec };
}

/** The database's gate, reduced to criterion 3 and the "at least one FACT" floor: sets the cached provenance_status like the trigger. */
export function installProvenanceRpc(db: MemDb): void {
  installLedgerRpcs(db);
  db.rpcs.validate_item_provenance = (args, d) => {
    const id = args.p_item_id as string;
    const facts = d.rows("section_claim_provenance").filter((c) => c.intelligence_item_id === id && c.claim_kind === "FACT");
    const failures: { criterion: number; reason: string }[] = [];
    if (!facts.length) failures.push({ criterion: 1, reason: "no_fact_claims" });
    for (const f of facts) {
      const cap = d.rows("agent_run_searches").find((r) => r.id === f.search_result_id);
      if (!cap || !isVerbatim(cap.result_content as string, f.source_span as string | null)) failures.push({ criterion: 3, reason: "span_not_in_capture" });
    }
    const valid = failures.length === 0;
    const item = d.rows("intelligence_items").find((r) => r.id === id);
    if (item) item.provenance_status = valid ? "verified" : "quarantined";
    return { data: [{ valid, recommended_status: valid ? "verified" : "quarantined", failures }] };
  };
  db.rpcs.acquire_mutation_lease = (a, d) => {
    const held = d.rows("mutation_leases").find((l) => l.intelligence_item_id === a.p_item && l.holder !== a.p_holder);
    if (held) return { data: [{ acquired: false, takeover: false, cur_holder: held.holder }] };
    if (!d.rows("mutation_leases").some((l) => l.intelligence_item_id === a.p_item)) d.seed("mutation_leases", [{ intelligence_item_id: a.p_item, holder: a.p_holder }]);
    return { data: [{ acquired: true, takeover: false, cur_holder: a.p_holder }] };
  };
  db.rpcs.heartbeat_mutation_lease = (a, d) => ({ data: [{ still_held: d.rows("mutation_leases").some((l) => l.intelligence_item_id === a.p_item && l.holder === a.p_holder) }] });
  db.rpcs.release_mutation_lease = (a, d) => {
    const before = d.rows("mutation_leases").length;
    d.tables.mutation_leases = d.rows("mutation_leases").filter((l) => !(l.intelligence_item_id === a.p_item && l.holder === a.p_holder));
    return { data: [{ released: d.rows("mutation_leases").length < before }] };
  };
}

export const poolHashOf = (db: MemDb, itemId = ITEM): string => poolHash(db.rows("agent_run_searches").filter((r) => r.intelligence_item_id === itemId && String(r.result_content ?? "").trim().length > 200).map((r) => ({ url: r.result_url, text: r.result_content })));

/** A body that satisfies the market_signal_brief section walk (headings from the contract) with prose long enough to pass the length floor. */
export function marketSignalBody(over: { sources?: string; extra?: string } = {}): string {
  const heads = ["What's Moving and What Triggered It", "Who's Driving It and What They Want", "Expected Trajectory and Conversion Triggers", "Operational and Cost Implications If It Materializes", "Competitive Implications", "Client Conversation Talking Points", "What the Workspace Should Do Now", "Sources"];
  const prose = (n: number) => `Operators of cargo aircraft and container vessels face a new annual emissions reporting duty under Regulation (EU) 2023/9999 (section ${n}). ${SPAN_REPORT} The duty enters into force on 1 January 2027 and carries a penalty for late reporting, so the reporting calendar belongs in this quarter's planning. ${over.extra ?? ""}`;
  const timeline = "- 1 January 2027: Regulation (EU) 2023/9999 enters into force.\n- 30 April 2028: first annual emissions report is due.";
  return heads.map((h, i) => `## ${i + 1}. ${h}\n\n${i === 7 ? (over.sources ?? `- EUR-Lex: ${OFFICIAL_URL}`) : i === 2 ? `${prose(i + 1)}\n\n${timeline}` : prose(i + 1)}`).join("\n\n");
}

/** Metadata that satisfies the contract for market_signal_brief; override a field to attack it. */
export function metadata(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    what_is_it: "A new annual emissions reporting duty for cargo operators.", severity: "COST ALERT", priority: "HIGH", urgency_tier: "elevated", format_type: "market_signal_brief",
    topic_tags: ["emissions", "reporting"], signal_band: "corporate", theme: null, operational_scenario_tags: [], compliance_object_tags: [], related_items: [],
    intersection_summary: "Reporting duty interacts with carrier surcharge pass-through.", sources_used: [SOURCE], regeneration_skill_version: "2026-09-11",
    what_it_changes: "Adds a fixed annual reporting deadline of 30 April for every cargo operator, so the reporting calendar and its internal owners must be settled this quarter.", does_not_resolve: "Which authority is competent for third-country operators.", conversion_trigger: "Publication of the delegated act.",
    cross_references: null, cost_mechanism: "Administrative reporting cost.", penalty_range: "Up to EUR 50 000", enforcement_body: "Competent authority", requirement_trajectory: { steps: [{ date: "2027-01-01", value: "annual reporting" }, { date: "2030-01-01", value: "tightened limits" }] },
    why_matters: "Late reporting carries a financial penalty.", key_data: ["30 April annual deadline"], ...over,
  };
}

export const factClaim = (span: string, over: Record<string, unknown> = {}) => ({ section: "1", claim_text: span.slice(0, 80), claim_kind: "FACT", source_span: span, source_id: SOURCE, source_url: OFFICIAL_URL, slot_key: null, ...over });
export const rowsOf = (db: MemDb, table: string, where: (r: Row) => boolean = () => true) => db.rows(table).filter(where);
