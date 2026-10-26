-- 0141 connect_2_pr_b: a connection carries the quote it stands on, a mandate carries its quantity and dates, and a pattern's prediction can be tracked without a research assessment (CONNECT-2 PR B, unified design section 7).
-- change: entity_relations gains basis and method_version, the cycle guard stops at hierarchical relations, obligation_objects gains due_date, mandated_quantity, mandated_unit, in_force_end, method_version and basis, signposts may track an inference record without an assessment
--
-- (a) entity_relations (a reader's connection) gains `basis jsonb` and `method_version text` with CHECK ((basis IS NULL) = (method_version IS NULL)): an edge the reader asserts says which quote of which capture it stands on and which reader version wrote it; an edge with one and
-- not the other is refused, and the 56 edges the seeds wrote keep null in both. The cycle guard (entity_relations_refuse_cycle, migration 377) walked every relation as a hierarchy, so two briefs asserting A competes_for_feedstock B and B competes_for_feedstock A (a symmetric
-- relation) failed with a cycle error on the second. The guard now applies to the hierarchical relations only (group_of, legal_entity_of, operating_identity_of, implements, amends) and walks only the hierarchical rows; a symmetric or directed-flow relation is not a hierarchy
-- and is not tested for one.
--
-- (b) NOT CHANGED, measured: the design cited the baseline lines schema.sql:9345 and :9901 (event_kind) and :9342, :9347 (source_kind). The migration chain already carries what it asks for: 0113 and 0114 admit target, implementing_act_due, delegated_act_due and guidance_expected in
-- item_forward_events_event_kind_check and obligations_event_kind_check; 0110 admits source_kind 'capture' with source_capture_id (the capture_id the design asked for) and the CHECK that pairs them; entity_refs admits item_forward_events since 0133. A reader event grounded on a capture
-- quote inserts cleanly today, and the self-check below proves it by inserting one of each pending kind with its ref (and refuses a kind outside the list).
--
-- (c) obligation_objects gains `due_date date` (the date a step falls due; first_deadline stays the item-level date), `mandated_quantity numeric` with `mandated_unit text` (the quantity a mandate requires, in a unit the unit map states; never the penalty maximum, which stays
-- statutory_maximum), `in_force_end date` (the day a provision stops applying: an ended ceiling is no fact), `method_version text` and `basis jsonb` (who wrote the values: a reader value reader@<kinds> wins over a derived one, a derived value never overwrites a reader value).
-- CHECKs: the quantity and its unit come together, the quantity is not negative, the basis comes with its method and is an object, the in-force window does not run backwards. Existing rows keep null in all six.
--
-- (d) signposts.assessment_id was NOT NULL (a signpost tracked a research assessment). A pattern's prediction (P2, P3, P5) is tracked by an inference record, which the table already links (inference_record_id, learning-loop-design section 3: "unset for an assessment-derived
-- signpost"). assessment_id becomes nullable under CHECK (assessment_id IS NOT NULL OR inference_record_id IS NOT NULL): a signpost tracks an assessment, an inference, or both, never nothing. fire_signpost is unchanged: a pattern signpost is scored by the pattern step
-- (src/core/flywheel/patterns/signposts.ts) in one update and is never fired through the assessment lifecycle.
--
-- Access: unchanged. Reversal: down/0141.sql restores the cycle function, drops the columns and the checks, and removes the pattern signposts before it restores NOT NULL.

-- catalog: column, constraint, function

BEGIN;

ALTER TABLE public.entity_relations ADD COLUMN IF NOT EXISTS basis jsonb, ADD COLUMN IF NOT EXISTS method_version text;
ALTER TABLE public.entity_relations DROP CONSTRAINT IF EXISTS entity_relations_basis_with_method_check, DROP CONSTRAINT IF EXISTS entity_relations_basis_is_object_check;
ALTER TABLE public.entity_relations
  ADD CONSTRAINT entity_relations_basis_with_method_check CHECK ((basis IS NULL) = (method_version IS NULL)),
  ADD CONSTRAINT entity_relations_basis_is_object_check CHECK (basis IS NULL OR jsonb_typeof(basis) = 'object');

CREATE OR REPLACE FUNCTION public.entity_relations_refuse_cycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_hierarchical text[] := ARRAY['group_of', 'legal_entity_of', 'operating_identity_of', 'implements', 'amends'];
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('entity_relations_cycle', 0));

  IF NEW.parent_entity_id = NEW.child_entity_id THEN
    RAISE EXCEPTION 'entity_relations: % cannot be its own parent', NEW.parent_entity_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- only a hierarchy has ancestors: a symmetric relation (competes_for_feedstock, shares_grid_zone, corridor_links) or a flow (feedstock_of, fuel_for_mode, serves_hub, consignment_wide) asserted both ways is two facts, not a cycle
  IF NEW.relation <> ALL (v_hierarchical) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    WITH RECURSIVE ancestors(entity_id) AS (
      SELECT NEW.parent_entity_id
      UNION
      SELECT r.parent_entity_id
        FROM public.entity_relations r
        JOIN ancestors a ON r.child_entity_id = a.entity_id
       WHERE r.relation = ANY (v_hierarchical)
         AND NOT (TG_OP = 'UPDATE'
                  AND r.parent_entity_id = OLD.parent_entity_id
                  AND r.child_entity_id = OLD.child_entity_id
                  AND r.relation = OLD.relation)
    )
    SELECT 1 FROM ancestors WHERE entity_id = NEW.child_entity_id
  ) THEN
    RAISE EXCEPTION 'entity_relations: % as the child of % would make the child an ancestor of its own parent (a cycle)',
      NEW.child_entity_id, NEW.parent_entity_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $function$;

ALTER TABLE public.obligation_objects
  ADD COLUMN IF NOT EXISTS due_date date, ADD COLUMN IF NOT EXISTS mandated_quantity numeric, ADD COLUMN IF NOT EXISTS mandated_unit text,
  ADD COLUMN IF NOT EXISTS in_force_end date, ADD COLUMN IF NOT EXISTS method_version text, ADD COLUMN IF NOT EXISTS basis jsonb;
ALTER TABLE public.obligation_objects
  DROP CONSTRAINT IF EXISTS obligation_objects_mandated_pair_check, DROP CONSTRAINT IF EXISTS obligation_objects_mandated_nonnegative_check,
  DROP CONSTRAINT IF EXISTS obligation_objects_basis_with_method_check, DROP CONSTRAINT IF EXISTS obligation_objects_basis_is_object_check, DROP CONSTRAINT IF EXISTS obligation_objects_in_force_window_check;
ALTER TABLE public.obligation_objects
  ADD CONSTRAINT obligation_objects_mandated_pair_check CHECK ((mandated_quantity IS NULL) = (mandated_unit IS NULL)),
  ADD CONSTRAINT obligation_objects_mandated_nonnegative_check CHECK (mandated_quantity IS NULL OR mandated_quantity >= 0),
  ADD CONSTRAINT obligation_objects_basis_with_method_check CHECK ((basis IS NULL) = (method_version IS NULL)),
  ADD CONSTRAINT obligation_objects_basis_is_object_check CHECK (basis IS NULL OR jsonb_typeof(basis) = 'object'),
  ADD CONSTRAINT obligation_objects_in_force_window_check CHECK (in_force_end IS NULL OR enforcement_start IS NULL OR in_force_end >= enforcement_start);

ALTER TABLE public.signposts ALTER COLUMN assessment_id DROP NOT NULL;
ALTER TABLE public.signposts DROP CONSTRAINT IF EXISTS signposts_tracks_something_check;
ALTER TABLE public.signposts ADD CONSTRAINT signposts_tracks_something_check CHECK (assessment_id IS NOT NULL OR inference_record_id IS NOT NULL);

-- Self-check 0141-connect-2-pr-b: the new columns and checks, and attacks. A basis with no method, and a method with no basis, are refused on entity_relations and on obligation_objects, and an edge with both is kept; A competes_for_feedstock B then B competes_for_feedstock A both
-- insert (the red line before this file: the second raised a cycle error), while a hierarchical cycle (A implements B, B implements A) and a cycle through a mix of hierarchical relations are still refused; a mandated quantity without a unit, a negative quantity and an in-force window that runs
-- backwards are refused; a reader event of each pending kind grounded on a capture inserts with its ref and a kind outside the list is refused; a signpost with neither an assessment nor an inference record is refused and one with only an inference record is kept.
DO $$
DECLARE
  v_a text := 'cl:asset:0141000000000001'; v_b text := 'cl:asset:0141000000000002'; v_c text := 'cl:asset:0141000000000003'; v_i text := 'cl:instrument:0141000000000004'; v_s text := 'cl:signpost:0141000000000005';
  v_item uuid := gen_random_uuid(); v_cap uuid := gen_random_uuid(); v_inf uuid := gen_random_uuid(); v_ev uuid := gen_random_uuid();
  v_kind text; n int;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND ((table_name = 'entity_relations' AND column_name IN ('basis', 'method_version'))
        OR (table_name = 'obligation_objects' AND column_name IN ('due_date', 'mandated_quantity', 'mandated_unit', 'in_force_end', 'method_version', 'basis')))) <> 8 THEN
    RAISE EXCEPTION '0141-connect-2-pr-b: a column is missing';
  END IF;
  IF (SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'signposts' AND column_name = 'assessment_id') <> 'YES' THEN
    RAISE EXCEPTION '0141-connect-2-pr-b: signposts.assessment_id is still NOT NULL';
  END IF;
  BEGIN
    INSERT INTO public.entities (entity_id, kind, canonical_name, status) VALUES (v_a, 'asset', 'selfcheck a 0141', 'active'), (v_b, 'asset', 'selfcheck b 0141', 'active'), (v_c, 'asset', 'selfcheck c 0141', 'active'),
      (v_i, 'instrument', 'selfcheck instrument 0141', 'active'), (v_s, 'signpost', 'selfcheck signpost 0141', 'active');

    -- entity_relations: the basis pair
    INSERT INTO public.entity_relations (parent_entity_id, child_entity_id, relation, asserted_by, basis, method_version) VALUES (v_a, v_b, 'competes_for_feedstock', 'selfcheck-0141', '{"quote":"x","capture_id":"y","reason_token":"z"}'::jsonb, 'reader@1.0.0');
    BEGIN
      INSERT INTO public.entity_relations (parent_entity_id, child_entity_id, relation, asserted_by, method_version) VALUES (v_a, v_c, 'competes_for_feedstock', 'selfcheck-0141', 'reader@1.0.0');
      RAISE EXCEPTION '0141-connect-2-pr-b: an edge with a method and no basis was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.entity_relations (parent_entity_id, child_entity_id, relation, asserted_by, basis) VALUES (v_a, v_c, 'competes_for_feedstock', 'selfcheck-0141', '{"quote":"x"}'::jsonb);
      RAISE EXCEPTION '0141-connect-2-pr-b: an edge with a basis and no method was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.entity_relations (parent_entity_id, child_entity_id, relation, asserted_by, basis, method_version) VALUES (v_a, v_c, 'competes_for_feedstock', 'selfcheck-0141', '[1]'::jsonb, 'reader@1.0.0');
      RAISE EXCEPTION '0141-connect-2-pr-b: a basis that is not an object was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- the symmetric pair from two briefs, then the hierarchy attacks
    INSERT INTO public.entity_relations (parent_entity_id, child_entity_id, relation, asserted_by, basis, method_version) VALUES (v_b, v_a, 'competes_for_feedstock', 'selfcheck-0141', '{"quote":"x"}'::jsonb, 'reader@1.0.0');
    INSERT INTO public.entity_relations (parent_entity_id, child_entity_id, relation, asserted_by) VALUES (v_a, v_b, 'corridor_links', 'selfcheck-0141'), (v_b, v_a, 'corridor_links', 'selfcheck-0141');
    INSERT INTO public.entity_relations (parent_entity_id, child_entity_id, relation, asserted_by) VALUES (v_i, v_a, 'implements', 'selfcheck-0141');
    BEGIN
      INSERT INTO public.entity_relations (parent_entity_id, child_entity_id, relation, asserted_by) VALUES (v_a, v_i, 'implements', 'selfcheck-0141');
      RAISE EXCEPTION '0141-connect-2-pr-b: a hierarchical cycle (A implements B, B implements A) was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    INSERT INTO public.entity_relations (parent_entity_id, child_entity_id, relation, asserted_by) VALUES (v_a, v_c, 'amends', 'selfcheck-0141');
    BEGIN
      INSERT INTO public.entity_relations (parent_entity_id, child_entity_id, relation, asserted_by) VALUES (v_c, v_i, 'amends', 'selfcheck-0141');
      RAISE EXCEPTION '0141-connect-2-pr-b: a cycle through two hierarchical relations was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    SELECT count(*) INTO n FROM public.entity_relations WHERE asserted_by = 'selfcheck-0141' AND relation IN ('competes_for_feedstock', 'corridor_links');
    IF n <> 4 THEN RAISE EXCEPTION '0141-connect-2-pr-b: the symmetric pairs left % of 4 rows', n; END IF;

    -- obligation_objects: the checks (a fixture instrument item and capture)
    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0141', 1);
    INSERT INTO public.agent_run_searches (id, intelligence_item_id, result_url, result_content, result_index, searched_at) VALUES (v_cap, v_item, 'https://selfcheck-0141.invalid/law', 'Article 1 shall apply from 1 January 2030. The ceiling is EUR 100.', 0, '2026-01-01T00:00:00Z');
    BEGIN
      INSERT INTO public.obligation_objects (obligation_id, instrument_item_id, pinpoint_citation, verbatim_text, binding_position, duty_holder_class, applicability_trigger, capture_id, mandated_quantity)
        VALUES ('cl:obligation:0141000000000011', v_item, 'Article 1', 'Article 1 shall apply from 1 January 2030.', 'direct_duty', ARRAY['carrier'], '{"attribute":"mode","value":"air"}'::jsonb, v_cap, 3.6);
      RAISE EXCEPTION '0141-connect-2-pr-b: a mandated quantity with no unit was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.obligation_objects (obligation_id, instrument_item_id, pinpoint_citation, verbatim_text, binding_position, duty_holder_class, applicability_trigger, capture_id, mandated_quantity, mandated_unit)
        VALUES ('cl:obligation:0141000000000012', v_item, 'Article 1', 'Article 1 shall apply from 1 January 2030.', 'direct_duty', ARRAY['carrier'], '{"attribute":"mode","value":"air"}'::jsonb, v_cap, -1, 'MW');
      RAISE EXCEPTION '0141-connect-2-pr-b: a negative mandated quantity was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.obligation_objects (obligation_id, instrument_item_id, pinpoint_citation, verbatim_text, binding_position, duty_holder_class, applicability_trigger, capture_id, enforcement_start, in_force_end)
        VALUES ('cl:obligation:0141000000000013', v_item, 'Article 1', 'Article 1 shall apply from 1 January 2030.', 'direct_duty', ARRAY['carrier'], '{"attribute":"mode","value":"air"}'::jsonb, v_cap, '2030-01-01', '2007-12-31');
      RAISE EXCEPTION '0141-connect-2-pr-b: an in-force window that runs backwards was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.obligation_objects (obligation_id, instrument_item_id, pinpoint_citation, verbatim_text, binding_position, duty_holder_class, applicability_trigger, capture_id, method_version)
        VALUES ('cl:obligation:0141000000000014', v_item, 'Article 1', 'Article 1 shall apply from 1 January 2030.', 'direct_duty', ARRAY['carrier'], '{"attribute":"mode","value":"air"}'::jsonb, v_cap, 'reader@1.0.0');
      RAISE EXCEPTION '0141-connect-2-pr-b: an object with a method and no basis was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    INSERT INTO public.obligation_objects (obligation_id, instrument_item_id, pinpoint_citation, verbatim_text, binding_position, duty_holder_class, applicability_trigger, capture_id, due_date, mandated_quantity, mandated_unit, enforcement_start, in_force_end, method_version, basis)
      VALUES ('cl:obligation:0141000000000015', v_item, 'Article 1', 'Article 1 shall apply from 1 January 2030.', 'direct_duty', ARRAY['carrier'], '{"attribute":"mode","value":"air"}'::jsonb, v_cap, '2030-01-01', 3.6, 'MW', '2030-01-01', '2035-12-31', 'reader@1.0.0', '{"quote":"Article 1 shall apply from 1 January 2030."}'::jsonb);

    -- item_forward_events: a reader event of each pending kind grounded on a capture inserts, with its ref; a kind outside the list does not
    FOREACH v_kind IN ARRAY ARRAY['implementing_act_due', 'delegated_act_due', 'guidance_expected'] LOOP
      v_ev := gen_random_uuid();
      INSERT INTO public.item_forward_events (id, intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, source_capture_id, source_span, confidence, extractor_version)
        VALUES (v_ev, v_item, '2027-06-01', 'month', v_kind, 'selfcheck 0141', 'capture', v_cap, 'shall apply from 1 January 2030', 'medium', 'reader@1.0.0');
      INSERT INTO public.entity_refs (ref_table, ref_id, entity_id, role, asserted_by, basis, method_version) VALUES ('item_forward_events', v_ev, v_a, 'cites_asset', 'selfcheck-0141', '{"quote":"x"}'::jsonb, 'reader@1.0.0');
    END LOOP;
    BEGIN
      INSERT INTO public.item_forward_events (intelligence_item_id, event_date, date_precision, event_kind, obligation_text, source_kind, source_capture_id, source_span, confidence, extractor_version)
        VALUES (v_item, '2027-06-01', 'month', 'bogus_kind', 'selfcheck 0141', 'capture', v_cap, 'x', 'medium', 'reader@1.0.0');
      RAISE EXCEPTION '0141-connect-2-pr-b: an event kind outside the list was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- signposts: tracks an assessment, an inference or both, never nothing
    INSERT INTO public.inference_records (inference_id, subject_id, claim_text, status_token, confidence, cited_item_ids, origin_class, method_id, method_version, computed_by)
      VALUES (v_inf, v_a, 'selfcheck 0141 pattern stands', 'HYPOTHESIS', 0.5, ARRAY[v_item], 'derived', 'pattern_selfcheck', '1.0.0', 'selfcheck-0141');
    BEGIN
      INSERT INTO public.signposts (entity_id, watches, predicate, direction) VALUES (v_s, v_a, '{"op":"date_passed","field":"x"}'::jsonb, 'confirms');
      RAISE EXCEPTION '0141-connect-2-pr-b: a signpost tracking nothing was accepted';
    EXCEPTION WHEN not_null_violation OR check_violation THEN NULL;
    END;
    INSERT INTO public.signposts (entity_id, watches, predicate, direction, inference_record_id) VALUES (v_s, v_a, '{"op":"date_passed","field":"x"}'::jsonb, 'confirms', v_inf);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0141-connect-2-pr-b OK';
END $$;

COMMIT;
