-- 0004 search_path pins (P2-S1, owed by register P1-11 schema.md section 8 "Added": SET search_path = public, pg_temp on the
-- 29 functions without one; INV-138; the property check function-search-path was waived at 29 until this file).
--
-- A function with no pinned search_path resolves unqualified names through the caller's session path, so a caller who controls
-- the path can shadow a table or operator the body names. Every function in public now carries search_path=public, pg_temp.
-- cl_corridor_id calls digest() from pgcrypto, installed in the extensions schema, so it also names extensions.
-- Five of the 29 belong to objects a later migration drops (funded-pass lock, bucket_value and bucket_width_multiplier);
-- they are pinned here so the baseline is zero until the drop lands. Not applied to production before the cutover window.
--
-- Reversal: ALTER FUNCTION ... RESET search_path for the names in the list below.

-- catalog: function

BEGIN;

DO $$
DECLARE r record; n int := 0;
  fns text[] := ARRAY[
    'acquire_funded_pass_lock(text,text,integer,text,text,integer)',
    'acquire_mutation_lease(uuid,text,text,integer)',
    'agent_run_searches_set_result_chars()',
    'assert_acyclic()',
    'assert_statutory_purity()',
    'bucket_value(numeric,text,numeric)',
    'bucket_width_multiplier(integer,integer)',
    'census_worklist_guarded_update()',
    'census_worklist_no_delete()',
    'cl_corridor_field(text)',
    'cl_corridor_id(text,text,text,integer,text,text[])',
    'derive_canonical_instrument_key(text,text)',
    'effective_confidence(numeric,timestamp with time zone,integer,timestamp with time zone)',
    'emission_factors_append_only()',
    'emit_propagation_event()',
    'enqueue_corpus_turn_request()',
    'get_tier_opinion_disagreements(integer)',
    'guard_judgement_drain_writer()',
    'guard_pause_flag_writer()',
    'heartbeat_funded_pass_lock(text,integer)',
    'heartbeat_mutation_lease(uuid,text)',
    'invalidate_dependents(text,text,bigint,boolean)',
    'next_uncensused_portal_candidates(uuid,integer,boolean,timestamp with time zone,uuid)',
    'register_derived_value(text,text,text,numeric,numeric,numeric,text,text,text,text,text,text,numeric,timestamp with time zone,integer,jsonb,text,uuid)',
    'register_inference_record(text,text,text,numeric,uuid[],text,text,text,text,text,jsonb,uuid)',
    'release_funded_pass_lock(text,integer)',
    'release_mutation_lease(uuid,text)',
    'set_canonical_instrument_key()',
    'source_reliability_ledger_append_only()'
  ];
BEGIN
  FOR r IN SELECT f FROM unnest(fns) AS f LOOP
    IF r.f LIKE 'cl_corridor_id(%' THEN
      EXECUTE format('ALTER FUNCTION public.%s SET search_path = public, extensions, pg_temp', r.f);
    ELSE
      EXECUTE format('ALTER FUNCTION public.%s SET search_path = public, pg_temp', r.f);
    END IF;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '0004: % functions pinned', n;
END $$;

-- Self-check 0004-search-path: none of the functions in public lacks a pinned search_path, and the pinned digest still resolves.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) s WHERE s LIKE 'search_path=%');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0004-search-path: unpinned %', bad; END IF;
  IF length(public.cl_corridor_id('NLRTM', 'USNYC', 'ocean', 1, 'k', ARRAY[]::text[])) < 20 THEN
    RAISE EXCEPTION '0004-search-path: cl_corridor_id no longer resolves digest under its pinned path';
  END IF;
  RAISE NOTICE '0004-search-path OK';
END $$;

COMMIT;
