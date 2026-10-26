-- 0137 capture_document_date: a capture carries the date its document states about itself (DOC-DATE-1, ADR-053 section 2).
--
-- Why: the velocity detector (pattern_velocity_burst) measured a claim's age by the day its item was added, which is the day of intake, not the day the document was written; a bulk intake of old law reads as a burst (audit R5). No column carried a document date.
-- What: agent_run_searches gains document_date (date), document_date_basis (the verbatim fragment of result_content the date was read from) and document_date_method (the extractor and its version, e.g. doc-date@1.0.0), all NULL until the producer reads a formal date out of the stored text.
-- CHECK: the three are set together or not at all, so a date with no basis, or a basis with no date, or a date from no named method, cannot be stored. A partial index serves the detector's join on dated captures.
-- Access: unchanged (the table's grants and policies cover a new column).
--
-- Reversal: down/0137.sql drops the index, the constraints and the columns.
-- change: agent_run_searches.document_date, document_date_basis and document_date_method (all or none, by CHECK) and the partial index on document_date; the date a capture's document states about itself (DOC-DATE-1, ADR-053)

-- catalog: column, constraint, index

BEGIN;

ALTER TABLE public.agent_run_searches
  ADD COLUMN IF NOT EXISTS document_date date,
  ADD COLUMN IF NOT EXISTS document_date_basis text,
  ADD COLUMN IF NOT EXISTS document_date_method text;

ALTER TABLE public.agent_run_searches
  DROP CONSTRAINT IF EXISTS agent_run_searches_document_date_basis_check,
  DROP CONSTRAINT IF EXISTS agent_run_searches_document_date_method_check;
ALTER TABLE public.agent_run_searches
  ADD CONSTRAINT agent_run_searches_document_date_basis_check CHECK ((document_date IS NULL) = (document_date_basis IS NULL)),
  ADD CONSTRAINT agent_run_searches_document_date_method_check CHECK ((document_date IS NULL) = (document_date_method IS NULL));

CREATE INDEX IF NOT EXISTS agent_run_searches_document_date_idx ON public.agent_run_searches (document_date) WHERE document_date IS NOT NULL;

-- Self-check 0137-capture-document-date: the three columns are accepted together or not at all (a date alone, a basis alone, a method alone, a date with a basis but no method are each refused) and the partial index exists.
DO $$
DECLARE
  v_item uuid := gen_random_uuid();
  cases text[][] := ARRAY[
    ['none',            NULL,         NULL,            NULL,            'ok'],
    ['all three',       '2023-09-13', 'Done at Strasbourg, 13 September 2023', 'doc-date@1.0.0', 'ok'],
    ['date only',       '2023-09-13', NULL,            NULL,            'refused'],
    ['basis only',      NULL,         'a fragment',    NULL,            'refused'],
    ['method only',     NULL,         NULL,            'doc-date@1.0.0', 'refused'],
    ['no method',       '2023-09-13', 'a fragment',    NULL,            'refused'],
    ['no basis',        '2023-09-13', NULL,            'doc-date@1.0.0', 'refused']
  ];
  i integer;
BEGIN
  BEGIN
    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0137', 1);
    FOR i IN 1 .. array_length(cases, 1) LOOP
      BEGIN
        INSERT INTO public.agent_run_searches (id, intelligence_item_id, result_url, result_content, result_index, document_date, document_date_basis, document_date_method)
          VALUES (gen_random_uuid(), v_item, 'https://regulator-0137.invalid/law', 'text', 0, cases[i][2]::date, cases[i][3], cases[i][4]);
        IF cases[i][5] = 'refused' THEN RAISE EXCEPTION '0137-capture-document-date: % was accepted', cases[i][1]; END IF;
      EXCEPTION WHEN check_violation THEN
        IF cases[i][5] = 'ok' THEN RAISE EXCEPTION '0137-capture-document-date: % was refused', cases[i][1]; END IF;
      END;
    END LOOP;
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'agent_run_searches_document_date_idx' AND indexdef LIKE '%WHERE (document_date IS NOT NULL)%') THEN
      RAISE EXCEPTION '0137-capture-document-date: the partial index is missing';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0137-capture-document-date OK';
END $$;

COMMIT;
