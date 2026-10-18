-- Rollback-test fixture for 0061_data_moderation_reports_split.sql: one report of each old encoding (reason only, reason and body, a resolved report with an action and notes, a dismissed one) and one already split row that the
-- data file must leave alone. Runs inside the job's rolled-back transaction, after 0051 added the columns.
INSERT INTO auth.users (id, email) VALUES ('00610000-0000-4000-8000-000000000001', 'fixture-0061@invalid.example');
INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason, status) VALUES
  ('post', '00610000-0000-4000-8000-0000000000a1', '00610000-0000-4000-8000-000000000001', 'spam', 'open'),
  ('post', '00610000-0000-4000-8000-0000000000a2', '00610000-0000-4000-8000-000000000001', 'harassment|they keep tagging me', 'open'),
  ('post', '00610000-0000-4000-8000-0000000000a3', '00610000-0000-4000-8000-000000000001', 'misinformation|false claim||action=remove_post;notes=removed after review', 'resolved'),
  ('post', '00610000-0000-4000-8000-0000000000a4', '00610000-0000-4000-8000-000000000001', 'other||action=dismiss', 'dismissed');
INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason, body, status) VALUES
  ('post', '00610000-0000-4000-8000-0000000000a5', '00610000-0000-4000-8000-000000000001', 'off-topic', 'already split', 'open');
