-- Rollback-test fixture for 0072_data_market_series_selfcheck.sql: the state production is in after 0030 and 0045 ran, all six EU Oil Bulletin attachments, ratified, on the weekly cadence (item ids copied from 0030). The file asserts exactly
-- this; the mutants registry attacks it by deleting the fixture (the self-check must then raise). Runs inside the job's rolled-back transaction, after 0044 has added the cadence column.
INSERT INTO public.intelligence_items (id, title, domain) VALUES
  ('4fae403a-ced5-4c8f-82b7-af0fd6127061', 'fixture 0072 a', 4),
  ('70869a22-39eb-4eb7-ba49-d3826b5b2265', 'fixture 0072 b', 4),
  ('32783a47-0073-4cff-a2ae-369508bcdfe9', 'fixture 0072 c', 4),
  ('2d306cc6-084d-44d0-ae88-bb391767f787', 'fixture 0072 d', 4),
  ('0ee667cc-a403-4fe3-b5f8-4f829a4a9103', 'fixture 0072 e', 4),
  ('180b8163-6ae5-4f35-98dd-02e46c06b561', 'fixture 0072 f', 4);
INSERT INTO public.market_series_items (series_key, item_id, status, cadence_days) VALUES
  ('eu-oil-bulletin:eurosuper-95', '4fae403a-ced5-4c8f-82b7-af0fd6127061', 'ratified', 7),
  ('eu-oil-bulletin:automotive-diesel', '70869a22-39eb-4eb7-ba49-d3826b5b2265', 'ratified', 7),
  ('eu-oil-bulletin:heating-gas-oil', '32783a47-0073-4cff-a2ae-369508bcdfe9', 'ratified', 7),
  ('eu-oil-bulletin:lpg-motor-fuel', '2d306cc6-084d-44d0-ae88-bb391767f787', 'ratified', 7),
  ('eu-oil-bulletin:residual-fuel-oil-1pct', '0ee667cc-a403-4fe3-b5f8-4f829a4a9103', 'ratified', 7),
  ('eu-oil-bulletin:heavy-fuel-oil-3-5pct', '180b8163-6ae5-4f35-98dd-02e46c06b561', 'ratified', 7);
