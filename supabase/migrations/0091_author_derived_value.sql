-- 0091 author_derived_value: authoring a derived value once, in one statement (R2d, MASTER I14, register flywheel:32).
--
-- authorEdges checked "has this input been authored by this method" with two reads per input and then registered the value: two workers could both pass the check and author twice. The check and the
-- write are now one function call. It takes a transaction-level advisory lock per (method, version, input table, input key) in key order, looks for a derived value of that method with an edge from
-- any of the inputs, and registers the new value (through register_derived_value, the one write path) only when there is none. It returns the value id and whether this call authored it.
-- Service role only: it writes. An empty input list is an error (a derivation with no edge can never be recomputed, and cannot be keyed).
-- Reversal: DROP FUNCTION public.author_derived_value(text, text, text, numeric, numeric, numeric, text, text, text, text, text, text, numeric, timestamptz, integer, jsonb, text).
-- Not applied to production before the cutover window.

-- catalog: function

BEGIN;

CREATE FUNCTION public.author_derived_value(p_entity_id text, p_method_id text, p_method_version text, p_value numeric, p_value_low numeric, p_value_high numeric, p_unit text, p_currency text, p_derivation text, p_origin_class text, p_lifecycle text, p_admissibility text, p_base_confidence numeric, p_asserted_at timestamptz, p_half_life_days integer, p_inputs jsonb, p_computed_by text)
  RETURNS TABLE(value_id uuid, authored boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
DECLARE k text;
BEGIN
  IF jsonb_typeof(p_inputs) IS DISTINCT FROM 'array' OR jsonb_array_length(p_inputs) = 0 THEN
    RAISE EXCEPTION 'author_derived_value: inputs must name at least one input' USING ERRCODE = '22023';
  END IF;
  FOR k IN SELECT DISTINCT p_method_id || '@' || p_method_version || '/' || (r->>'table') || '/' || (r->>'pk') FROM jsonb_array_elements(p_inputs) r ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(k, 0));
  END LOOP;
  RETURN QUERY
    SELECT dv.value_id, false
      FROM public.derived_values dv
      JOIN public.derivation_edges e ON e.to_value_id = dv.value_id AND e.to_table = 'derived_values'
      JOIN jsonb_array_elements(p_inputs) r ON e.from_table = r->>'table' AND e.from_pk = r->>'pk'
     WHERE dv.method_id = p_method_id AND dv.method_version = p_method_version
     LIMIT 1;
  IF FOUND THEN RETURN; END IF;
  RETURN QUERY SELECT public.register_derived_value(p_entity_id, p_method_id, p_method_version, p_value, p_value_low, p_value_high, p_unit, p_currency, p_derivation, p_origin_class, p_lifecycle, p_admissibility, p_base_confidence, p_asserted_at, p_half_life_days, p_inputs, p_computed_by, NULL), true;
END $$;
COMMENT ON FUNCTION public.author_derived_value(text, text, text, numeric, numeric, numeric, text, text, text, text, text, text, numeric, timestamptz, integer, jsonb, text) IS 'Author a derived value once per (method, version, input): the advisory lock, the existence check and the register_derived_value call in one transaction (R2d migration 0091). Returns the value id and whether this call authored it.';
REVOKE ALL ON FUNCTION public.author_derived_value(text, text, text, numeric, numeric, numeric, text, text, text, text, text, text, numeric, timestamptz, integer, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.author_derived_value(text, text, text, numeric, numeric, numeric, text, text, text, text, text, text, numeric, timestamptz, integer, jsonb, text) TO service_role;

-- Self-check 0091-author-derived-value: the first call authors and holds an advisory lock; the second for the same (method, version, input) returns the same id and authors nothing; an input list that
-- shares one input is also the same value; another version authors again; an empty input list is refused; exactly one value per version exists; no client role can execute it.
DO $$
DECLARE
  tag text := 'selfcheck_0091'; a record; b record; c record; d record; n int; locks int; refused boolean := false;
BEGIN
  BEGIN
    SELECT * INTO a FROM public.author_derived_value(NULL, tag, '1', 1, NULL, NULL, 'x', NULL, 'calculated', 'derived', 'verified', 'calculation_ok', 0.9, now(), NULL, '[{"table":"emission_factors","pk":"f-0091"}]'::jsonb, tag);
    IF NOT a.authored THEN RAISE EXCEPTION '0091-author-derived-value: the first call did not author'; END IF;
    SELECT count(*) INTO locks FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid();
    IF locks < 1 THEN RAISE EXCEPTION '0091-author-derived-value: no advisory lock is held after authoring, so two workers are not serialised'; END IF;
    SELECT * INTO b FROM public.author_derived_value(NULL, tag, '1', 2, NULL, NULL, 'x', NULL, 'calculated', 'derived', 'verified', 'calculation_ok', 0.9, now(), NULL, '[{"table":"emission_factors","pk":"f-0091"}]'::jsonb, tag);
    IF b.authored OR b.value_id <> a.value_id THEN RAISE EXCEPTION '0091-author-derived-value: the second call authored again or returned another id'; END IF;
    SELECT * INTO c FROM public.author_derived_value(NULL, tag, '1', 3, NULL, NULL, 'x', NULL, 'calculated', 'derived', 'verified', 'calculation_ok', 0.9, now(), NULL, '[{"table":"emission_factors","pk":"g-0091"},{"table":"emission_factors","pk":"f-0091"}]'::jsonb, tag);
    IF c.authored OR c.value_id <> a.value_id THEN RAISE EXCEPTION '0091-author-derived-value: an input list sharing one input authored a second value'; END IF;
    SELECT * INTO d FROM public.author_derived_value(NULL, tag, '2', 4, NULL, NULL, 'x', NULL, 'calculated', 'derived', 'verified', 'calculation_ok', 0.9, now(), NULL, '[{"table":"emission_factors","pk":"f-0091"}]'::jsonb, tag);
    IF NOT d.authored OR d.value_id = a.value_id THEN RAISE EXCEPTION '0091-author-derived-value: another method version did not author its own value'; END IF;
    SELECT count(*) INTO n FROM public.derived_values WHERE method_id = tag;
    IF n <> 2 THEN RAISE EXCEPTION '0091-author-derived-value: % values exist, expected 2 (one per version)', n; END IF;
    BEGIN
      PERFORM 1 FROM public.author_derived_value(NULL, tag, '3', 1, NULL, NULL, 'x', NULL, 'calculated', 'derived', 'verified', 'calculation_ok', 0.9, now(), NULL, '[]'::jsonb, tag);
    EXCEPTION WHEN SQLSTATE '22023' THEN refused := true;
    END;
    IF NOT refused THEN RAISE EXCEPTION '0091-author-derived-value: an empty input list was accepted'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_function_privilege('anon', 'public.author_derived_value(text,text,text,numeric,numeric,numeric,text,text,text,text,text,text,numeric,timestamptz,integer,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.author_derived_value(text,text,text,numeric,numeric,numeric,text,text,text,text,text,text,numeric,timestamptz,integer,jsonb,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0091-author-derived-value: a client role can execute it';
  END IF;
  RAISE NOTICE '0091-author-derived-value OK';
END $$;

COMMIT;
