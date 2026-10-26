// The per-kind worlds the batch tests share: a small memory database for each kind of batch, and the file a session would author from it. The per-kind tests attack one world; the end-to-end test runs every kind through the
// briefs stage on the same worlds (export, author, dry apply, apply, re-apply).
import { CLASSIFY_PROMPT_VERSION } from "@/core/intake";

import { batchWorld, ITEM, NOW, SOURCE, SPAN_FORCE, SPAN_REPORT } from "./world.ts";

export type World = ReturnType<typeof batchWorld>;

/** A verified record-grade stub with its pool: what the brief export selects by default. */
export function recordWorld(): World {
  const w = batchWorld();
  (w.db.rows("intelligence_items")[0] as Record<string, unknown>).provenance_status = "verified";
  return w;
}

export const REF = `${ITEM}:regulations:what`;

/** A verified item with one open question and the registration function the database owns (migration 339), as a stand-in. */
export function qaWorld(): World {
  const w = batchWorld();
  (w.db.rows("intelligence_items")[0] as Record<string, unknown>).provenance_status = "verified";
  (w.db.rows("intelligence_items")[0] as Record<string, unknown>).domain = 1;
  w.db.seed("integrity_flags", [{ id: "f0000000-0000-4000-8000-000000000001", category: "question", subject_type: "item", subject_ref: REF, created_by: "question:what", description: "What changed in the reporting duty for cargo operators?", recommended_actions: [], status: "open", created_at: "2026-10-01T00:00:00.000Z" }]);
  let n = 0;
  w.db.rpcs.register_inference_record = (a, d) => {
    const id = `e0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    d.rows("inference_records").push({ inference_id: id, subject_id: a.p_subject_id, claim_text: a.p_claim_text, status_token: a.p_status_token, confidence: a.p_confidence, cited_item_ids: a.p_cited_item_ids, trigger_question_ref: a.p_trigger_question_ref, supersedes: a.p_supersedes, computed_at: "2026-10-15T12:00:00.000Z" });
    return { data: id };
  };
  return w;
}

export const T_FLAG = "f1000000-0000-4000-8000-000000000001";
export const H_FLAG = "f1000000-0000-4000-8000-000000000002";
export const G_FLAG = "f1000000-0000-4000-8000-000000000003";
export const L_FLAG = "f1000000-0000-4000-8000-000000000004";

export function needsWorld(): World {
  const w = batchWorld();
  const flag = (id: string, created_by: string, subject_ref: string, over: Record<string, unknown> = {}) => ({ id, category: "coverage_gap", subject_type: "item", subject_ref, created_by, description: "gap", recommended_actions: [], status: "open", created_at: "2026-10-01T00:00:00.000Z", ...over });
  w.db.seed("integrity_flags", [
    flag(T_FLAG, "term-need:standard", "term-1", { recommended_actions: [{ action: "find-source", need: "The IMO EEXI technical guidelines", kind: "standard" }] }),
    flag(H_FLAG, "holdings-need:what", `${ITEM}:regulations:what`, { recommended_actions: [{ action: "find-source", need: "The delegated act naming the competent authority", item_id: ITEM, surface: "regulations", product_question: "what" }] }),
    flag(G_FLAG, "flywheel-gap:surface_gap", "theme-1", { description: "Theme theme-1 spans regulations but has no operations item" }),
    flag(L_FLAG, "lineage-gap:absent-parent", ITEM, { description: "Item cites parents that do not resolve: Directive 2009/28/EC (amends)", recommended_actions: [{ action: "x", rationale: "item amends Directive 2009/28/EC, which does not resolve to any item in the corpus" }] }),
  ]);
  return w;
}

export const ARCHIVED = "a0000000-0000-4000-8000-0000000000a1";
export const UNVERIFIED = "a0000000-0000-4000-8000-0000000000a2";
export const CLAIM = "c1000000-0000-4000-8000-000000000001";
export const SECTION = "c2000000-0000-4000-8000-000000000001";
export const T = { open: "t0000000-0000-4000-8000-000000000001", archived: "t0000000-0000-4000-8000-000000000002", deferred: "t0000000-0000-4000-8000-000000000003" };

export function feWorld(): World {
  const w = batchWorld();
  (w.db.rows("intelligence_items")[0] as Record<string, unknown>).provenance_status = "verified";
  const base = { item_type: "market_signal", item_grade: "record", source_id: "b0000000-0000-4000-8000-000000000001", source_url: "https://eur-lex.europa.eu/x", full_brief: null };
  w.db.seed("intelligence_items", [{ id: ARCHIVED, title: "Archived", provenance_status: "verified", is_archived: true, ...base }, { id: UNVERIFIED, title: "Unverified", provenance_status: "quarantined", is_archived: false, ...base }]);
  w.db.seed("section_claim_provenance", [{ id: CLAIM, intelligence_item_id: ITEM, claim_kind: "FACT", claim_text: `[effective_date] ${SPAN_FORCE}`, source_span: SPAN_FORCE, source_id: "b0000000-0000-4000-8000-000000000001" }]);
  w.db.seed("intelligence_item_sections", [{ id: SECTION, item_id: ITEM, section_key: "1", section_order: 1, content_md: `The Regulation says: ${SPAN_FORCE}`, is_conditional: false }]);
  const t = (id: string, item: string, at: string) => ({ id, intelligence_item_id: item, reason: "item_minted_or_touched", requested_at: at, consumed_at: null, consumed_by: null });
  w.db.seed("corpus_turn_requests", [t(T.open, ITEM, "2026-10-01T00:00:00.000Z"), t(T.archived, ARCHIVED, "2026-10-02T00:00:00.000Z"), t(T.deferred, UNVERIFIED, "2026-10-03T00:00:00.000Z")]);
  return w;
}

export const THEME = "d0000000-0000-4000-8000-000000000001";
export const SECOND = "a0000000-0000-4000-8000-000000000002";
export const CLAIM_A = "c1000000-0000-4000-8000-000000000001";
export const CLAIM_B = "c1000000-0000-4000-8000-000000000002";
export const EVENT_B = "e1000000-0000-4000-8000-000000000001";

export function themeWorld(): World {
  const w = batchWorld();
  (w.db.rows("intelligence_items")[0] as Record<string, unknown>).provenance_status = "verified";
  w.db.seed("intelligence_items", [{ id: SECOND, title: "Carrier surcharge pass-through", item_type: "regulation", item_grade: "brief", provenance_status: "verified", is_archived: false, source_id: "b0000000-0000-4000-8000-000000000001", source_url: "https://eur-lex.europa.eu/x" }]);
  w.db.seed("connection_themes", [{ id: THEME, member_ids: [SECOND, ITEM], surfaces: ["regulations"], pivots: [], dominant_signals: [], density: 0.5, convergence: 0.7 }]);
  w.db.seed("section_claim_provenance", [{ id: CLAIM_A, intelligence_item_id: ITEM, claim_kind: "FACT", claim_text: SPAN_REPORT, source_span: SPAN_REPORT }, { id: CLAIM_B, intelligence_item_id: SECOND, claim_kind: "FACT", claim_text: "Carriers pass the cost on.", source_span: "Carriers pass the cost on." }]);
  w.db.seed("item_forward_events", [{ id: EVENT_B, intelligence_item_id: SECOND, event_date: "2027-01-01", date_precision: "day", event_kind: "entry_into_force", obligation_text: "Surcharges apply.", source_kind: "claim", source_claim_id: CLAIM_B, source_span: "Carriers pass the cost on.", confidence: "high", extractor_version: "t" }]);
  return w;
}

export const C1 = "c0000000-0000-4000-8000-000000000011";
export const C2 = "c0000000-0000-4000-8000-000000000012";
export const C3 = "c0000000-0000-4000-8000-000000000013";

export function screenWorld(): World {
  const w = batchWorld();
  const row = (id: string, url: string, reason: string, disp = "hold") => ({ id, source_id: SOURCE, document_url: url, lane: "C", title: `Doc ${id.slice(-2)}`, dryrun_disposition: disp, hold_reason: disp === "hold" ? reason : null, enumeration_status: "discovered", surface_tags: [], notes: JSON.stringify({ export_kind: "screen-verdict" }) });
  w.db.seed("census_worklist", [row(C1, "https://a.example/1", "screen:ambiguous:no_signal_ambiguous"), row(C2, "https://a.example/2", "screen:ambiguous:no_signal_ambiguous"), row(C3, "https://a.example/3", "screen:off_vertical:x")]);
  return w;
}

export const URL1 = "https://agency.test/rules/10";
export const URL2 = "https://agency.test/rules/11";
export const verdict = (url: string, over: Record<string, unknown> = {}) => ({ candidate_id: `p-${url.slice(-2)}`, url, entity_verdict: "specific_document", item_type: "regulation", confidence: 0.9, rationale: "a specific regulation", classified_by: "session-haiku", classified_at: NOW.toISOString(), prompt_version: CLASSIFY_PROMPT_VERSION, domain: 1, severity: "MONITORING", priority: "LOW", urgency_tier: "stable", title_candidate: `Doc ${url.slice(-2)}`, summary: "s", surface_tags: ["regulations"], relevance: 80, ...over });
export const ledgerFile = (entries: unknown[], over: Record<string, unknown> = {}) => ({ batch: "ledger-verdicts-001", generated_at: NOW.toISOString(), prompt_version: CLASSIFY_PROMPT_VERSION, classified_by: "session-haiku", entries, ...over });
export function ledgerWorld(): World {
  const w = batchWorld();
  const rows = [URL1, URL2].map((url, i) => ({ id: `p-${url.slice(-2)}`, url, anchor_text: null, source_id: SOURCE, first_seen_at: `2026-10-0${i + 1}T00:00:00Z`, source_name: "S", source_category: "regulatory", source_base_tier: 1 }));
  w.db.seed("portal_link_candidates", rows.map((r) => ({ id: r.id, url: r.url, status: "candidate", source_id: SOURCE })));
  w.db.rpcs.next_uncensused_portal_candidates = () => ({ data: w.db.rows("portal_link_candidates").filter((r) => r.status === "candidate").map((r) => ({ ...rows.find((x) => x.id === r.id) })) });
  return w;
}

/** The unplaced hosts registerAndRate kept on host_worklist (migration 0064), for the host-verdicts export. */
export function hostWorld(): World {
  const w = batchWorld();
  w.db.seed("host_worklist", ["one.example", "two.example"].map((host, i) => ({ host, reason: "no class", seen_count: 3 - i, first_seen_at: "2026-10-01T00:00:00Z", last_seen_at: "2026-10-02T00:00:00Z", last_name: null })));
  return w;
}
