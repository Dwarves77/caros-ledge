-- Rollback-test fixture for 0045_data_market_series_cadence.sql: two of the six attachments the file sets a cadence on (item ids copied from 0030), one of them with a cadence ruled before the load (14) that the data file must not
-- overwrite. Runs inside the job's rolled-back transaction, after 0044 has added the column.
INSERT INTO public.intelligence_items (id, title, domain) VALUES
  ('4fae403a-ced5-4c8f-82b7-af0fd6127061', 'fixture 0045 a', 4),
  ('32783a47-0073-4cff-a2ae-369508bcdfe9', 'fixture 0045 b', 4),
  ('70869a22-39eb-4eb7-ba49-d3826b5b2265', 'fixture 0045 c', 4);
INSERT INTO public.market_series_items (series_key, item_id, status, cadence_days) VALUES
  ('eu-oil-bulletin:eurosuper-95', '4fae403a-ced5-4c8f-82b7-af0fd6127061', 'ratified', NULL),
  ('eu-oil-bulletin:heating-gas-oil', '32783a47-0073-4cff-a2ae-369508bcdfe9', 'ratified', NULL),
  ('eu-oil-bulletin:automotive-diesel', '70869a22-39eb-4eb7-ba49-d3826b5b2265', 'ratified', 14);
