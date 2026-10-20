// The populated backend of the admin UX smoke (G2b: "admin tabs are measured only in the 503/[] state"). `answer(pathname, search)` returns the JSON body a tab's read gets, shaped as the route
// answers it, with rows long enough to wrap (an unbreakable address, a long title) so the layout is measured with data in it; `undefined` means the smoke has no answer for that call, and the
// smoke then serves a stated failure. Every tab that reads is listed here, so a tab added without a populated mock is a tab the smoke measures only in its failure state, and the smoke says so.
const DAY = '2026-10-01T00:00:00Z';
const LONG_TITLE = 'Regulation (EU) 2023/9999 of the European Parliament and of the Council on greenhouse gas emissions reporting duties for freight operators in all modes';
const LONG_URL = 'https://publisher.example.test/legislation/a/very/long/path/with-an-unbreakable-segment-that-keeps-going-and-going-and-going/index.html?id=0123456789';

const briefFlags = {
  items: [
    { id: 'f1', legacyId: 'REG-12', title: LONG_TITLE, sourceUrl: LONG_URL, sourceName: 'EUR-Lex', sourceTier: 1, phrase: 'the source address does not resolve', flaggedAt: DAY },
    { id: 'f2', legacyId: null, title: null, sourceUrl: null, sourceName: null, sourceTier: null, phrase: null, flaggedAt: null },
  ],
  stats: { totalUnresolved: 2, totalFlagged: 9, shown: 2, capped: false },
};
const platformFlags = {
  items: [
    { id: 'pf1', category: 'data_quality', subject_type: 'item', subject_ref: 'i1-0123456789abcdef', description: `A figure in ${LONG_TITLE} is absent from its stored span.`, recommended_actions: [{ action: 'Re-ground the claim', rationale: 'the span does not contain the figure' }], status: 'open', created_at: DAY, created_by: 'mint_gate_s_numeric', resolved_at: null, resolution_note: null },
    { id: 'pf2', category: 'coverage_gap', subject_type: 'theme', subject_ref: 'th1', description: 'A theme with no brief.', recommended_actions: null, status: 'in_review', created_at: DAY, created_by: 'flywheel-gap:th1', resolved_at: null, resolution_note: null },
  ],
  counts: { byCategory: { design_drift: 0, data_quality: 1, source_issue: 0, coverage_gap: 1, data_integrity: 0, surface_concern: 0, workflow_gap: 0 }, byStatus: { open: 1, in_review: 1, resolved: 0, archived: 0 }, total: 2 },
  page: { offset: 0, limit: 25, hasMore: false },
};
const rejections = {
  items: [
    { id: 'r1', raw_value: 'Asia', rejection_reason: 'non_geographic', source_url: LONG_URL, ingest_attempted_at: DAY, source: { name: 'Publisher', url: LONG_URL } },
    { id: 'r2', raw_value: 'Frankfurt Airport Cargo City South Terminal', rejection_reason: 'below_granularity', source_url: null, ingest_attempted_at: DAY, source: null },
  ],
  total_untriaged: 2,
  list_capped: false,
};
const dispatchQueue = { open: [{ id: 'q1', reason: 'manual re-capture', requested_at: DAY, item: { title: LONG_TITLE } }, { id: 'q2', reason: 'sweep', requested_at: DAY, item: null }], open_count: 2, capped: false, last_consumed_at: DAY };
const corrections = {
  rows: [
    { id: 'c1', item_id: 'i1', target_kind: 'fact', target_ref: 'f1', op: 'suppress', value: null, machine_value: { claim_text: 'Operators shall report by 31 March.' }, reason: 'The span says 30 April.', created_by: '00000000-0000-4000-8000-000000000001', created_at: DAY, revoked_at: null, active: true, item_title: LONG_TITLE },
    { id: 'c2', item_id: 'i2', target_kind: 'tag', target_ref: 'topic_tags:emissions', op: 'add', value: { text: 'emissions' }, machine_value: null, reason: 'Missing tag.', created_by: null, created_at: DAY, revoked_at: DAY, revoked_reason: 'wrong', active: false, item_title: 'Implementing act' },
  ],
  unchecked: 1,
};
const jurisdictionReview = { items: [{ id: 'j1', current_value: 'EMEA', flagged_reason: 'region_bucket', source_column: 'jurisdictions', flagged_at: DAY, item: { id: 'i1', title: LONG_TITLE, jurisdictions: ['EMEA', 'EU', 'DE'], jurisdiction_iso: ['EU'] } }], total_unresolved: 1, list_capped: false };
const ITEM_TYPES = ['regulation', 'market_signal', 'research_finding', 'regional_data', 'technology'];
const coverage = {
  generated_at: '2026-10-15T00:00:00Z',
  matrix: [
    { jurisdiction_iso: 'EU', item_type: 'regulation', item_count: 12, source_count: 3, most_recent_item_at: DAY, has_critical: true, cell_state: 'covered-fresh' },
    { jurisdiction_iso: 'EU', item_type: 'market_signal', item_count: 1, source_count: 1, most_recent_item_at: DAY, has_critical: false, cell_state: 'sparse' },
    { jurisdiction_iso: 'US', item_type: 'regulation', item_count: 0, source_count: 0, most_recent_item_at: null, has_critical: false, cell_state: 'gap-no-source' },
    { jurisdiction_iso: 'US', item_type: 'research_finding', item_count: 4, source_count: 2, most_recent_item_at: '2024-01-01T00:00:00Z', has_critical: false, cell_state: 'covered-stale' },
  ],
  jurisdictions: [
    { jurisdiction_iso: 'EU', label: 'European Union', country: 'EU', tier: 1, total_items: 13, total_sources: 4, overall_state: 'covered' },
    { jurisdiction_iso: 'US', label: 'United States of America (federal)', country: 'US', tier: 1, total_items: 4, total_sources: 2, overall_state: 'partial' },
    { jurisdiction_iso: 'BR', label: 'Brazil', country: 'BR', tier: 2, total_items: 0, total_sources: 0, overall_state: 'gap' },
  ],
  item_types: ITEM_TYPES,
};
const catalogue = {
  entries: [
    { id: 'e1', url: LONG_URL, identifier: '32023R9999', displayTitle: LONG_TITLE, jurisdiction: 'EU', instrumentType: 'regulation', scheme: 'celex', surfaces: ['regulations'], relevance: 'firm', identity: 'verified' },
    { id: 'e2', url: 'https://example.test/a', identifier: null, displayTitle: 'Port charge schedule', jurisdiction: 'US', instrumentType: 'tariff', scheme: 'none', surfaces: ['market_intel', 'operations'], relevance: 'soft', identity: 'unresolved' },
  ],
};
const pipeline = {
  items: [
    { id: 'd1', legacy_id: 'REG-90', title: LONG_TITLE, summary: 'A summary long enough to need wrapping at the narrow widths of the page.', severity: 'HIGH', added_date: '2026-10-01', agent_integrity_flag: true, provenance_status: 'held_for_grounding', surface: 'regulations', source: { name: 'EUR-Lex' } },
    { id: 'd2', legacy_id: null, title: 'Shore power survey', summary: null, severity: null, added_date: null, agent_integrity_flag: false, provenance_status: null, surface: 'research', source: null },
  ],
  total: 2,
  capped: false,
};
const runtimeErrors = { groups: [{ id: 'g1', message: `TypeError: cannot read properties of undefined (reading 'items') at ${LONG_URL}`, count: 14, release: 'a1b2c3d4e5f6', side: 'client', route: '/regulations/[slug]', last_seen_at: DAY }, { id: 'g2', message: 'Failed to fetch', count: 2, release: 'dev', side: 'server', route: '/api/search', last_seen_at: DAY }] };
const assumptions = { rows: [{ assumption_key: 'tkm_default', subsystem: 'emissions', label: 'Default tonne-kilometre basis for an unspecified road leg', value_numeric: 0.062, unit: 'kgCO2e/tkm', governing_decision: 'ADR-031', code_location: 'src/core/emissions/defaults.ts:42', status: 'in_force', as_at_date: '2026-09-01' }, { assumption_key: 'orphan', subsystem: null, label: 'Unassigned', value_numeric: null, unit: null, governing_decision: null, code_location: 'src/x.ts:1', status: 'under_review', as_at_date: null }] };
const inferences = { rows: [{ inference_id: 'n1', subject_id: null, claim_text: 'Road operators in the EU are the most exposed to the 2027 reporting duty, given the share of fleets under 40 tonnes.', status_token: 'HYPOTHESIS', confidence: 0.6, cited_item_ids: ['i1'], trigger_question_ref: null, computed_at: DAY }], itemTitles: { i1: LONG_TITLE } };
const tierOpinions = { items: [{ source_id: 's2', source_name: 'A very long publisher name that must wrap at every width without pushing the page sideways', source_url: LONG_URL, base_tier: 3, effective_tier: 5, tier_override: 5, override_reason: 'operator knows this publisher', analyst_tier: 2, opined_tiers: [2, 2, 3], opinion_count: 3, delta: -1 }, { source_id: 's3', source_name: null, source_url: null, base_tier: 6, effective_tier: null, tier_override: null, override_reason: null, analyst_tier: null, opined_tiers: [], opinion_count: 0, delta: null }] };
const pauseGlobal = { paused: false, cadence: 'off', start_date: null, next_scrape: null };
const b2 = { total_eligible: 1320, at_current: 1100, never_regenerated: 40 };
const canonical = {
  groups: [{ item_id: 'i1', item: { title: LONG_TITLE }, issue_classification: 'stale_url', candidates: [{ id: 'k1', candidate_url: LONG_URL, candidate_title: LONG_TITLE, candidate_publisher: 'Publisher', rationale: 'The address moved when the site was rebuilt.', confidence: 'high', verified: true, existing_source_id: null, classification: { tier: 1, domains: [1], jurisdictions: ['EU'], transport_modes: ['road'], topic_tags: ['emissions'] } }] }],
  stats: { total: 1, items: 1, by_confidence: { high: 1 }, by_issue: { stale_url: 1 }, high_conf_verified: 1, high_conf_unverified: 0 },
  page: { hasMore: false },
};
const intersections = { intersections: [{ item_a_id: 'a1', item_a_title: LONG_TITLE, item_a_legacy_id: 'REG-1', item_a_intersection_summary: 'Both set a reporting duty.', item_b_id: 'b1', item_b_title: 'Implementing act on monitoring', item_b_legacy_id: null, item_b_intersection_summary: null, basis: [{ signal: 'shared_source', detail: 'EUR-Lex', weight: 0.5 }, { signal: 'shared_jurisdiction_topic' }], explicitly_linked: true, score: 0.82, band: 'strong' }], stats: { total: 1, explicit_count: 1, by_band: { strong: 1 } } };
const themes = { themes: [{ id: 't1', member_ids: ['0123456789abcdef', 'fedcba9876543210'], surfaces: ['regulations', 'market'], convergence: 0.7, band: 'high', density: 0.4, dominant_signals: [{ signal: 'shared_source', weight: 0.6 }], brief: { title: 'Reporting duties converge on one date', brief_md: 'Two instruments set the same filing window.', generated_at: DAY, stale: true } }], stats: { total: 1, avg_convergence: 0.7, cross_surface_count: 1, single_surface_count: 0 }, last_run: { started_at: DAY, finished_at: DAY, status: 'ok', themes_written: 1, gaps_flagged: 0 } };
const forwardEvents = { events: [{ id: 'fe1', event_date: '2027-03-31', date_precision: 'day', event_kind: 'compliance_deadline', obligation_text: 'Operators submit the verified report. '.repeat(4), source_kind: 'brief', confidence: 'high', item: { title: LONG_TITLE, jurisdiction_iso: ['EU'] } }], stats: { total: 1, by_kind: { compliance_deadline: 1 }, by_precision: { day: 1 } } };

/** The populated answer for an admin call, or undefined when the smoke has none. */
export function answer(pathname, search = '') {
  if (pathname === '/api/admin/integrity-flags') return search.includes('platform=1') ? platformFlags : briefFlags;
  if (pathname === '/api/admin/triage/ingest-rejections') return rejections;
  if (pathname === '/api/admin/corpus-turn-requests') return dispatchQueue;
  if (pathname === '/api/admin/corrections') return corrections;
  if (pathname === '/api/admin/triage/pending-jurisdiction-review') return jurisdictionReview;
  if (pathname === '/api/admin/coverage') return coverage;
  if (pathname === '/api/coverage/entries') return catalogue;
  if (pathname === '/api/admin/pipeline/drafts') return pipeline;
  if (pathname === '/api/admin/runtime') return search.includes('assumptions') ? assumptions : search.includes('inferences') ? inferences : runtimeErrors;
  if (pathname === '/api/admin/sources/tier-opinions') return tierOpinions;
  if (pathname === '/api/admin/sources/pause-global') return pauseGlobal;
  if (pathname === '/api/admin/b2-progress') return b2;
  if (pathname === '/api/admin/canonical-sources/pending') return canonical;
  if (pathname === '/api/admin/intersections') return intersections;
  if (pathname === '/api/admin/themes') return themes;
  if (pathname === '/api/admin/forward-events') return forwardEvents;
  return undefined;
}

/** Every path `answer` serves: the smoke reads this to assert that each is asked at least once in the populated pass (a mock nothing asks for is a tab the smoke never reached). */
export const SERVED = ['/api/admin/integrity-flags', '/api/admin/triage/ingest-rejections', '/api/admin/corpus-turn-requests', '/api/admin/corrections', '/api/admin/triage/pending-jurisdiction-review', '/api/admin/coverage', '/api/coverage/entries', '/api/admin/pipeline/drafts', '/api/admin/runtime', '/api/admin/sources/tier-opinions', '/api/admin/sources/pause-global', '/api/admin/b2-progress', '/api/admin/canonical-sources/pending', '/api/admin/intersections', '/api/admin/themes', '/api/admin/forward-events'];
