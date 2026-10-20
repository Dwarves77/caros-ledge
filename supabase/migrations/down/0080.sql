-- Down for 0080_collection_state: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
-- A queue row left `refused` becomes `error` (the older vocabulary has no state between a wall and a failure; last_error_text keeps what the worker said).
DROP INDEX public.agent_run_searches_url_hash_idx;
ALTER TABLE public.agent_run_searches DROP COLUMN number_locale, DROP COLUMN capture_channel, DROP COLUMN content_hash;
UPDATE public.pending_first_fetch SET status = 'error' WHERE status = 'refused';
ALTER TABLE public.pending_first_fetch DROP CONSTRAINT pending_first_fetch_status_check;
ALTER TABLE public.pending_first_fetch ADD CONSTRAINT pending_first_fetch_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'fetching'::text, 'done'::text, 'error'::text, 'skipped'::text])));
ALTER TABLE public.sources DROP COLUMN publisher_locale, DROP COLUMN access_contact, DROP COLUMN access_requested_at, DROP COLUMN collection_detail, DROP COLUMN collection_state, DROP COLUMN reuse_terms;
