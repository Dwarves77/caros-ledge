-- Rollback-test fixture for 0015_data_screen_verdicts.sql: a source and three of the census rows the file rules on (ids copied from
-- the file; the other 1,743 are absent, so the skip-and-NOTICE path runs too). Runs inside the job's rolled-back transaction.
INSERT INTO public.sources (id, name, url, base_tier, tier_at_creation) VALUES ('5a5a5a5a-0000-4000-8000-0000000000a1', 'fixture 0015', 'https://fixture-0015.invalid/', 3, 3);
INSERT INTO public.census_worklist (id, source_id, document_url, lane, created_by) VALUES
  ('001b59d1-2bf2-4af6-b998-2599cd8a1b4a', '5a5a5a5a-0000-4000-8000-0000000000a1', 'https://fixture-0015.invalid/a', 'A', 'fixture-0015'),
  ('0029568c-e941-49cc-943c-992293a11b22', '5a5a5a5a-0000-4000-8000-0000000000a1', 'https://fixture-0015.invalid/b', 'A', 'fixture-0015'),
  ('00562d45-e809-4cc8-b552-d02f98798cc4', '5a5a5a5a-0000-4000-8000-0000000000a1', 'https://fixture-0015.invalid/c', 'A', 'fixture-0015');
-- an existing ruling the data file must not overwrite
INSERT INTO public.screen_verdicts (census_id, verdict, basis, reviewer) VALUES ('00562d45-e809-4cc8-b552-d02f98798cc4', 'ambiguous', 'fixture: ruled before the load', 'fixture');
