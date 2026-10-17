"use client";

import { buildCoverageMatrix, buildCoverageView, parseCoverageQuery } from "@/core/coverage/matrix";
import { CoveragePage } from "@/features/coverage";

import type { ItemTargets } from "../../corrections/types";
import type { DashboardData } from "../../read/dashboard";
import { mapSourceRow } from "../../read/sources";
import { AdminConsole } from "../AdminConsole";
import { FactorsPage, type FactorRow } from "../FactorsPage";
import { InferencesPage } from "../InferencesPage";
import { ItemCorrectionsPage } from "../ItemCorrectionsPage";

const NOW = "2026-10-15T12:00:00.000Z";
const DAY = "2026-10-01T00:00:00Z";
const src = (id: string, name: string, url: string, tier: number, over: Record<string, unknown> = {}) =>
  mapSourceRow({ id, name, url, description: `${name} publishes the instrument text.`, base_tier: tier, effective_tier: tier, status: "active", domains: [1], jurisdictions: ["EU"], transport_modes: ["road"], created_at: DAY, notes: "", ...over });

const DASHBOARD: DashboardData = {
  sources: { ok: true, data: [src("s1", "EUR-Lex", "https://eur-lex.europa.eu/", 1), src("s2", "A very long publisher name that must wrap at every width without pushing the page sideways", "https://example.test/long/path/that/keeps/going/and/going", 3, { tier_override: 5, override_reason: "operator knows this publisher" }), src("s3", "Industry newsletter", "https://news.example.test/", 6, { processing_paused: true })] },
  provisional: { ok: true, data: [{ id: "p1", name: "Candidate publisher", url: "https://candidate.example.test/", domain: 1, description: "Cited by two independent briefs.", discovered_via: "citation_detection", provisional_tier: 7, recommended_tier: 4, status: "pending_review", reviewer_notes: "", created_at: DAY, reviewed_at: null, citation_count: 4, independent_citers: 2, bias_tags: [] }] },
  orgs: { ok: true, data: [{ id: "o1", name: "Dietl / Rockit", slug: "dietl-rockit", plan: "pilot", created_at: DAY }, { id: "o2", name: "Second workspace", slug: "second", plan: null, created_at: DAY }] },
  members: { ok: true, data: { capped: false, rows: [{ id: "m1", org_id: "o1", user_id: "u1", role: "owner", created_at: DAY, user: { full_name: "Olga Owner", display_name: null, email: "olga@example.invalid", avatar_url: null } }, { id: "m2", org_id: "o1", user_id: "u2", role: "member", created_at: DAY, user: { full_name: null, display_name: "Mia", email: null, avatar_url: null } }] } },
  staged: { ok: true, data: { total: 1, rows: [{ id: "st1", update_type: "new_item", created_at: DAY, reason: "Auto-staged by the intake gate", proposed_changes: { title: "Regulation (EU) 2025/1" }, status: "pending" }] } },
  attention: { ok: true, data: { provisional_sources_pending: 1, staged_updates_pending: 1, staged_updates_materialization_failed: 0, integrity_flags_unresolved: 2, platform_integrity_flags_open: 3, source_attribution_mismatches: 0, auto_approved_awaiting_spotcheck: 1, coverage_gaps_critical: 0, ingest_rejections_untriaged: 4, total: 12 } },
  counts: { ok: true, data: { held: 5, factors: 40, disagreements: 2, harnessRuns: 9, errors: 1 } },
};
const TARGETS: ItemTargets = {
  item_id: "i1",
  title: "Regulation (EU) 2023/9999 establishing greenhouse gas emissions reduction duties for freight operators",
  full_brief: "Operators shall report annually.",
  tags: { topic_tags: ["emissions", "reporting"], operational_scenario_tags: ["road-freight"], compliance_object_tags: [] },
  facts: [{ id: "f1", claim_text: "Operators shall submit a verified report before 31 March.", source_span: "Article 2" }],
  sections: [{ section_key: "summary", content_md: "A short summary." }],
  connections: [{ other_item_id: "i2", other_title: "Implementing act on monitoring", relationship: "implements" }],
};
const FACTORS: FactorRow[] = [{ factor_id: "ef1", tier: "modal_default", mode: "road", vehicle_class: "hgv", energy_carrier: "diesel", jurisdiction: "EU", operator_key: null, corridor_id: null, quantity_basis: "tkm", wtt_co2e: 0.02, ttw_co2e: 0.07, wtw_co2e: 0.09, gwp_basis: "AR6", derivation: "published", origin_class: "inventory", pedigree: 2, as_at_date: "2025-01-01", superseded_by: null, source_key: "glec", data_sources: { name: "GLEC Framework", licence: "open", embeddable: true } }];

const matrix = () => buildCoverageMatrix([{ id: "c1", jurisdiction: "EU", surfaces: ["regulations"], relevance: "firm", identity: "verified", modes: ["road"] }, { id: "c2", jurisdiction: "US", surfaces: ["regulations"], relevance: "firm", identity: "unverified", modes: ["air"] }], { generatedAt: NOW, verifiedBriefs: 1 });

/** One admin screen per `?screen=`, with fixture props; the data each tab reads arrives from the smoke's mocked responses. */
export function AdminParts({ screen }: { screen: string }) {
  const m = matrix();
  return (
    <div data-fx="admin">
      {screen === "console" ? <AdminConsole userId="u1" userEmail="olga@example.invalid" nowIso={NOW} initial={DASHBOARD} /> : null}
      {screen === "item" ? <ItemCorrectionsPage targets={TARGETS} /> : null}
      {screen === "factors" ? <FactorsPage rows={FACTORS} error={null} nowIso={NOW} /> : null}
      {screen === "factors-failed" ? <FactorsPage rows={null} error="the database did not answer" nowIso={NOW} /> : null}
      {screen === "inferences" ? <InferencesPage data={{ rows: [{ inference_id: "n1", subject_id: null, claim_text: "Road operators in the EU are the most exposed.", status_token: "CONFIRMED", confidence: 0.8, cited_item_ids: ["i1"], trigger_question_ref: null, computed_at: DAY }], itemTitles: { i1: TARGETS.title } }} error={null} nowIso={NOW} /> : null}
      {screen === "coverage" ? <CoveragePage matrix={m} view={buildCoverageView(m, parseCoverageQuery({}))} query={parseCoverageQuery({})} error={null} nowIso={NOW} /> : null}
    </div>
  );
}
