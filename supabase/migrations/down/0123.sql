-- Down for 0123_connect_2_spine: the pattern trigger and its function go, register_derived_value returns to writing every edge as 'input', the three allow-lists return to their 0010 and baseline lists, and entity_refs loses basis and method_version (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TRIGGER propagation_outbox_trg ON public.indexation_clauses;
DROP TRIGGER propagation_outbox_trg ON public.item_forward_events;
DROP TRIGGER propagation_outbox_trg ON public.reroute_events;
DROP TRIGGER propagation_outbox_trg ON public.research_assessments;
DROP TRIGGER derived_values_pattern_evidence_trg ON public.derived_values;
DROP FUNCTION public.assert_pattern_has_evidence();
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
    VALUES (v_ref->>'table', v_ref->>'pk', v_value_id, 'input');
  END LOOP;
  RETURN v_value_id;
END $function$;
ALTER TABLE public.derivation_edges DROP CONSTRAINT derivation_edges_edge_kind_allowed;
ALTER TABLE public.derivation_edges DROP CONSTRAINT derivation_edges_from_table_allowed;
ALTER TABLE public.derivation_edges ADD CONSTRAINT derivation_edges_from_table_allowed CHECK ((from_table = ANY (ARRAY['emission_factors'::text, 'market_series'::text, 'regional_data_facts'::text, 'derived_values'::text, 'statutory_computations'::text, 'estimated_values'::text, 'state_cost_facts'::text, 'inference_records'::text, 'intelligence_items'::text, 'section_claim_provenance'::text])));
ALTER TABLE public.entity_relations DROP CONSTRAINT entity_relations_relation_values;
ALTER TABLE public.entity_relations ADD CONSTRAINT entity_relations_relation_values CHECK ((relation = ANY (ARRAY['group_of'::text, 'legal_entity_of'::text, 'operating_identity_of'::text])));
ALTER TABLE public.entity_refs DROP CONSTRAINT entity_refs_ref_table_allowed;
ALTER TABLE public.entity_refs ADD CONSTRAINT entity_refs_ref_table_allowed CHECK ((ref_table = ANY (ARRAY['intelligence_items'::text, 'regions'::text])));
ALTER TABLE public.entity_refs DROP CONSTRAINT entity_refs_basis_is_object_check, DROP CONSTRAINT entity_refs_basis_with_method_check;
ALTER TABLE public.entity_refs DROP COLUMN basis, DROP COLUMN method_version;
