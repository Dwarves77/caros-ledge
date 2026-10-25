-- Down for 0126_applied_batches_and_trigger_resolution: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TABLE public.applied_batches;
DROP INDEX public.item_forward_events_resolved_capture_id_idx;
ALTER TABLE public.item_forward_events
  DROP CONSTRAINT item_forward_events_resolved_only_pending_check,
  DROP CONSTRAINT item_forward_events_resolved_capture_needs_resolution_check,
  DROP CONSTRAINT item_forward_events_resolution_pair_check,
  DROP CONSTRAINT item_forward_events_resolved_capture_id_fkey,
  DROP COLUMN resolved_span,
  DROP COLUMN resolved_capture_id,
  DROP COLUMN resolved_at;
