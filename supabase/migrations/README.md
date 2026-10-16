Forward changes only, one file per change (`NNNN_<change>.sql`), each ending in a DO-block self-check. The baseline is `supabase/schema.sql`; nothing here edits it.

- `scripts/ci/schema-apply.mjs` applies `schema.sql`, then these files in name order, on an empty Postgres 15.14 in CI. It then runs the property checks and the catalog diff.
- A file's header names the register row that owes it and carries `-- catalog: <classes>` (any of column, relation, constraint, index, policy, trigger, function, acl, default_acl; `none` for data only). The catalog diff fails when a migration changes a class it did not declare or declares one it did not change.
- A file with `_data_` in its name is a data migration. The schema job never runs it. It ships with its consumer and runs at the cutover window (two-track policy).
- Nothing here is applied to production before the cutover window; the old tree serves production until then.

| file | change | self-check |
|---|---|---|
| 0001_grants_and_default_privileges | default privileges, SEC-9 anon grant table, identity policies TO authenticated, EXECUTE revokes | 0001-grants |
| 0002_foreign_key_indexes | an index for each of the 82 unindexed foreign keys | 0002-fk-indexes |
| 0003_set_null_on_not_null_fix | seven ON DELETE SET NULL actions that could not set null | 0003-set-null |
| 0004_function_search_path_pins | search_path pinned on 29 functions | 0004-search-path |
| 0005_vocabulary_checks | monitoring_queue.last_result, state_cost_facts.dimension, user_watchlist.item_type | 0005-vocabulary |
| 0006_policy_initplan_wraps | 27 policies wrap auth.uid() and auth.role() | 0006-initplan |
| 0007_item_type_required_slots_wave3 | old migration 299, four required slots | 0007-slots |
| 0008_harness_runs_one_ledger | harness_runs becomes the one ledger | 0008-harness-runs |
| 0009_item_corrections_outbox | corrections and revokes emit propagation events | 0009-corrections-outbox |
| 0010_derivation_inputs_outbox_and_allowlist | derivation_edges admits items and claims; state_cost_facts outbox | 0010-derivation-inputs |
| 0011_data_retier_analysis_bodies_t3 | DATA: OECD, IEA, World Bank, IPCC to T3 (cutover window) | 0011-data-retier |
| 0012_drop_function_reading_dropped_table | drops reorder_user_list_item | 0012-drop-dead-function |
| 0013_fire_signpost | public.fire_signpost: one transaction for the stamp, the propagation event and the assessment lifecycle move (P2-06) | 0013-fire-signpost |
