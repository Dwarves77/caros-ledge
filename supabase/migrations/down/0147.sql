-- Down for 0147_ets_maritime_item_replaced_by: ff4064ab is admissible again (replaced_by NULL) where it still names 15f63ea9 (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
UPDATE public.intelligence_items SET replaced_by = NULL WHERE id = 'ff4064ab-9489-4fc4-b3cc-f0f157e71db5' AND replaced_by = '15f63ea9-4803-4bb4-b1a3-9ccdeb8a3050';
