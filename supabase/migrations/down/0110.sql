-- Down for 0110_forward_events_capture_source: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DELETE FROM public.item_forward_events WHERE source_kind = 'capture';
DROP INDEX public.item_forward_events_source_capture_id_idx;
ALTER TABLE public.item_forward_events DROP CONSTRAINT item_forward_events_capture_id_matches_source_kind_check;
ALTER TABLE public.item_forward_events DROP CONSTRAINT item_forward_events_source_kind_check;
ALTER TABLE public.item_forward_events ADD CONSTRAINT item_forward_events_source_kind_check CHECK (source_kind = ANY (ARRAY['claim'::text, 'section'::text]));
ALTER TABLE public.item_forward_events DROP CONSTRAINT item_forward_events_source_capture_id_fkey;
ALTER TABLE public.item_forward_events DROP COLUMN source_capture_id;
