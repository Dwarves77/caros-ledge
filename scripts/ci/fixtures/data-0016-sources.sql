-- Rollback-test fixture for 0016_data_source_type_backfill.sql: the five rows of sources-export-sample.json as they would sit in the
-- registry (the fourth fully classified; the first already holds a role and the second a type, which the file must leave as they are). Runs inside the job's rolled-back transaction.
INSERT INTO public.sources (id, name, url, base_tier, tier_at_creation, source_role, source_type) VALUES
  ('5a5a5a5a-0000-4000-8000-000000000001', 'Sample Environmental Agency', 'https://agency.example.gov/', 1, 1, 'trade_press', NULL),
  ('5a5a5a5a-0000-4000-8000-000000000002', 'Sample Parliament', 'https://parliament.example.org/', 1, 1, NULL, ARRAY['news']),
  ('5a5a5a5a-0000-4000-8000-000000000003', 'Sample Freight News', 'https://news.example.com/', 4, 4, NULL, NULL),
  ('5a5a5a5a-0000-4000-8000-000000000004', 'Sample Already Classified Agency', 'https://classified.example.gov/', 4, 4, 'trade_press', ARRAY['news']),
  ('5a5a5a5a-0000-4000-8000-000000000005', 'Sample Unclassifiable', 'https://x.invalid/', 4, 4, NULL, NULL);
