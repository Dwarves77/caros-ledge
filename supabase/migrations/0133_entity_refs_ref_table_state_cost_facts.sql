-- 0133 entity_refs.ref_table admits state_cost_facts (FIX-REFS-1), and the ten state fuel-tax facts the failed run wrote under bare state codes take their ISO 3166-2 code.
--
-- Why: the arm-2 ruled run failed at step state-cost-facts with `insert into entity_refs failed: new row for relation "entity_refs" violates check constraint "entity_refs_ref_table_allowed"`. The CHECK (migration 283's
-- closed list, widened deliberately and never by inference) names intelligence_items and regions; state-cost-facts.ts has written ref_table "state_cost_facts" since the port (its `after` step, rule 17: a state fact carries
-- the ref to its jurisdiction entity), and no migration ever admitted it. The producer inserts its rows first, so the failed step left ten state_cost_facts rows (13 -> 23) with no ref. Production read-only before this file:
-- constraint = CHECK (ref_table = ANY (ARRAY['intelligence_items','regions'])); entity_refs holds 2,860 intelligence_items and 18 regions rows; those are the only writers (link-entities.ts, backfill-entities.ts, state-cost-facts.ts).
-- tests/entities/ref-table-allowed.test.ts reads every ref_table the code writes and asserts it is on the list this file (and any later one) leaves, so the next producer that writes a new table fails CI, not production.
--
-- What: the CHECK is replaced with the full list of tables that carry entity_refs, idempotently (drop if exists, add): the union of (a) the three tables the code under src writes today, found by reading every writer (intelligence_items: link-entities.ts and
-- backfill-entities.ts; regions: backfill-entities.ts; state_cost_facts: state-cost-facts.ts) and (b) the fifteen-table list slice/connect-2a (PR 96) had set in its own spine migration for the joins CONNECT-2 builds (section_claim_provenance, obligation_objects,
-- statutory_computations, market_series, emission_factors, grid_connection_queues, oem_tech_roadmaps, reroute_events, regional_data_facts, research_assessments_current, indexation_clauses, item_forward_events, with the three of (a)). This file is the ONE owner of
-- the constraint; PR 96 stops touching it. Tables from (a) only: none (all three are in (b)); tables from (b) only: the twelve others.
--
-- The repair: the same failed run wrote its ten rows under bare state codes (CA, FL, IL, NY, PA, TX, WA) where the thirteen minimum-wage rows already in the table, and the jurisdiction entities built from item jurisdictions, use the ISO 3166-2
-- code (US-CA). A bare CA, IL or PA is Canada, Israel or Panama in the entity spine, so a ref written for them would have linked California's diesel tax to Canada. The producer now refuses a bare code and its rows file carries US-xx; this file renames
-- the ten existing operational_cost rows (never over a row that already holds the US-xx key) so the rerun matches them as existing (23 rows, zero duplicates) and writes their refs to the right entities. The jurisdiction entities
-- the failed run minted under bare codes (FL, NY, TX, WA as ISO3166_1 identifiers) are NOT deleted here: no row references them; their removal is a data deletion left for the coordinator (statement in the FIX-REFS-1 report).
--
-- Access: unchanged.
--
-- Reversal: down/0133.sql restores the two-table CHECK production carried before this file (read with pg_get_constraintdef) after removing the refs of every other table (the CHECK could not otherwise be re-added). The state-code rename is not reversed: the bare codes were the defect.

-- catalog: constraint

BEGIN;

ALTER TABLE public.entity_refs DROP CONSTRAINT IF EXISTS entity_refs_ref_table_allowed;
ALTER TABLE public.entity_refs ADD CONSTRAINT entity_refs_ref_table_allowed CHECK ((ref_table = ANY (ARRAY['intelligence_items'::text, 'regions'::text, 'section_claim_provenance'::text, 'obligation_objects'::text, 'statutory_computations'::text, 'market_series'::text, 'emission_factors'::text, 'grid_connection_queues'::text, 'oem_tech_roadmaps'::text, 'reroute_events'::text, 'regional_data_facts'::text, 'state_cost_facts'::text, 'research_assessments_current'::text, 'indexation_clauses'::text, 'item_forward_events'::text])));

UPDATE public.state_cost_facts f
   SET state_code = 'US-' || f.state_code
 WHERE f.dimension = 'operational_cost'
   AND f.state_code IN ('CA', 'FL', 'IL', 'NY', 'PA', 'TX', 'WA')
   AND NOT EXISTS (SELECT 1 FROM public.state_cost_facts g WHERE g.state_code = 'US-' || f.state_code AND g.dimension = f.dimension AND g.fact_label = f.fact_label);

-- Self-check 0133-entity-refs-state-cost-facts: the CHECK names the fifteen tables (including the three the code writes); a ref for state_cost_facts inserts and a ref for a table the list does not name is refused by that CHECK (both on a fixture entity, rolled back); and no
-- operational_cost state fact is left under a bare two-letter code.
DO $$
DECLARE
  v_def text; v_n int; v_msg text; v_bare int;
  v_entity text := 'cl:jurisdiction:selfcheck0133';
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO v_def FROM pg_constraint c WHERE c.conname = 'entity_refs_ref_table_allowed' AND c.conrelid = 'public.entity_refs'::regclass;
  IF v_def IS NULL OR v_def NOT LIKE '%intelligence_items%' OR v_def NOT LIKE '%regions%' OR v_def NOT LIKE '%state_cost_facts%' THEN
    RAISE EXCEPTION '0133-entity-refs-state-cost-facts: the CHECK does not name intelligence_items, regions and state_cost_facts (got %)', v_def;
  END IF;
  v_n := (SELECT count(*) FROM regexp_matches(v_def, '''[a-z_]+''::text', 'g'));
  IF v_n <> 15 THEN RAISE EXCEPTION '0133-entity-refs-state-cost-facts: the CHECK names % tables, expected the 15 of the agreed list', v_n; END IF;
  BEGIN
    INSERT INTO public.entities (entity_id, kind, canonical_name) VALUES (v_entity, 'jurisdiction', 'selfcheck0133');
    INSERT INTO public.entity_refs (ref_table, ref_id, entity_id, role, asserted_by) VALUES ('state_cost_facts', gen_random_uuid(), v_entity, 'jurisdiction', 'selfcheck0133');
    BEGIN
      INSERT INTO public.entity_refs (ref_table, ref_id, entity_id, role, asserted_by) VALUES ('not_a_table', gen_random_uuid(), v_entity, 'jurisdiction', 'selfcheck0133');
      RAISE EXCEPTION '0133-entity-refs-state-cost-facts: a ref for a table the list does not name was accepted';
    EXCEPTION WHEN check_violation THEN
      NULL;
    END;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '0133-entity-refs-state-cost-facts: rollback sentinel';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> '0133-entity-refs-state-cost-facts: rollback sentinel' THEN RAISE; END IF;
  END;
  SELECT count(*) INTO v_bare FROM public.state_cost_facts WHERE dimension = 'operational_cost' AND state_code ~ '^[A-Z]{2}$';
  IF v_bare <> 0 THEN
    RAISE EXCEPTION '0133-entity-refs-state-cost-facts: % operational_cost state fact(s) still carry a bare two-letter state code', v_bare;
  END IF;
  RAISE NOTICE '0133-entity-refs-state-cost-facts OK';
END $$;

COMMIT;
