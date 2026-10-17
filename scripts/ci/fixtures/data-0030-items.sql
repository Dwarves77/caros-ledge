-- Rollback-test fixture for 0030_data_market_series_items.sql: two of the six items the file attaches (ids copied from the file; the other four are absent, so the skip-and-NOTICE path runs too) and one attachment ruled before the load
-- that the data file must not overwrite. Runs inside the job's rolled-back transaction.
INSERT INTO public.intelligence_items (id, title, domain) VALUES
  ('4fae403a-ced5-4c8f-82b7-af0fd6127061', 'fixture 0030 a', 4),
  ('70869a22-39eb-4eb7-ba49-d3826b5b2265', 'fixture 0030 b', 4);
INSERT INTO public.market_series_items (series_key, item_id, status) VALUES ('eu-oil-bulletin:automotive-diesel', '70869a22-39eb-4eb7-ba49-d3826b5b2265', 'pending');
