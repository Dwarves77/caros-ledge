-- 0010 derivation inputs: widened allowlist and the state_cost_facts outbox (P2-S1, owed by register P1-10 flywheel-b.md
-- section 8 "Gaps" 2 and P1-11 schema.md section 8 "Changed": derivation_edges admits state_cost_facts as an input while
-- state_cost_facts carries no outbox trigger).
--
--   derivation_edges_from_table_allowed gains 'intelligence_items' and 'section_claim_provenance'. A first inference cites items
--     and claims as its inputs, and with neither admitted it had no edge and could never be recomputed (B-0829); 0009's
--     correction events address exactly these two tables. The to_table allowlist is untouched.
--   state_cost_facts gains propagation_outbox_trg (emit_propagation_events_for_region, the regional_data_facts shape): a write to
--     an input table that the allowlist admits must reach the drain, or the edge is a promise the database cannot keep.
-- Existing rows satisfy the wider list. Not applied to production before the cutover window.
--
-- Reversal: re-create the CHECK with the eight baseline tables (valid only while no edge cites the two new ones);
-- DROP TRIGGER propagation_outbox_trg ON public.state_cost_facts.

-- catalog: constraint, trigger

BEGIN;

ALTER TABLE public.derivation_edges DROP CONSTRAINT derivation_edges_from_table_allowed;
ALTER TABLE public.derivation_edges ADD CONSTRAINT derivation_edges_from_table_allowed CHECK (
  from_table IN ('emission_factors', 'market_series', 'regional_data_facts', 'derived_values', 'statutory_computations',
                 'estimated_values', 'state_cost_facts', 'inference_records', 'intelligence_items', 'section_claim_provenance'));

CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.state_cost_facts
  FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_events_for_region('id', 'region_id');

-- Self-check 0010-derivation-inputs: attacks on the live constraint and the live trigger, rolled back by a sentinel.
DO $$
DECLARE v_region uuid := gen_random_uuid(); n int; refused boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.derivation_edges (from_table, from_pk, to_table, to_value_id)
      VALUES ('intelligence_items', gen_random_uuid()::text, 'derived_values', gen_random_uuid()),
             ('section_claim_provenance', gen_random_uuid()::text, 'derived_values', gen_random_uuid());
    BEGIN
      INSERT INTO public.derivation_edges (from_table, from_pk, to_table, to_value_id)
        VALUES ('item_notes', gen_random_uuid()::text, 'derived_values', gen_random_uuid());
    EXCEPTION WHEN check_violation THEN refused := true;
    END;
    IF NOT refused THEN RAISE EXCEPTION '0010-derivation-inputs: an unlisted from_table was admitted'; END IF;

    INSERT INTO public.regions (id, code, label) VALUES (v_region, 'selfcheck0010', 'selfcheck 0010');
    INSERT INTO public.entities (entity_id, kind, canonical_name) VALUES ('cl:jurisdiction:selfcheck0010', 'jurisdiction', 'selfcheck 0010');
    INSERT INTO public.entity_refs (ref_table, ref_id, entity_id, role, asserted_by)
      VALUES ('regions', v_region, 'cl:jurisdiction:selfcheck0010', 'jurisdiction', 'selfcheck');
    INSERT INTO public.state_cost_facts (region_id, state_code, state_label, dimension, fact_label, value)
      VALUES (v_region, 'XX', 'selfcheck', 'grid_intensity', 'selfcheck', '1');
    SELECT count(*) INTO n FROM public.propagation_events
     WHERE table_name = 'state_cost_facts' AND entity_id = 'cl:jurisdiction:selfcheck0010' AND change_kind = 'insert';
    IF n <> 1 THEN RAISE EXCEPTION '0010-derivation-inputs: state_cost_facts insert emitted % events, expected 1', n; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '0010-derivation-inputs: rollback sentinel';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '0010-derivation-inputs: rollback sentinel' THEN RAISE; END IF;
  END;
  RAISE NOTICE '0010-derivation-inputs OK';
END $$;

COMMIT;
