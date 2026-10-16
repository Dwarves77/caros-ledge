-- Rollback-test fixture for 0011_data_retier_analysis_bodies_t3.sql: one source on each of the four hosts at T2 and one other-host
-- source at T2 that must not move. Runs inside the job's rolled-back transaction.
INSERT INTO public.sources (id, name, url, base_tier, tier_at_creation) VALUES
  ('5a5a5a5a-0000-4000-8000-0000000000b1', 'fixture oecd', 'https://www.oecd.org/x', 2, 2),
  ('5a5a5a5a-0000-4000-8000-0000000000b2', 'fixture iea', 'https://iea.org/x', 2, 2),
  ('5a5a5a5a-0000-4000-8000-0000000000b3', 'fixture worldbank', 'https://data.worldbank.org/x', 2, 2),
  ('5a5a5a5a-0000-4000-8000-0000000000b4', 'fixture ipcc', 'https://www.ipcc.ch/x', 2, 2),
  ('5a5a5a5a-0000-4000-8000-0000000000b5', 'fixture other', 'https://other.example.org/x', 2, 2);
