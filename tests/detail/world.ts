// The detail tests' world: ONE MemDb holding a verified regulation with its sections, claims, sources, timeline, links, themes and inferences, plus the items that must NOT render on /regulations (a
// market item, an unverified item, an archived one). The SQL view fact_suppressions is emulated over item_corrections exactly as migration 0031 defines it (target_kind = fact, an item the reader can open).
import { MemDb, type Row } from "../_support/memdb.ts";

export const REG = "aaaaaaaa-1000-4000-8000-000000000001";
export const MKT = "aaaaaaaa-1000-4000-8000-000000000002";
export const UNVERIFIED = "aaaaaaaa-1000-4000-8000-000000000003";
export const ARCHIVED = "aaaaaaaa-1000-4000-8000-000000000004";
export const OTHER_REG = "aaaaaaaa-1000-4000-8000-000000000005";
export const SRC_T1 = "bbbbbbbb-1000-4000-8000-000000000001";
export const SRC_T3 = "bbbbbbbb-1000-4000-8000-000000000002";
export const NOW_ISO = "2026-10-15T12:00:00.000Z";
const claim = (id: string, text: string, src: string, over: Row = {}): Row => ({ id, intelligence_item_id: REG, claim_text: text, claim_kind: "FACT", source_id: src, section_row_id: "cccccccc-1000-4000-8000-000000000003", ...over });

export const CLAIM_KEPT = "Operators shall submit a verified annual emissions report to the competent authority before 31 March of each year.";
export const CLAIM_SUPPRESSED = "A penalty of 4,000 euro per tonne applies to every operator in every case without exception.";

export function world(): MemDb {
  const db = new MemDb({ ids: "uuid" });
  db.seed("sources", [
    { id: SRC_T1, name: "EUR-Lex", url: "https://eur-lex.europa.eu/doc", base_tier: 1, tier_override: null, effective_tier: 5 },
    { id: SRC_T3, name: "Trade Press", url: "https://press.example.test/a", base_tier: 3, tier_override: 2, effective_tier: 7 },
  ]);
  db.seed("intelligence_items", [
    { id: REG, legacy_id: "g14", title: "Regulation (EU) 2023/9999 on freight emissions", item_type: "regulation", domain: 1, provenance_status: "verified", is_archived: false, priority: "HIGH", source_id: SRC_T1, source_url: "https://eur-lex.europa.eu/doc", item_grade: "brief", jurisdiction_iso: ["EU"], jurisdictions: ["eu"], transport_modes: ["road"], category: "emissions", added_date: "2026-01-02", what_is_it: "Annual emissions reporting for heavy goods vehicle operators.", full_brief: "## 15. Sources\n| Source Name | Tier | URL |\n|---|---|---|\n| EUR-Lex | Tier 1 | https://eur-lex.europa.eu/doc |\n| Trade Press | Tier 1 | https://press.example.test/a |\n| Unrated Blog | Tier 1 | https://blog.example.test/z |\n", recommended_actions: [{ action_text: "Assess your fleet reporting readiness", verb: "Assess", timeframe_days: 30, owner: null, due_date: null, source_section: "3" }], compliance_deadline: "2027-01-01", penalty_range: "up to 4,000 EUR per tonne" },
    { id: MKT, legacy_id: null, title: "EU carbon price weekly", item_type: "market_signal", domain: 4, provenance_status: "verified", is_archived: false, priority: "MODERATE" },
    { id: UNVERIFIED, legacy_id: null, title: "Unverified rule", item_type: "regulation", domain: 1, provenance_status: "unverified", is_archived: false, priority: "HIGH" },
    { id: ARCHIVED, legacy_id: "g99", title: "Archived rule", item_type: "regulation", domain: 1, provenance_status: "verified", is_archived: true, priority: "LOW" },
    { id: OTHER_REG, legacy_id: "g15", title: "Directive on packaging", item_type: "regulation", domain: 1, provenance_status: "verified", is_archived: false, priority: "MODERATE", item_grade: "brief" },
  ]);
  const sections = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"].map((k, i) => ({ id: `cccccccc-1000-4000-8000-0000000000${String(i + 1).padStart(2, "0")}`, item_id: REG, section_key: k, section_order: i + 1, content_md: `Section ${k} body.`, is_conditional: false, source_ids: [] }));
  const s3 = sections.find((s) => s.section_key === "3") as Row;
  s3.id = "cccccccc-1000-4000-8000-000000000003";
  s3.content_md = `**ACTION REQUIRED** Register with the competent authority.\n\n${CLAIM_KEPT} Source: EUR-Lex, Regulation 2023/9999, 2026 https://eur-lex.europa.eu/doc\n\n${CLAIM_SUPPRESSED} Source: Trade Press, 2026`;
  db.seed("intelligence_item_sections", sections);
  db.seed("section_claim_provenance", [claim("dddddddd-1000-4000-8000-000000000001", CLAIM_KEPT, SRC_T1), claim("dddddddd-1000-4000-8000-000000000002", CLAIM_SUPPRESSED, SRC_T3), claim("dddddddd-1000-4000-8000-000000000003", "an analysis claim", SRC_T3, { claim_kind: "ANALYSIS" })]);
  db.seed("item_timelines", [{ id: "eeeeeeee-1000-4000-8000-000000000001", item_id: REG, milestone_date: "2026-03-31", label: "First report due", is_completed: true, sort_order: 1 }]);
  db.seed("item_changelog", [{ id: "eeeeeeee-1000-4000-8000-000000000002", item_id: REG, change_date: "2026-05-01", change_type: "UPDATED", field: "x", impact: "Reporting now covers rail operators." }]);
  db.seed("item_cross_references", [{ id: "eeeeeeee-1000-4000-8000-000000000003", source_item_id: REG, target_item_id: MKT, relationship: "related", origin: "manual", basis: null, score: null, source: { id: REG, legacy_id: "g14", item_type: "regulation", domain: 1 }, target: { id: MKT, legacy_id: null, item_type: "market_signal", domain: 4 } }]);
  db.seed("item_corrections", [{ id: "ffffffff-1000-4000-8000-000000000001", item_id: REG, target_kind: "fact", target_ref: "dddddddd-1000-4000-8000-000000000002", op: "suppress", machine_value: { claim_text: CLAIM_SUPPRESSED }, reason: "unsupported", created_by: "u1", created_at: "2026-09-01T00:00:00Z", revoked_at: null }]);
  db.views.fact_suppressions = () =>
    db
      .rows("item_corrections")
      .filter((c) => c.target_kind === "fact" && db.rows("intelligence_items").some((i) => i.id === c.item_id && i.provenance_status === "verified" && i.is_archived !== true))
      .map((c) => ({ id: c.id, item_id: c.item_id, target_kind: c.target_kind, target_ref: c.target_ref, op: c.op, machine_value: c.machine_value, created_at: c.created_at, revoked_at: c.revoked_at }));
  db.seed("connection_themes", [{ id: "theme-1", member_ids: [REG, MKT], dominant_signals: [{ signal: "shared_source", weight: 1 }], surfaces: ["regulations", "market"], density: 0.5, convergence: 0.8, pivots: [] }]);
  db.seed("theme_briefs", []);
  db.seed("connection_theme_runs", []);
  const inf = (id: string, over: Row = {}): Row => ({ inference_id: id, subject_id: null, claim_text: `claim ${id}`, status_token: "HYPOTHESIS", confidence: 0.6, cited_item_ids: [REG], origin_class: "derived", supersedes: null, trigger_question_ref: "q:what", method_id: "infer-from-question", method_version: "1", admissibility: "current", computed_at: `2026-10-0${id.slice(-1)}T00:00:00Z`, computed_by: "t", ...over });
  db.seed("inference_records", [inf("i1"), inf("i2", { method_id: "other-method" }), inf("i3", { admissibility: "stale" }), inf("i4", { cited_item_ids: [UNVERIFIED] }), inf("i5", { supersedes: null }), inf("i6", { supersedes: "i5" })]);
  return db;
}
