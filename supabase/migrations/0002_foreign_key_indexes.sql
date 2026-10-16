-- 0002 foreign-key indexes (P2-S1, owed by register P1-11 schema.md section 8 "Added": one index per unindexed foreign key,
-- 82 at the baseline; the property check fk-indexed was waived at 82 until this file).
--
-- One non-partial btree per foreign key over the key's columns in constraint order, so the leading column is indexed.
-- A parent delete or update no longer scans the child table. Plain CREATE INDEX (a transaction block cannot hold
-- CONCURRENTLY); at the cutover window the tables are not under write load. Not applied to production before cutover.
--
-- Reversal: DROP INDEX for each name below.

-- catalog: index

BEGIN;

CREATE INDEX IF NOT EXISTS admin_action_cooldowns_triggered_by_idx ON public.admin_action_cooldowns (triggered_by);
CREATE INDEX IF NOT EXISTS agent_runs_intelligence_item_id_idx ON public.agent_runs (intelligence_item_id);
CREATE INDEX IF NOT EXISTS agent_runs_intelligence_item_version_id_idx ON public.agent_runs (intelligence_item_version_id);
CREATE INDEX IF NOT EXISTS agent_runs_raw_fetch_id_idx ON public.agent_runs (raw_fetch_id);
CREATE INDEX IF NOT EXISTS assumption_register_source_key_idx ON public.assumption_register (source_key);
CREATE INDEX IF NOT EXISTS assumption_register_superseded_by_idx ON public.assumption_register (superseded_by);
CREATE INDEX IF NOT EXISTS auxiliary_energy_profiles_node_id_idx ON public.auxiliary_energy_profiles (node_id);
CREATE INDEX IF NOT EXISTS canonical_source_candidates_current_source_id_idx ON public.canonical_source_candidates (current_source_id);
CREATE INDEX IF NOT EXISTS canonical_source_candidates_promoted_to_source_id_idx ON public.canonical_source_candidates (promoted_to_source_id);
CREATE INDEX IF NOT EXISTS census_worklist_resolved_into_id_idx ON public.census_worklist (resolved_into_id);
CREATE INDEX IF NOT EXISTS community_group_invitations_invitee_user_id_idx ON public.community_group_invitations (invitee_user_id);
CREATE INDEX IF NOT EXISTS community_group_invitations_inviter_user_id_idx ON public.community_group_invitations (inviter_user_id);
CREATE INDEX IF NOT EXISTS community_post_signoff_requests_requested_by_idx ON public.community_post_signoff_requests (requested_by);
CREATE INDEX IF NOT EXISTS community_post_signoff_requests_verifier_id_idx ON public.community_post_signoff_requests (verifier_id);
CREATE INDEX IF NOT EXISTS community_posts_promoted_from_post_id_idx ON public.community_posts (promoted_from_post_id);
CREATE INDEX IF NOT EXISTS community_posts_signed_off_by_idx ON public.community_posts (signed_off_by);
CREATE INDEX IF NOT EXISTS corpus_turn_requests_intelligence_item_id_idx ON public.corpus_turn_requests (intelligence_item_id);
CREATE INDEX IF NOT EXISTS derived_values_entity_id_idx ON public.derived_values (entity_id);
CREATE INDEX IF NOT EXISTS derived_values_invalidated_by_event_idx ON public.derived_values (invalidated_by_event);
CREATE INDEX IF NOT EXISTS derived_values_supersedes_fk_idx ON public.derived_values (supersedes);
CREATE INDEX IF NOT EXISTS emission_factors_superseded_by_idx ON public.emission_factors (superseded_by);
CREATE INDEX IF NOT EXISTS entities_merged_into_fk_idx ON public.entities (merged_into);
CREATE INDEX IF NOT EXISTS entity_aliases_source_id_idx ON public.entity_aliases (source_id);
CREATE INDEX IF NOT EXISTS entity_relations_source_id_idx ON public.entity_relations (source_id);
CREATE INDEX IF NOT EXISTS grid_connection_queues_source_id_idx ON public.grid_connection_queues (source_id);
CREATE INDEX IF NOT EXISTS holdings_quality_capture_ref_idx ON public.holdings_quality (capture_ref);
CREATE INDEX IF NOT EXISTS holdings_quality_source_id_idx ON public.holdings_quality (source_id);
CREATE INDEX IF NOT EXISTS indexation_clauses_corridor_id_idx ON public.indexation_clauses (corridor_id);
CREATE INDEX IF NOT EXISTS inference_records_invalidated_by_event_idx ON public.inference_records (invalidated_by_event);
CREATE INDEX IF NOT EXISTS inference_records_subject_id_idx ON public.inference_records (subject_id);
CREATE INDEX IF NOT EXISTS inference_records_supersedes_fk_idx ON public.inference_records (supersedes);
CREATE INDEX IF NOT EXISTS ingest_rejections_source_id_idx ON public.ingest_rejections (source_id);
CREATE INDEX IF NOT EXISTS ingest_rejections_triaged_by_idx ON public.ingest_rejections (triaged_by);
CREATE INDEX IF NOT EXISTS intelligence_item_versions_previous_version_id_idx ON public.intelligence_item_versions (previous_version_id);
CREATE INDEX IF NOT EXISTS intelligence_items_instrument_entity_id_idx ON public.intelligence_items (instrument_entity_id);
CREATE INDEX IF NOT EXISTS item_forward_events_source_claim_id_idx ON public.item_forward_events (source_claim_id);
CREATE INDEX IF NOT EXISTS item_forward_events_source_section_id_idx ON public.item_forward_events (source_section_id);
CREATE INDEX IF NOT EXISTS item_notes_org_id_idx ON public.item_notes (org_id);
CREATE INDEX IF NOT EXISTS item_workspace_tags_created_by_idx ON public.item_workspace_tags (created_by);
CREATE INDEX IF NOT EXISTS item_workspace_tags_intelligence_item_id_idx ON public.item_workspace_tags (intelligence_item_id);
CREATE INDEX IF NOT EXISTS market_series_entity_id_idx ON public.market_series (entity_id);
CREATE INDEX IF NOT EXISTS market_series_source_key_idx ON public.market_series (source_key);
CREATE INDEX IF NOT EXISTS moderation_reports_resolved_by_user_id_idx ON public.moderation_reports (resolved_by_user_id);
CREATE INDEX IF NOT EXISTS monitoring_queue_item_id_idx ON public.monitoring_queue (item_id);
CREATE INDEX IF NOT EXISTS obligation_objects_instrument_entity_id_idx ON public.obligation_objects (instrument_entity_id);
CREATE INDEX IF NOT EXISTS obligation_objects_source_id_idx ON public.obligation_objects (source_id);
CREATE INDEX IF NOT EXISTS obligation_objects_supersedes_idx ON public.obligation_objects (supersedes);
CREATE INDEX IF NOT EXISTS obligations_obligation_id_idx ON public.obligations (obligation_id);
CREATE INDEX IF NOT EXISTS oem_tech_roadmaps_source_id_idx ON public.oem_tech_roadmaps (source_id);
CREATE INDEX IF NOT EXISTS org_invitations_accepted_by_user_id_idx ON public.org_invitations (accepted_by_user_id);
CREATE INDEX IF NOT EXISTS org_invitations_invited_by_user_id_idx ON public.org_invitations (invited_by_user_id);
CREATE INDEX IF NOT EXISTS org_invitations_revoked_by_user_id_idx ON public.org_invitations (revoked_by_user_id);
CREATE INDEX IF NOT EXISTS org_member_bans_banned_by_idx ON public.org_member_bans (banned_by);
CREATE INDEX IF NOT EXISTS pending_first_fetch_source_id_idx ON public.pending_first_fetch (source_id);
CREATE INDEX IF NOT EXISTS pending_jurisdiction_review_resolved_by_idx ON public.pending_jurisdiction_review (resolved_by);
CREATE INDEX IF NOT EXISTS portal_link_candidates_item_id_idx ON public.portal_link_candidates (item_id);
CREATE INDEX IF NOT EXISTS portfolio_members_added_by_idx ON public.portfolio_members (added_by);
CREATE INDEX IF NOT EXISTS portfolio_members_entity_id_idx ON public.portfolio_members (entity_id);
CREATE INDEX IF NOT EXISTS portfolio_members_item_id_idx ON public.portfolio_members (item_id);
CREATE INDEX IF NOT EXISTS portfolio_members_portfolio_id_org_id_idx ON public.portfolio_members (portfolio_id, org_id);
CREATE INDEX IF NOT EXISTS portfolios_created_by_idx ON public.portfolios (created_by);
CREATE INDEX IF NOT EXISTS profiles_org_id_idx ON public.profiles (org_id);
CREATE INDEX IF NOT EXISTS propagation_events_entity_id_idx ON public.propagation_events (entity_id);
CREATE INDEX IF NOT EXISTS provisional_sources_promoted_to_source_id_idx ON public.provisional_sources (promoted_to_source_id);
CREATE INDEX IF NOT EXISTS regional_data_facts_source_id_idx ON public.regional_data_facts (source_id);
CREATE INDEX IF NOT EXISTS regional_data_facts_source_key_idx ON public.regional_data_facts (source_key);
CREATE INDEX IF NOT EXISTS research_assessments_entity_id_fk_idx ON public.research_assessments (entity_id);
CREATE INDEX IF NOT EXISTS section_claim_provenance_basis_claim_id_idx ON public.section_claim_provenance (basis_claim_id);
CREATE INDEX IF NOT EXISTS section_claim_provenance_search_result_id_idx ON public.section_claim_provenance (search_result_id);
CREATE INDEX IF NOT EXISTS signposts_inference_record_id_idx ON public.signposts (inference_record_id);
CREATE INDEX IF NOT EXISTS source_reliability_ledger_assessment_id_idx ON public.source_reliability_ledger (assessment_id);
CREATE INDEX IF NOT EXISTS source_reliability_ledger_signpost_entity_id_idx ON public.source_reliability_ledger (signpost_entity_id);
CREATE INDEX IF NOT EXISTS source_tier_opinions_dismissed_by_idx ON public.source_tier_opinions (dismissed_by);
CREATE INDEX IF NOT EXISTS source_tier_opinions_intelligence_item_id_idx ON public.source_tier_opinions (intelligence_item_id);
CREATE INDEX IF NOT EXISTS source_tier_opinions_opining_source_id_idx ON public.source_tier_opinions (opining_source_id);
CREATE INDEX IF NOT EXISTS source_verifications_resulting_provisional_id_idx ON public.source_verifications (resulting_provisional_id);
CREATE INDEX IF NOT EXISTS source_verifications_resulting_source_id_idx ON public.source_verifications (resulting_source_id);
CREATE INDEX IF NOT EXISTS sources_organisation_entity_id_idx ON public.sources (organisation_entity_id);
CREATE INDEX IF NOT EXISTS staged_updates_materialized_item_id_idx ON public.staged_updates (materialized_item_id);
CREATE INDEX IF NOT EXISTS state_cost_facts_source_id_idx ON public.state_cost_facts (source_id);
CREATE INDEX IF NOT EXISTS vocabulary_mentions_source_id_idx ON public.vocabulary_mentions (source_id);
CREATE INDEX IF NOT EXISTS workspace_tags_created_by_idx ON public.workspace_tags (created_by);

-- Self-check 0002-fk-indexes: the 82 baseline offenders are gone, and every one was created by this file.
DO $$
DECLARE n_left int; n_made int;
BEGIN
  SELECT count(*) INTO n_left FROM pg_constraint c
   WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND NOT EXISTS (
     SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1] AND i.indpred IS NULL);
  IF n_left <> 0 THEN RAISE EXCEPTION '0002-fk-indexes: % foreign keys still unindexed', n_left; END IF;
  SELECT count(*) INTO n_made FROM pg_indexes WHERE schemaname = 'public'
     AND indexname IN (
      'admin_action_cooldowns_triggered_by_idx',
      'agent_runs_intelligence_item_id_idx',
      'agent_runs_intelligence_item_version_id_idx',
      'agent_runs_raw_fetch_id_idx',
      'assumption_register_source_key_idx',
      'assumption_register_superseded_by_idx',
      'auxiliary_energy_profiles_node_id_idx',
      'canonical_source_candidates_current_source_id_idx',
      'canonical_source_candidates_promoted_to_source_id_idx',
      'census_worklist_resolved_into_id_idx',
      'community_group_invitations_invitee_user_id_idx',
      'community_group_invitations_inviter_user_id_idx',
      'community_post_signoff_requests_requested_by_idx',
      'community_post_signoff_requests_verifier_id_idx',
      'community_posts_promoted_from_post_id_idx',
      'community_posts_signed_off_by_idx',
      'corpus_turn_requests_intelligence_item_id_idx',
      'derived_values_entity_id_idx',
      'derived_values_invalidated_by_event_idx',
      'derived_values_supersedes_fk_idx',
      'emission_factors_superseded_by_idx',
      'entities_merged_into_fk_idx',
      'entity_aliases_source_id_idx',
      'entity_relations_source_id_idx',
      'grid_connection_queues_source_id_idx',
      'holdings_quality_capture_ref_idx',
      'holdings_quality_source_id_idx',
      'indexation_clauses_corridor_id_idx',
      'inference_records_invalidated_by_event_idx',
      'inference_records_subject_id_idx',
      'inference_records_supersedes_fk_idx',
      'ingest_rejections_source_id_idx',
      'ingest_rejections_triaged_by_idx',
      'intelligence_item_versions_previous_version_id_idx',
      'intelligence_items_instrument_entity_id_idx',
      'item_forward_events_source_claim_id_idx',
      'item_forward_events_source_section_id_idx',
      'item_notes_org_id_idx',
      'item_workspace_tags_created_by_idx',
      'item_workspace_tags_intelligence_item_id_idx',
      'market_series_entity_id_idx',
      'market_series_source_key_idx',
      'moderation_reports_resolved_by_user_id_idx',
      'monitoring_queue_item_id_idx',
      'obligation_objects_instrument_entity_id_idx',
      'obligation_objects_source_id_idx',
      'obligation_objects_supersedes_idx',
      'obligations_obligation_id_idx',
      'oem_tech_roadmaps_source_id_idx',
      'org_invitations_accepted_by_user_id_idx',
      'org_invitations_invited_by_user_id_idx',
      'org_invitations_revoked_by_user_id_idx',
      'org_member_bans_banned_by_idx',
      'pending_first_fetch_source_id_idx',
      'pending_jurisdiction_review_resolved_by_idx',
      'portal_link_candidates_item_id_idx',
      'portfolio_members_added_by_idx',
      'portfolio_members_entity_id_idx',
      'portfolio_members_item_id_idx',
      'portfolio_members_portfolio_id_org_id_idx',
      'portfolios_created_by_idx',
      'profiles_org_id_idx',
      'propagation_events_entity_id_idx',
      'provisional_sources_promoted_to_source_id_idx',
      'regional_data_facts_source_id_idx',
      'regional_data_facts_source_key_idx',
      'research_assessments_entity_id_fk_idx',
      'section_claim_provenance_basis_claim_id_idx',
      'section_claim_provenance_search_result_id_idx',
      'signposts_inference_record_id_idx',
      'source_reliability_ledger_assessment_id_idx',
      'source_reliability_ledger_signpost_entity_id_idx',
      'source_tier_opinions_dismissed_by_idx',
      'source_tier_opinions_intelligence_item_id_idx',
      'source_tier_opinions_opining_source_id_idx',
      'source_verifications_resulting_provisional_id_idx',
      'source_verifications_resulting_source_id_idx',
      'sources_organisation_entity_id_idx',
      'staged_updates_materialized_item_id_idx',
      'state_cost_facts_source_id_idx',
      'vocabulary_mentions_source_id_idx',
      'workspace_tags_created_by_idx'
     );
  IF n_made <> 82 THEN RAISE EXCEPTION '0002-fk-indexes: expected 82 indexes from this file, found %', n_made; END IF;
  RAISE NOTICE '0002-fk-indexes OK';
END $$;

COMMIT;
