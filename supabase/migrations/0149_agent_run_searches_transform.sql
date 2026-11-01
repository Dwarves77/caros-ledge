-- 0149 agent_run_searches_transform: a capture rendered from a structured file row by a declared, versioned transform records which transform (PRODUCER-CAPTURE-1, ruling 68).
-- change: agent_run_searches.transform and transform_version (nullable text, both set or both NULL) and a unique index so one (item, search_query) holds one transform capture
--
-- Before: the weekly Oil Bulletin observations lived only in market_series, so a market brief ratified onto a series-backed item had no capture to quote and its weekly figures could not be grounded verbatim (ADR-016).
-- After: the producer files one capture per (item, series_key, reference_period): result_content is the declared transform text of the sheet row, transform names the transform ('xlsx-row-text') and transform_version its version.
-- A capture of a web page or a PDF keeps both columns NULL. The partial unique index is the dedup key the producer upserts on (search_query = 'series:<series_key>@<reference_period>'), so a re-run or a concurrent run cannot file a second copy.
-- Access: unchanged (column grants follow the table). Reversal: down/0149.sql drops the index, the constraint and both columns (the transform names are lost; the capture text stays).

-- catalog: column, constraint, index

BEGIN;

ALTER TABLE public.agent_run_searches
  ADD COLUMN IF NOT EXISTS transform text,
  ADD COLUMN IF NOT EXISTS transform_version text,
  ADD CONSTRAINT agent_run_searches_transform_pair_check CHECK ((transform IS NULL) = (transform_version IS NULL));
COMMENT ON COLUMN public.agent_run_searches.transform IS 'Migration 0149. The declared transform that rendered result_content from a structured file row (xlsx-row-text); NULL for a capture of a page or a document.';
COMMENT ON COLUMN public.agent_run_searches.transform_version IS 'Migration 0149. The version of that transform; NULL exactly when transform is NULL.';
CREATE UNIQUE INDEX IF NOT EXISTS agent_run_searches_transform_capture_uidx ON public.agent_run_searches (intelligence_item_id, search_query) WHERE transform IS NOT NULL;

-- Self-check 0149-agent-run-searches-transform: both columns are nullable text; THE ATTACKS: a half-set pair is refused, and a second transform capture for the same (item, search_query) is refused while a plain capture of the same query is not.
DO $$
DECLARE
  item uuid;
  n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agent_run_searches' AND column_name IN ('transform', 'transform_version') AND data_type = 'text' AND is_nullable = 'YES';
  IF n <> 2 THEN RAISE EXCEPTION '0149-agent-run-searches-transform: transform and transform_version are not both nullable text'; END IF;
  INSERT INTO public.intelligence_items (title, domain) VALUES ('selfcheck-0149', 1) RETURNING id INTO item;
  BEGIN
    INSERT INTO public.agent_run_searches (intelligence_item_id, search_query, result_url, transform) VALUES (item, 'series:x@2026-01-05', 'https://selfcheck-0149.invalid/a', 'xlsx-row-text');
    RAISE EXCEPTION '0149-agent-run-searches-transform: a transform with no version was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.agent_run_searches (intelligence_item_id, search_query, result_url, result_content, transform, transform_version) VALUES (item, 'series:x@2026-01-05', 'https://selfcheck-0149.invalid/a', 'one', 'xlsx-row-text', '1.0.0');
  BEGIN
    INSERT INTO public.agent_run_searches (intelligence_item_id, search_query, result_url, result_content, transform, transform_version) VALUES (item, 'series:x@2026-01-05', 'https://selfcheck-0149.invalid/a', 'two', 'xlsx-row-text', '1.0.0');
    RAISE EXCEPTION '0149-agent-run-searches-transform: a second transform capture of the same (item, week) was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  INSERT INTO public.agent_run_searches (intelligence_item_id, search_query, result_url, result_content) VALUES (item, 'series:x@2026-01-05', 'https://selfcheck-0149.invalid/b', 'a plain capture is not constrained');
  DELETE FROM public.intelligence_items WHERE id = item;
  RAISE NOTICE '0149-agent-run-searches-transform OK';
END $$;

COMMIT;
