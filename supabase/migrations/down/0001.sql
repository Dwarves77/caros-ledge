-- Down for 0001_grants_and_default_privileges: the relation and function privileges, the roles-{public} policies and the default privileges return to what they were before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP POLICY IF EXISTS "auxiliary_energy_profiles_org_read" ON public.auxiliary_energy_profiles;
CREATE POLICY "auxiliary_energy_profiles_org_read" ON public.auxiliary_energy_profiles AS PERMISSIVE FOR SELECT TO public USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));
DROP POLICY IF EXISTS "bulk_imports_read_authenticated" ON public.bulk_imports;
CREATE POLICY "bulk_imports_read_authenticated" ON public.bulk_imports AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.role() AS role) = 'authenticated'::text));
DROP POLICY IF EXISTS "canonical_source_candidates_admin_read" ON public.canonical_source_candidates;
CREATE POLICY "canonical_source_candidates_admin_read" ON public.canonical_source_candidates AS PERMISSIVE FOR SELECT TO public USING (( SELECT public.is_platform_admin() AS is_platform_admin));
DROP POLICY IF EXISTS "community_group_invitations_select" ON public.community_group_invitations;
CREATE POLICY "community_group_invitations_select" ON public.community_group_invitations AS PERMISSIVE FOR SELECT TO public USING (((invitee_user_id = ( SELECT auth.uid() AS uid)) OR (inviter_user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1 FROM public.community_group_members m WHERE ((m.group_id = community_group_invitations.group_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))) OR (EXISTS ( SELECT 1 FROM public.community_groups g WHERE ((g.id = community_group_invitations.group_id) AND (g.owner_user_id = ( SELECT auth.uid() AS uid)))))));
DROP POLICY IF EXISTS "community_member_profiles_select_authenticated" ON public.community_member_profiles;
CREATE POLICY "community_member_profiles_select_authenticated" ON public.community_member_profiles AS PERMISSIVE FOR SELECT TO public USING ((auth.role() = 'authenticated'::text));
DROP POLICY IF EXISTS "signoff_select" ON public.community_post_signoff_requests;
CREATE POLICY "signoff_select" ON public.community_post_signoff_requests AS PERMISSIVE FOR SELECT TO public USING (((requested_by = auth.uid()) OR (EXISTS ( SELECT 1 FROM public.profiles p WHERE ((p.id = auth.uid()) AND (p.verifier_status = 'active'::text)))) OR ( SELECT public.is_platform_admin() AS is_platform_admin)));
DROP POLICY IF EXISTS "community_topic_groups_select_owner" ON public.community_topic_groups;
CREATE POLICY "community_topic_groups_select_owner" ON public.community_topic_groups AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1 FROM public.community_topics t WHERE ((t.id = community_topic_groups.topic_id) AND (t.owner_user_id = ( SELECT auth.uid() AS uid))))));
DROP POLICY IF EXISTS "community_topics_select_owner" ON public.community_topics;
CREATE POLICY "community_topics_select_owner" ON public.community_topics AS PERMISSIVE FOR SELECT TO public USING ((owner_user_id = ( SELECT auth.uid() AS uid)));
DROP POLICY IF EXISTS "holdings_quality_admin_read" ON public.holdings_quality;
CREATE POLICY "holdings_quality_admin_read" ON public.holdings_quality AS PERMISSIVE FOR SELECT TO public USING (( SELECT public.is_platform_admin() AS is_platform_admin));
DROP POLICY IF EXISTS "indexation_clauses_org_read" ON public.indexation_clauses;
CREATE POLICY "indexation_clauses_org_read" ON public.indexation_clauses AS PERMISSIVE FOR SELECT TO public USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));
DROP POLICY IF EXISTS "ingest_rejections_read_platform_admin" ON public.ingest_rejections;
CREATE POLICY "ingest_rejections_read_platform_admin" ON public.ingest_rejections AS PERMISSIVE FOR SELECT TO public USING (( SELECT public.is_platform_admin() AS is_platform_admin));
DROP POLICY IF EXISTS "integrity_flags_admin_read" ON public.integrity_flags;
CREATE POLICY "integrity_flags_admin_read" ON public.integrity_flags AS PERMISSIVE FOR SELECT TO public USING (( SELECT public.is_platform_admin() AS is_platform_admin));
DROP POLICY IF EXISTS "changes_read_authenticated" ON public.intelligence_changes;
CREATE POLICY "changes_read_authenticated" ON public.intelligence_changes AS PERMISSIVE FOR SELECT TO public USING (((( SELECT auth.role() AS role) = 'authenticated'::text) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
DROP POLICY IF EXISTS "summaries_read_authenticated" ON public.intelligence_summaries;
CREATE POLICY "summaries_read_authenticated" ON public.intelligence_summaries AS PERMISSIVE FOR SELECT TO public USING (((( SELECT auth.role() AS role) = 'authenticated'::text) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
DROP POLICY IF EXISTS "item_assignments_read_org" ON public.item_assignments;
CREATE POLICY "item_assignments_read_org" ON public.item_assignments AS PERMISSIVE FOR SELECT TO public USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));
DROP POLICY IF EXISTS "item_notes_read_org" ON public.item_notes;
CREATE POLICY "item_notes_read_org" ON public.item_notes AS PERMISSIVE FOR SELECT TO public USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));
DROP POLICY IF EXISTS "item_workspace_tags_org_read" ON public.item_workspace_tags;
CREATE POLICY "item_workspace_tags_org_read" ON public.item_workspace_tags AS PERMISSIVE FOR SELECT TO public USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));
DROP POLICY IF EXISTS "moderation_reports_select" ON public.moderation_reports;
CREATE POLICY "moderation_reports_select" ON public.moderation_reports AS PERMISSIVE FOR SELECT TO public USING (((reporter_user_id = auth.uid()) OR ((target_kind = 'post'::text) AND (EXISTS ( SELECT 1 FROM (public.community_posts p JOIN public.community_group_members m ON ((m.group_id = p.group_id))) WHERE ((p.id = moderation_reports.target_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))) OR ((target_kind = 'group'::text) AND (EXISTS ( SELECT 1 FROM public.community_group_members m WHERE ((m.group_id = moderation_reports.target_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))) OR ( SELECT public.is_platform_admin() AS is_platform_admin)));
DROP POLICY IF EXISTS "notification_preferences_select_self" ON public.notification_preferences;
CREATE POLICY "notification_preferences_select_self" ON public.notification_preferences AS PERMISSIVE FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
DROP POLICY IF EXISTS "notifications_select_self" ON public.notifications;
CREATE POLICY "notifications_select_self" ON public.notifications AS PERMISSIVE FOR SELECT TO public USING ((user_id = ( SELECT auth.uid() AS uid)));
DROP POLICY IF EXISTS "org_invitations_admin_read" ON public.org_invitations;
CREATE POLICY "org_invitations_admin_read" ON public.org_invitations AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1 FROM public.org_memberships m WHERE ((m.org_id = org_invitations.org_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));
DROP POLICY IF EXISTS "org_member_bans_select_owner_admin" ON public.org_member_bans;
CREATE POLICY "org_member_bans_select_owner_admin" ON public.org_member_bans AS PERMISSIVE FOR SELECT TO public USING ((EXISTS ( SELECT 1 FROM public.org_memberships m WHERE ((m.org_id = org_member_bans.org_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));
DROP POLICY IF EXISTS "membership_read" ON public.org_memberships;
CREATE POLICY "membership_read" ON public.org_memberships AS PERMISSIVE FOR SELECT TO public USING ((public.user_belongs_to_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
DROP POLICY IF EXISTS "org_watchlist_member_read" ON public.org_watchlist;
CREATE POLICY "org_watchlist_member_read" ON public.org_watchlist AS PERMISSIVE FOR SELECT TO public USING ((public.user_belongs_to_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
DROP POLICY IF EXISTS "org_read_members" ON public.organizations;
CREATE POLICY "org_read_members" ON public.organizations AS PERMISSIVE FOR SELECT TO public USING ((public.user_belongs_to_org(id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
DROP POLICY IF EXISTS "pjr_read_platform_admin" ON public.pending_jurisdiction_review;
CREATE POLICY "pjr_read_platform_admin" ON public.pending_jurisdiction_review AS PERMISSIVE FOR SELECT TO public USING (( SELECT public.is_platform_admin() AS is_platform_admin));
DROP POLICY IF EXISTS "portfolio_members_org_read" ON public.portfolio_members;
CREATE POLICY "portfolio_members_org_read" ON public.portfolio_members AS PERMISSIVE FOR SELECT TO public USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));
DROP POLICY IF EXISTS "portfolios_org_read" ON public.portfolios;
CREATE POLICY "portfolios_org_read" ON public.portfolios AS PERMISSIVE FOR SELECT TO public USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));
DROP POLICY IF EXISTS "provisional_sources_admin_read" ON public.provisional_sources;
CREATE POLICY "provisional_sources_admin_read" ON public.provisional_sources AS PERMISSIVE FOR SELECT TO public USING (((auth.role() = 'service_role'::text) OR ( SELECT public.is_platform_admin() AS is_platform_admin)));
DROP POLICY IF EXISTS "sector_contexts_read_authenticated" ON public.sector_contexts;
CREATE POLICY "sector_contexts_read_authenticated" ON public.sector_contexts AS PERMISSIVE FOR SELECT TO public USING (((( SELECT auth.role() AS role) = 'authenticated'::text) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
DROP POLICY IF EXISTS "source_tier_opinions_select_platform_admin" ON public.source_tier_opinions;
CREATE POLICY "source_tier_opinions_select_platform_admin" ON public.source_tier_opinions AS PERMISSIVE FOR SELECT TO public USING (( SELECT public.is_platform_admin() AS is_platform_admin));
DROP POLICY IF EXISTS "user_item_state_select" ON public.user_item_state;
CREATE POLICY "user_item_state_select" ON public.user_item_state AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
DROP POLICY IF EXISTS "user_watchlist_select" ON public.user_watchlist;
CREATE POLICY "user_watchlist_select" ON public.user_watchlist AS PERMISSIVE FOR SELECT TO public USING ((( SELECT auth.uid() AS uid) = user_id));
DROP POLICY IF EXISTS "vocabulary_mentions_admin_read" ON public.vocabulary_mentions;
CREATE POLICY "vocabulary_mentions_admin_read" ON public.vocabulary_mentions AS PERMISSIVE FOR SELECT TO public USING (( SELECT public.is_platform_admin() AS is_platform_admin));
DROP POLICY IF EXISTS "vocabulary_terms_admin_read" ON public.vocabulary_terms;
CREATE POLICY "vocabulary_terms_admin_read" ON public.vocabulary_terms AS PERMISSIVE FOR SELECT TO public USING (( SELECT public.is_platform_admin() AS is_platform_admin));
DROP POLICY IF EXISTS "overrides_read_org" ON public.workspace_item_overrides;
CREATE POLICY "overrides_read_org" ON public.workspace_item_overrides AS PERMISSIVE FOR SELECT TO public USING ((public.user_belongs_to_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
DROP POLICY IF EXISTS "settings_read_org" ON public.workspace_settings;
CREATE POLICY "settings_read_org" ON public.workspace_settings AS PERMISSIVE FOR SELECT TO public USING ((public.user_belongs_to_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
DROP POLICY IF EXISTS "workspace_tags_org_read" ON public.workspace_tags;
CREATE POLICY "workspace_tags_org_read" ON public.workspace_tags AS PERMISSIVE FOR SELECT TO public USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));
-- tables: the privileges before the migration
DO $$
DECLARE r record; e record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('admin_action_cooldowns', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('agent_run_searches', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres,reconciler=r/postgres}'),
    ('agent_runs', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('assumption_register', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('auxiliary_energy_profiles', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('brief_apply_runs', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('bulk_imports', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('canonical_source_candidates', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('census_rollup_by_surface', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxt/postgres}'),
    ('census_worklist', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('claim_versions', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('community_group_invitations', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('community_group_members', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('community_groups', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('community_member_profiles', '{postgres=arwdDxt/postgres,authenticated=d/postgres,service_role=arwdDxt/postgres}'),
    ('community_post_signoff_requests', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('community_posts', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=rd/postgres,service_role=arwdDxt/postgres}'),
    ('community_thread_entities', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('community_topic_groups', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('community_topics', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('corpus_census', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('corpus_turn_requests', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('coverage_gap_candidates', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('coverage_gap_census_findings', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('data_sources', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('derived_values', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('derived_values_admissible', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxt/postgres}'),
    ('disposition_ledger', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('emission_factor_candidates', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxt/postgres}'),
    ('emission_factors', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('error_events', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('estimated_values', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('funded_pass_runlock', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('gate_a_health_cache', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('grid_connection_queues', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('holdings_quality', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('indexation_clauses', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('inference_records', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('ingest_rejections', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('institutions', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('integrity_flags', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres,reconciler=ar/postgres}'),
    ('intelligence_changes', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('intelligence_item_citations', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('intelligence_item_sections', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres,reconciler=r/postgres}'),
    ('intelligence_item_versions', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=ar/postgres,service_role=arwdDxt/postgres}'),
    ('intelligence_items', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres,reconciler=r/postgres}'),
    ('intelligence_summaries', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('item_changelog', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('item_correction_evidence', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxt/postgres}'),
    ('item_corrections', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxt/postgres}'),
    ('item_cross_references', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('item_disputes', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('item_forward_events', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('item_gate_a_state', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('item_supersessions', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('item_timelines', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('item_type_required_slots', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres,reconciler=r/postgres}'),
    ('item_workspace_tags', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('licence_clear_sources', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxt/postgres}'),
    ('market_series', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('moderation_reports', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('mutation_leases', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('notification_preferences', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('notifications', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=ard/postgres,service_role=arwdDxt/postgres}'),
    ('obligations', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('oem_tech_roadmaps', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('org_invitations', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('org_member_bans', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('org_watchlist', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('pending_jurisdiction_review', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('portal_link_candidates', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('propagation_events', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('propagation_queue_depth', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=r/postgres,service_role=arwdDxt/postgres}'),
    ('provisional_sources', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('published_price_statistics', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('raw_fetches', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('reroute_events', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('research_assessments', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('section_claim_provenance', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres,reconciler=r/postgres}'),
    ('sector_contexts', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('source_bias_tags', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('source_reliability_ledger', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('source_tier_opinions', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('staged_updates', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('statutory_computations', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('system_state', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('system_state_flag_audit', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('user_item_state', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('user_watchlist', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('vocabulary_mentions', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('vocabulary_terms', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('workspace_item_overrides', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}'),
    ('workspace_tags', '{postgres=arwdDxt/postgres,anon=r/postgres,authenticated=arwd/postgres,service_role=arwdDxt/postgres}')) AS v(name, acl) LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', r.name);
    FOR e IN SELECT a.grantee, a.privilege_type FROM aclexplode(NULLIF(r.acl, '')::aclitem[]) a WHERE a.grantee <> a.grantor LOOP
      EXECUTE format('GRANT %s ON TABLE public.%I TO %s', e.privilege_type, r.name, CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(e.grantee)) END);
    END LOOP;
  END LOOP;
END $$;
-- sequences: the privileges before the migration
DO $$
DECLARE r record; e record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('propagation_events_event_id_seq', '{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}'),
    ('source_reliability_ledger_id_seq', '{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}'),
    ('system_state_flag_audit_id_seq', '{postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}')) AS v(name, acl) LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM PUBLIC, anon, authenticated, service_role', r.name);
    FOR e IN SELECT a.grantee, a.privilege_type FROM aclexplode(NULLIF(r.acl, '')::aclitem[]) a WHERE a.grantee <> a.grantor LOOP
      EXECUTE format('GRANT %s ON SEQUENCE public.%I TO %s', e.privilege_type, r.name, CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(e.grantee)) END);
    END LOOP;
  END LOOP;
END $$;
-- functions: the privileges before the migration
DO $$
DECLARE r record; e record;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('public._guard_source_archive()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.acquire_funded_pass_lock(text,text,integer,text,text,integer)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.acquire_mutation_lease(uuid,text,text,integer)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.agent_run_searches_set_result_chars()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.assert_acyclic()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.assert_statutory_purity()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.census_worklist_guarded_update()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.census_worklist_no_delete()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.community_groups_owner_guard()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.community_member_profiles_verification_guard()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.community_post_signoff_requests_guard()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.community_posts_guard()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.emission_factors_append_only()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.emit_propagation_event()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.emit_propagation_events_for_region()', '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.enqueue_corpus_turn_request()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.entity_aliases_refuse_change()', '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.entity_relations_refuse_cycle()', '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.guard_data_audit_block()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.guard_judgement_drain_writer()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.guard_pause_flag_writer()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.guard_provenance_flip()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.heartbeat_funded_pass_lock(text,integer)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.heartbeat_mutation_lease(uuid,text)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.invalidate_dependents(text,text,bigint,boolean)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.item_assignments_guard()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.item_corrections_append_only()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.item_notes_guard()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.org_membership_role_guard()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.organizations_plan_guard()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.portfolio_members_cap()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.portfolios_org_cap()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.profiles_privilege_guard()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.recompute_agent_integrity_flag()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.recompute_source_accuracy()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.region_dimension_coverage_sync_fact_count()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.register_derived_value(text,text,text,numeric,numeric,numeric,text,text,text,text,text,text,numeric,timestamp with time zone,integer,jsonb,text,uuid)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.register_inference_record(text,text,text,numeric,uuid[],text,text,text,text,text,jsonb,uuid)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.release_funded_pass_lock(text,integer)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.release_mutation_lease(uuid,text)', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.set_canonical_instrument_key()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.set_provenance_status()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.set_source_label()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.source_reliability_ledger_append_only()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.sync_sources_tier_columns()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.update_updated_at()', '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}')) AS v(name, acl) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', r.name);
    FOR e IN SELECT a.grantee, a.privilege_type FROM aclexplode(NULLIF(r.acl, '')::aclitem[]) a WHERE a.grantee <> a.grantor LOOP
      EXECUTE format('GRANT %s ON FUNCTION %s TO %s', e.privilege_type, r.name, CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(e.grantee)) END);
    END LOOP;
  END LOOP;
END $$;
-- Column privileges of the three tables that carry them, as the baseline dump (supabase/schema.sql) grants them, statement for statement (after the table-level REVOKE above, which revokes them too; Postgres folds a privilege granted on every column into the table level, so the exact shape of the statements matters).
GRANT SELECT(user_id),INSERT(user_id),UPDATE(user_id) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(user_id) ON TABLE public.community_member_profiles TO anon;
GRANT SELECT(org_type),INSERT(org_type),UPDATE(org_type) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(org_type) ON TABLE public.community_member_profiles TO anon;
GRANT SELECT(role),INSERT(role),UPDATE(role) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(role) ON TABLE public.community_member_profiles TO anon;
GRANT SELECT(sector),INSERT(sector),UPDATE(sector) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(sector) ON TABLE public.community_member_profiles TO anon;
GRANT SELECT(region),INSERT(region),UPDATE(region) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(region) ON TABLE public.community_member_profiles TO anon;
GRANT SELECT(verified) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(verified) ON TABLE public.community_member_profiles TO anon;
GRANT SELECT(verified_at) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(verified_at) ON TABLE public.community_member_profiles TO anon;
GRANT SELECT(verification_method) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(verification_method) ON TABLE public.community_member_profiles TO anon;
GRANT SELECT(created_at),INSERT(created_at),UPDATE(created_at) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(created_at) ON TABLE public.community_member_profiles TO anon;
GRANT SELECT(updated_at),INSERT(updated_at),UPDATE(updated_at) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(updated_at) ON TABLE public.community_member_profiles TO anon;
GRANT INSERT(default_anonymous),UPDATE(default_anonymous) ON TABLE public.community_member_profiles TO authenticated;
GRANT INSERT(id),UPDATE(id) ON TABLE public.community_posts TO authenticated;
GRANT INSERT(group_id),UPDATE(group_id) ON TABLE public.community_posts TO authenticated;
GRANT INSERT(parent_post_id),UPDATE(parent_post_id) ON TABLE public.community_posts TO authenticated;
GRANT INSERT(author_user_id) ON TABLE public.community_posts TO authenticated;
GRANT INSERT(title),UPDATE(title) ON TABLE public.community_posts TO authenticated;
GRANT INSERT(body),UPDATE(body) ON TABLE public.community_posts TO authenticated;
GRANT INSERT(created_at),UPDATE(created_at) ON TABLE public.community_posts TO authenticated;
GRANT INSERT(last_reply_at),UPDATE(last_reply_at) ON TABLE public.community_posts TO authenticated;
GRANT INSERT(reply_count),UPDATE(reply_count) ON TABLE public.community_posts TO authenticated;
GRANT INSERT(promoted_from_post_id),UPDATE(promoted_from_post_id) ON TABLE public.community_posts TO authenticated;
GRANT INSERT(attribution),UPDATE(attribution) ON TABLE public.community_posts TO authenticated;
GRANT INSERT(referenced_intelligence_item_ids),UPDATE(referenced_intelligence_item_ids) ON TABLE public.community_posts TO authenticated;
GRANT INSERT(anonymous),UPDATE(anonymous) ON TABLE public.community_posts TO authenticated;
GRANT UPDATE(read_at) ON TABLE public.notifications TO authenticated;
-- Default privileges of postgres in public: the grants to anon and authenticated come back, and the global function default that revoked PUBLIC EXECUTE goes.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT INSERT, SELECT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
