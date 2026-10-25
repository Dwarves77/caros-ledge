-- 0128 obligation_objects.evidence_artifacts: the compliance artifacts an obligation names, as a structured column (CTX-6).
--
-- Before: CTX-5 stored the artifact list ([{class, name}], the class from the data file, the name verbatim from the span) as JSON TEXT inside evidence_required (text), so the type system could not say what the column holds and the readers
-- parsed text. After: evidence_artifacts jsonb, nullable, CHECKed to be an array of {class, name} objects whose class and name are non-empty strings (NULL: the span names none). derive-objects writes it; relevance.ts reads it.
-- The existing JSON-text values move in 0129_data_evidence_artifacts_move.sql (a data migration, run after this file).
-- Access: unchanged (the table's grants and policies cover a new column).
--
-- Reversal: down/0128.sql copies the artifacts back into evidence_required as JSON text where that column is empty, then drops the constraint and the column.

-- catalog: column, constraint

BEGIN;

ALTER TABLE public.obligation_objects
  ADD COLUMN evidence_artifacts jsonb,
  ADD CONSTRAINT obligation_objects_evidence_artifacts_shape_check
  CHECK (evidence_artifacts IS NULL OR (CASE WHEN jsonb_typeof(evidence_artifacts) = 'array' THEN jsonb_array_length(evidence_artifacts) = jsonb_array_length(jsonb_path_query_array(evidence_artifacts, '$[*] ? (@.type() == "object" && @.class.type() == "string" && @.class != "" && @.name.type() == "string" && @.name != "")')) ELSE false END));

-- Self-check 0128-evidence-artifacts: NULL, an empty array and a well-formed array are accepted; a non-array, an element that is not an object, a missing or non-string or empty class or name are each refused by the CHECK.
DO $$
DECLARE
  v_item uuid := gen_random_uuid(); v_cap uuid := gen_random_uuid();
  cases text[][] := ARRAY[
    ['null',     NULL,                                                    'ok'],
    ['empty',    '[]',                                                    'ok'],
    ['valid',    '[{"class":"declaration_of_conformity","name":"EU declaration of conformity"}]', 'ok'],
    ['object',   '{"class":"a","name":"b"}',                              'refused'],
    ['scalar',   '"declaration_of_conformity"',                           'refused'],
    ['number',   '[1]',                                                   'refused'],
    ['no name',  '[{"class":"a"}]',                                       'refused'],
    ['no class', '[{"name":"b"}]',                                        'refused'],
    ['name int', '[{"class":"a","name":3}]',                              'refused'],
    ['blank',    '[{"class":"","name":"b"}]',                             'refused'],
    ['mixed',    '[{"class":"a","name":"b"},"x"]',                        'refused']
  ];
  i integer;
BEGIN
  BEGIN
    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0128', 1);
    INSERT INTO public.agent_run_searches (id, intelligence_item_id, result_url, result_content, result_index) VALUES (v_cap, v_item, 'https://regulator-0128.invalid/law', 'Article 6(1) Manufacturers shall draw up an EU declaration of conformity.', 0);
    FOR i IN 1 .. array_length(cases, 1) LOOP
      BEGIN
        INSERT INTO public.obligation_objects (obligation_id, instrument_item_id, version, pinpoint_citation, verbatim_text, binding_position, duty_holder_class, applicability_trigger, capture_id, evidence_artifacts)
          VALUES ('cl:obligation:' || lpad(to_hex(i), 16, '0'), v_item, 1, 'Article 6(1)', 'Manufacturers shall draw up an EU declaration of conformity', 'direct_duty', ARRAY['manufacturer'], '{"attribute":"org_role","value":"manufacturer"}'::jsonb, v_cap, cases[i][2]::jsonb);
        IF cases[i][3] = 'refused' THEN RAISE EXCEPTION '0128-evidence-artifacts: % was accepted', cases[i][1]; END IF;
      EXCEPTION WHEN check_violation THEN
        IF cases[i][3] = 'ok' THEN RAISE EXCEPTION '0128-evidence-artifacts: % was refused', cases[i][1]; END IF;
      END;
    END LOOP;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0128-evidence-artifacts OK';
END $$;

COMMIT;
