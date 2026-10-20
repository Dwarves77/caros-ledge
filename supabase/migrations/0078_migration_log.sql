-- 0078 migration_log (R0): the database is the record of what it carries.
--
-- Before: which migrations production carries was a file in git (APPLIED.json) that a person had to keep in step with the database; the `migrate` job could not know what was applied without it, and CI cannot commit to the protected main.
-- After: public.migration_log(file, applied_at, self_check) holds one row per applied migration file. scripts/ci/migrate.mjs reads it to decide what is pending and inserts a file's row in the file's own transaction, just before its
-- final COMMIT and only after the file's `<id> OK` notice was printed, so a file is recorded if and only if it applied. This file seeds the table with the 69 files production carries today (exactly the list APPLIED.json held) and with itself.
-- Access: RLS on with no policy; service_role only (the `postgres` role the job connects as owns it). anon and authenticated can neither read nor write it.
--
-- Reversal: supabase/migrations/down/0078.sql (DROP TABLE public.migration_log).

-- catalog: relation, column, constraint, index, acl

BEGIN;

CREATE TABLE public.migration_log (
  file text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  self_check text NOT NULL,
  CONSTRAINT migration_log_file_check CHECK (file ~ '^[0-9]{4}_[a-z0-9_]+\.sql$'),
  CONSTRAINT migration_log_self_check_check CHECK (btrim(self_check) <> '')
);
ALTER TABLE public.migration_log ADD CONSTRAINT migration_log_pkey PRIMARY KEY (file);

COMMENT ON TABLE public.migration_log IS 'The migration files this database carries (R0, migration 0078): one row per applied file, written by scripts/ci/migrate.mjs in the file''s own transaction. The database is the record; no file in git tracks it.';

ALTER TABLE public.migration_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.migration_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.migration_log TO service_role;

INSERT INTO public.migration_log (file, self_check) VALUES
  ('0001_grants_and_default_privileges.sql', 'seeded by 0078'),
  ('0002_foreign_key_indexes.sql', 'seeded by 0078'),
  ('0003_set_null_on_not_null_fix.sql', 'seeded by 0078'),
  ('0004_function_search_path_pins.sql', 'seeded by 0078'),
  ('0005_vocabulary_checks.sql', 'seeded by 0078'),
  ('0006_policy_initplan_wraps.sql', 'seeded by 0078'),
  ('0007_item_type_required_slots_wave3.sql', 'seeded by 0078'),
  ('0008_harness_runs_one_ledger.sql', 'seeded by 0078'),
  ('0009_item_corrections_outbox.sql', 'seeded by 0078'),
  ('0010_derivation_inputs_outbox_and_allowlist.sql', 'seeded by 0078'),
  ('0011_data_retier_analysis_bodies_t3.sql', 'seeded by 0078'),
  ('0012_drop_function_reading_dropped_table.sql', 'seeded by 0078'),
  ('0013_fire_signpost.sql', 'seeded by 0078'),
  ('0014_screen_verdicts.sql', 'seeded by 0078'),
  ('0015_data_screen_verdicts.sql', 'seeded by 0078'),
  ('0016_data_source_type_backfill.sql', 'seeded by 0078'),
  ('0017_census_would_mint_index.sql', 'seeded by 0078'),
  ('0018_invitation_tokens_hashed.sql', 'seeded by 0078'),
  ('0019_shared_rate_limiter.sql', 'seeded by 0078'),
  ('0020_profiles_email_lower_index.sql', 'seeded by 0078'),
  ('0021_drop_duplicated_partial_indexes.sql', 'seeded by 0078'),
  ('0022_review_bookkeeping_nulls_out.sql', 'seeded by 0078'),
  ('0023_patch_workspace_settings.sql', 'seeded by 0078'),
  ('0024_tag_counts_and_org_watchers.sql', 'seeded by 0078'),
  ('0025_notification_outbox.sql', 'seeded by 0078'),
  ('0027_edge_snapshots.sql', 'seeded by 0078'),
  ('0028_invitation_actions_by_id.sql', 'seeded by 0078'),
  ('0029_market_series_items.sql', 'seeded by 0078'),
  ('0030_data_market_series_items.sql', 'seeded by 0078'),
  ('0031_member_detail_reads.sql', 'seeded by 0078'),
  ('0032_saved_views.sql', 'seeded by 0078'),
  ('0035_admin_triage_rpcs.sql', 'seeded by 0078'),
  ('0036_recalculation_notices_member_reads.sql', 'seeded by 0078'),
  ('0037_item_write_rpcs.sql', 'seeded by 0078'),
  ('0038_load_settings_bundle.sql', 'seeded by 0078'),
  ('0039_theme_brief_versions.sql', 'seeded by 0078'),
  ('0040_research_assessment_history.sql', 'seeded by 0078'),
  ('0042_host_verdicts.sql', 'seeded by 0078'),
  ('0043_comment_region_coverage_notes.sql', 'seeded by 0078'),
  ('0044_market_series_items_display.sql', 'seeded by 0078'),
  ('0045_data_market_series_cadence.sql', 'seeded by 0078'),
  ('0046_data_host_verdicts.sql', 'seeded by 0078'),
  ('0050_community_group_bans.sql', 'seeded by 0078'),
  ('0051_moderation_reports_columns.sql', 'seeded by 0078'),
  ('0052_community_group_keeps_an_admin.sql', 'seeded by 0078'),
  ('0053_create_group_for_self.sql', 'seeded by 0078'),
  ('0054_accept_group_invitation.sql', 'seeded by 0078'),
  ('0055_create_thread.sql', 'seeded by 0078'),
  ('0056_decide_signoff.sql', 'seeded by 0078'),
  ('0057_moderate_report.sql', 'seeded by 0078'),
  ('0058_community_directory_counts.sql', 'seeded by 0078'),
  ('0059_community_notification_counts.sql', 'seeded by 0078'),
  ('0060_community_rls_attacks.sql', 'seeded by 0078'),
  ('0061_data_moderation_reports_split.sql', 'seeded by 0078'),
  ('0062_community_round_trip.sql', 'seeded by 0078'),
  ('0063_community_member_mute.sql', 'seeded by 0078'),
  ('0064_host_worklist.sql', 'seeded by 0078'),
  ('0065_assign_item_members.sql', 'seeded by 0078'),
  ('0066_profiles_email_lower_unique.sql', 'seeded by 0078'),
  ('0067_drop_coverage_gap_census_findings.sql', 'seeded by 0078'),
  ('0068_live_check_provenance_trigger.sql', 'seeded by 0078'),
  ('0069_live_check_provenance_no_replica.sql', 'seeded by 0078'),
  ('0070_harness_runs_outcome_partial.sql', 'seeded by 0078'),
  ('0071_live_check_production_shape.sql', 'seeded by 0078'),
  ('0073_selfcheck_repairs.sql', 'seeded by 0078'),
  ('0074_ledger_claim_writers.sql', 'seeded by 0078'),
  ('0075_apply_theme_brief.sql', 'seeded by 0078'),
  ('0076_apply_staged_item_patch.sql', 'seeded by 0078'),
  ('0077_capture_holding_quote.sql', 'seeded by 0078'),
  ('0078_migration_log.sql', 'seeded by 0078');

-- Self-check 0078-migration-log: the seed is complete and names itself; a client role can neither read nor write the table.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.migration_log;
  IF n <> 70 THEN RAISE EXCEPTION '0078-migration-log: the seed holds % rows, expected 70', n; END IF;
  SELECT count(*) INTO n FROM public.migration_log WHERE file = '0078_migration_log.sql' AND self_check = 'seeded by 0078';
  IF n <> 1 THEN RAISE EXCEPTION '0078-migration-log: the seed does not record 0078 itself'; END IF;
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM 1 FROM public.migration_log LIMIT 1;
    RAISE EXCEPTION '0078-migration-log: anon read the log';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM 1 FROM public.migration_log LIMIT 1;
    RAISE EXCEPTION '0078-migration-log: authenticated read the log';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.migration_log (file, self_check) VALUES ('9999_forged.sql', 'forged');
    RAISE EXCEPTION '0078-migration-log: authenticated wrote the log';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE '0078-migration-log OK';
END $$;

COMMIT;
