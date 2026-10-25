-- 0134 connect_2_spine: the ontology spine takes the claims, the typed tables and the five pattern detectors (CONNECT-2 PR A).
--
-- entity_refs gains `basis jsonb` and `method_version text` with CHECK ((basis IS NULL) = (method_version IS NULL)): every ref the mining writes carries the claim id and span, the column and value, or the tag it came from, and the version of the rule that read it
-- (a ref with a method and no basis, or a basis and no method, is refused; the 2,878 refs that exist keep null in both). The entity_refs.ref_table allow-list is 0133's and 0134 admits nothing there; the nine coupling relations to entity_relations.relation, and the tables a pattern
-- cites as evidence to derivation_edges.from_table. A derivation edge now has a kind ('input' for every edge written so far; 'member', 'evidence' or 'key' for a pattern's), set from the optional `kind` of each input by register_derived_value. A derived value whose method id
-- begins `pattern_` cannot be committed without at least one derivation edge naming it (a deferred constraint trigger: the register function writes the value and its edges in one transaction). entity_relations keeps its cycle trigger; the seeds run from a lower class rank
-- to a higher one, so the table holds no cycle.
--
-- Reversal: down/0134.sql returns the constraints and the function and drops the triggers and the columns.

-- catalog: column, constraint, function, trigger

BEGIN;

ALTER TABLE public.entity_refs ADD COLUMN IF NOT EXISTS basis jsonb, ADD COLUMN IF NOT EXISTS method_version text;
ALTER TABLE public.entity_refs DROP CONSTRAINT IF EXISTS entity_refs_basis_with_method_check, DROP CONSTRAINT IF EXISTS entity_refs_basis_is_object_check;
ALTER TABLE public.entity_refs
  ADD CONSTRAINT entity_refs_basis_with_method_check CHECK ((basis IS NULL) = (method_version IS NULL)),
  ADD CONSTRAINT entity_refs_basis_is_object_check CHECK (basis IS NULL OR jsonb_typeof(basis) = 'object');

ALTER TABLE public.entity_relations DROP CONSTRAINT IF EXISTS entity_relations_relation_values;
ALTER TABLE public.entity_relations ADD CONSTRAINT entity_relations_relation_values CHECK ((relation = ANY (ARRAY['group_of'::text, 'legal_entity_of'::text, 'operating_identity_of'::text, 'feedstock_of'::text, 'fuel_for_mode'::text, 'competes_for_feedstock'::text, 'shares_grid_zone'::text, 'serves_hub'::text, 'corridor_links'::text, 'implements'::text, 'amends'::text, 'consignment_wide'::text])));

ALTER TABLE public.derivation_edges DROP CONSTRAINT IF EXISTS derivation_edges_from_table_allowed, DROP CONSTRAINT IF EXISTS derivation_edges_edge_kind_allowed;
ALTER TABLE public.derivation_edges ADD CONSTRAINT derivation_edges_from_table_allowed CHECK ((from_table = ANY (ARRAY['emission_factors'::text, 'market_series'::text, 'regional_data_facts'::text, 'derived_values'::text, 'statutory_computations'::text, 'estimated_values'::text, 'state_cost_facts'::text, 'inference_records'::text, 'intelligence_items'::text, 'section_claim_provenance'::text, 'obligation_objects'::text, 'oem_tech_roadmaps'::text, 'grid_connection_queues'::text, 'reroute_events'::text, 'research_assessments'::text, 'indexation_clauses'::text, 'item_forward_events'::text])));
ALTER TABLE public.derivation_edges ADD CONSTRAINT derivation_edges_edge_kind_allowed CHECK ((edge_kind = ANY (ARRAY['input'::text, 'member'::text, 'evidence'::text, 'key'::text])));

CREATE OR REPLACE FUNCTION public.register_derived_value(p_entity_id text, p_method_id text, p_method_version text, p_value numeric, p_value_low numeric, p_value_high numeric, p_unit text, p_currency text, p_derivation text, p_origin_class text, p_lifecycle text, p_admissibility text, p_base_confidence numeric, p_asserted_at timestamp with time zone, p_half_life_days integer, p_inputs jsonb, p_computed_by text, p_supersedes uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_value_id uuid;
  v_ref jsonb;
BEGIN
  INSERT INTO public.derived_values (
    entity_id, method_id, method_version, value, value_low, value_high, unit, currency,
    derivation, origin_class, lifecycle, admissibility, base_confidence, asserted_at,
    half_life_days, inputs, computed_by, supersedes
  ) VALUES (
    p_entity_id, p_method_id, p_method_version, p_value, p_value_low, p_value_high, p_unit, p_currency,
    p_derivation, p_origin_class, p_lifecycle, p_admissibility, p_base_confidence, p_asserted_at,
    p_half_life_days, coalesce(p_inputs, '[]'::jsonb), p_computed_by, p_supersedes
  ) RETURNING value_id INTO v_value_id;
  FOR v_ref IN SELECT * FROM jsonb_array_elements(coalesce(p_inputs, '[]'::jsonb))
  LOOP
    INSERT INTO public.derivation_edges (from_table, from_pk, to_value_id, edge_kind)
    VALUES (v_ref->>'table', v_ref->>'pk', v_value_id, coalesce(v_ref->>'kind', 'input'));
  END LOOP;
  RETURN v_value_id;
END $function$;

CREATE OR REPLACE FUNCTION public.assert_pattern_has_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.derivation_edges e WHERE e.to_table = 'derived_values' AND e.to_value_id = NEW.value_id AND e.edge_kind IN ('member', 'evidence', 'key')) THEN
    RAISE EXCEPTION 'derived value % (%) is a pattern and names no evidence row', NEW.value_id, NEW.method_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $function$;
DROP TRIGGER IF EXISTS derived_values_pattern_evidence_trg ON public.derived_values;
CREATE CONSTRAINT TRIGGER derived_values_pattern_evidence_trg AFTER INSERT ON public.derived_values DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.method_id LIKE 'pattern\_%') EXECUTE FUNCTION public.assert_pattern_has_evidence();

-- every table a derivation edge admits reaches the outbox (the property derivation-input-outbox): the four evidence tables that had no propagation trigger get one, so a changed evidence row marks the patterns that cite it stale.
DROP TRIGGER IF EXISTS propagation_outbox_trg ON public.indexation_clauses;
CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.indexation_clauses FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('clause_id');
DROP TRIGGER IF EXISTS propagation_outbox_trg ON public.item_forward_events;
CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.item_forward_events FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('id');
DROP TRIGGER IF EXISTS propagation_outbox_trg ON public.reroute_events;
CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.reroute_events FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('reroute_id');
DROP TRIGGER IF EXISTS propagation_outbox_trg ON public.research_assessments;
CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.research_assessments FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('id');

-- Self-check 0134-connect-2-spine: the new columns and the CHECK, and attacks: a ref with a method and no basis, a basis and no method, a basis that is not an object and a table outside the list are refused and a ref with both is kept; a relation outside the twelve is refused
-- and a coupling relation kept; an edge of a kind outside the four and from a table outside the list are refused and a 'member' edge from a newly admitted table is kept; a pattern value with no edge is refused when its transaction would commit, and with an edge is kept;
-- an input with no kind still writes the edge kind 'input'; the four evidence tables carry a propagation trigger.
DO $$
DECLARE v_a text := 'cl:node:0134000000000001'; v_b text := 'cl:asset:0134000000000002'; v_v uuid; v_p uuid; n int;
BEGIN
  IF (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'entity_refs') <> 'asserted_at,asserted_by,basis,entity_id,method_version,ref_id,ref_table,role' THEN
    RAISE EXCEPTION '0134-connect-2-spine: unexpected entity_refs columns';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname = 'propagation_outbox_trg' AND tgrelid IN ('public.indexation_clauses'::regclass, 'public.item_forward_events'::regclass, 'public.reroute_events'::regclass, 'public.research_assessments'::regclass)) <> 4 THEN
    RAISE EXCEPTION '0134-connect-2-spine: an evidence table has no propagation trigger';
  END IF;
  BEGIN
    INSERT INTO public.entities (entity_id, kind, canonical_name, status) VALUES (v_a, 'node', 'selfcheck node 0134', 'active'), (v_b, 'asset', 'selfcheck asset 0134', 'active');
    INSERT INTO public.entity_refs (ref_table, ref_id, entity_id, role, asserted_by, basis, method_version) VALUES ('section_claim_provenance', gen_random_uuid(), v_a, 'cites_node', 'selfcheck-0134', '{"claim_id":"x","span":[0,1]}'::jsonb, 'refs@1.0.0');
    INSERT INTO public.entity_refs (ref_table, ref_id, entity_id, role, asserted_by) VALUES ('regions', gen_random_uuid(), v_a, 'jurisdiction', 'selfcheck-0134');
    BEGIN
      INSERT INTO public.entity_refs (ref_table, ref_id, entity_id, role, asserted_by, method_version) VALUES ('market_series', gen_random_uuid(), v_a, 'cites_node', 'selfcheck-0134', 'refs@1.0.0');
      RAISE EXCEPTION '0134-connect-2-spine: a ref with a method and no basis was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.entity_refs (ref_table, ref_id, entity_id, role, asserted_by, basis) VALUES ('market_series', gen_random_uuid(), v_a, 'cites_node', 'selfcheck-0134', '{"column":"series_key"}'::jsonb);
      RAISE EXCEPTION '0134-connect-2-spine: a ref with a basis and no method was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.entity_refs (ref_table, ref_id, entity_id, role, asserted_by, basis, method_version) VALUES ('market_series', gen_random_uuid(), v_a, 'cites_node', 'selfcheck-0134', '[1]'::jsonb, 'refs@1.0.0');
      RAISE EXCEPTION '0134-connect-2-spine: a basis that is not an object was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.entity_refs (ref_table, ref_id, entity_id, role, asserted_by, basis, method_version) VALUES ('workspace_settings', gen_random_uuid(), v_a, 'cites_node', 'selfcheck-0134', '{"x":1}'::jsonb, 'refs@1.0.0');
      RAISE EXCEPTION '0134-connect-2-spine: a ref table outside the list was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    INSERT INTO public.entity_relations (parent_entity_id, child_entity_id, relation, asserted_by) VALUES (v_a, v_b, 'serves_hub', 'selfcheck-0134');
    BEGIN
      INSERT INTO public.entity_relations (parent_entity_id, child_entity_id, relation, asserted_by) VALUES (v_b, v_a, 'bogus_relation', 'selfcheck-0134');
      RAISE EXCEPTION '0134-connect-2-spine: a relation outside the twelve was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    v_v := public.register_derived_value(v_a, 'selfcheck_0134', '1.0.0', 1, NULL, NULL, 'ratio', NULL, 'calculated', 'derived', 'emerging', 'analysis_ok', 0.5, now(), NULL,
      '[{"table":"oem_tech_roadmaps","pk":"selfcheck-0134","kind":"member"},{"table":"obligation_objects","pk":"selfcheck-0134","kind":"key"},{"table":"market_series","pk":"selfcheck-0134"}]'::jsonb, 'selfcheck-0134');
    SELECT count(*) INTO n FROM public.derivation_edges WHERE to_value_id = v_v AND ((from_table = 'oem_tech_roadmaps' AND edge_kind = 'member') OR (from_table = 'obligation_objects' AND edge_kind = 'key') OR (from_table = 'market_series' AND edge_kind = 'input'));
    IF n <> 3 THEN RAISE EXCEPTION '0134-connect-2-spine: the register function wrote % of the 3 edge kinds asked for', n; END IF;
    BEGIN
      INSERT INTO public.derivation_edges (from_table, from_pk, to_value_id, edge_kind) VALUES ('oem_tech_roadmaps', 'selfcheck-0134-b', v_v, 'bogus');
      RAISE EXCEPTION '0134-connect-2-spine: an edge kind outside the four was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.derivation_edges (from_table, from_pk, to_value_id, edge_kind) VALUES ('workspace_settings', 'selfcheck-0134', v_v, 'member');
      RAISE EXCEPTION '0134-connect-2-spine: an edge from a table outside the list was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.derived_values (value_id, entity_id, method_id, method_version, value, unit, derivation, origin_class, lifecycle, admissibility, base_confidence, asserted_at, inputs, computed_at, computed_by)
        VALUES (gen_random_uuid(), v_a, 'pattern_selfcheck', '1.0.0', 1, 'ratio', 'calculated', 'derived', 'emerging', 'analysis_ok', 0.5, now(), '[]'::jsonb, now(), 'selfcheck-0134');
      SET CONSTRAINTS public.derived_values_pattern_evidence_trg IMMEDIATE;
      RAISE EXCEPTION '0134-connect-2-spine: a pattern value with no evidence edge was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    SET CONSTRAINTS public.derived_values_pattern_evidence_trg DEFERRED;
    v_p := public.register_derived_value(v_a, 'pattern_selfcheck', '1.0.0', 1, NULL, NULL, 'ratio', NULL, 'calculated', 'derived', 'emerging', 'analysis_ok', 0.5, now(), NULL, '[{"table":"item_forward_events","pk":"selfcheck-0134","kind":"evidence"}]'::jsonb, 'selfcheck-0134');
    SET CONSTRAINTS public.derived_values_pattern_evidence_trg IMMEDIATE;
    IF NOT EXISTS (SELECT 1 FROM public.derived_values WHERE value_id = v_p) THEN RAISE EXCEPTION '0134-connect-2-spine: a pattern value with an evidence edge was not kept'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0134-connect-2-spine OK';
END $$;

COMMIT;
