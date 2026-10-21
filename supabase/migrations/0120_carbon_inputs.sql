-- 0120 carbon_inputs: where the propagate stage records each input of the carbon cost per FEU and the cost itself (CARBON-1).
--
-- The carbon cost of a forty-foot container on a corridor is distance x intensity x payload x price. Each of the five is a derived value (derived_values: method id and version, admissibility, lifecycle, the inputs it was computed from), written by the
-- propagate stage through the registered methods carbon_price_eur_t, corridor_distance_km, feu_payload_tonnes, carbon_intensity_tkm and carbon_cost_per_feu. This table is the current state of each: `scope` says what the value is for (a corridor entity id for its
-- distance and cost, 'market' for the allowance price and the payload default, 'mode:<mode>' for the emission intensity of a transport mode), `input` which of the five it is. A row either points at the current derived value (value_id) or states why there is
-- none (absent_reason, one sentence naming the missing input and the producer's search); never both, never neither. `basis` records what the value rests on in words ("great-circle, not routed"; the series and its date); source_tier is the rating of the
-- published source behind it (NULL for a value computed from code data). The page reads this table and the value it points at; an absent row draws its reason in the slot of the figure, so a gap stays visible where the figure goes.
-- Access: RLS on. authenticated reads every row (the values are corpus-level, like derived_values); service_role writes. anon: nothing.
--
-- Reversal: down/0120.sql drops the table.

-- catalog: column, relation, constraint, index, policy, acl

BEGIN;

CREATE TABLE public.carbon_inputs (
  scope text NOT NULL,
  input text NOT NULL,
  value_id uuid,
  absent_reason text,
  basis text NOT NULL,
  source_tier integer,
  method_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carbon_inputs_input_check CHECK (input IN ('price', 'distance', 'payload', 'intensity', 'cost')),
  CONSTRAINT carbon_inputs_state_check CHECK ((value_id IS NULL) = (absent_reason IS NOT NULL)),
  CONSTRAINT carbon_inputs_text_check CHECK (length(btrim(scope)) > 0 AND length(btrim(basis)) > 0 AND length(btrim(method_version)) > 0 AND (absent_reason IS NULL OR length(btrim(absent_reason)) > 0)),
  CONSTRAINT carbon_inputs_tier_check CHECK (source_tier IS NULL OR source_tier BETWEEN 1 AND 7)
);
ALTER TABLE public.carbon_inputs
  ADD CONSTRAINT carbon_inputs_pkey PRIMARY KEY (scope, input),
  ADD CONSTRAINT carbon_inputs_value_id_fkey FOREIGN KEY (value_id) REFERENCES public.derived_values(value_id);
CREATE INDEX carbon_inputs_value_id_idx ON public.carbon_inputs (value_id);

COMMENT ON TABLE public.carbon_inputs IS 'The current state of each input of the carbon cost per FEU and of the cost: the derived value it points at, or the sentence saying why there is none (CARBON-1 migration 0120). Written by the propagate stage; read by the Market page.';

ALTER TABLE public.carbon_inputs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.carbon_inputs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.carbon_inputs TO authenticated;
GRANT ALL ON TABLE public.carbon_inputs TO service_role;
CREATE POLICY carbon_inputs_read ON public.carbon_inputs FOR SELECT TO authenticated USING (true);

-- Self-check 0120-carbon-inputs: shape, key and access, and attacks: a row with a value and a reason, a row with neither, an input outside the five, a blank basis, a tier outside 1..7 and a pointer to a value that does not exist are refused;
-- an authenticated session reads the rows and cannot write; an anon session reads nothing.
DO $$
DECLARE v_value uuid := gen_random_uuid(); n int;
BEGIN
  IF (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'carbon_inputs') <> 'absent_reason,basis,computed_at,input,method_version,scope,source_tier,value_id' THEN
    RAISE EXCEPTION '0120-carbon-inputs: unexpected columns';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'carbon_inputs_pkey') <> 'PRIMARY KEY (scope, input)' THEN
    RAISE EXCEPTION '0120-carbon-inputs: the primary key is not (scope, input)';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.carbon_inputs'::regclass) THEN
    RAISE EXCEPTION '0120-carbon-inputs: RLS is off';
  END IF;
  IF has_table_privilege('anon', 'public.carbon_inputs', 'SELECT') OR has_table_privilege('authenticated', 'public.carbon_inputs', 'INSERT')
     OR has_table_privilege('authenticated', 'public.carbon_inputs', 'UPDATE') OR has_table_privilege('authenticated', 'public.carbon_inputs', 'DELETE') THEN
    RAISE EXCEPTION '0120-carbon-inputs: anon reads or authenticated writes';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.carbon_inputs', 'INSERT') OR NOT has_table_privilege('authenticated', 'public.carbon_inputs', 'SELECT') THEN
    RAISE EXCEPTION '0120-carbon-inputs: service_role cannot write or authenticated cannot read';
  END IF;
  BEGIN
    INSERT INTO public.derived_values (value_id, method_id, method_version, value, unit, derivation, origin_class, lifecycle, admissibility, base_confidence, asserted_at, inputs, computed_at, computed_by)
      VALUES (v_value, 'selfcheck_0120', '1.0.0', 1, 'EUR/FEU', 'calculated', 'derived', 'verified', 'display_only', 0.5, now(), '[]'::jsonb, now(), 'selfcheck-0120');
    INSERT INTO public.carbon_inputs (scope, input, value_id, basis, method_version) VALUES ('selfcheck-0120', 'cost', v_value, 'a basis', 'carbon_cost_per_feu@1.0.0');
    INSERT INTO public.carbon_inputs (scope, input, absent_reason, basis, method_version) VALUES ('selfcheck-0120', 'price', 'no ETS price series captured', 'latest observation of the allowance series', 'carbon_price_eur_t@1.0.0');
    BEGIN
      INSERT INTO public.carbon_inputs (scope, input, value_id, absent_reason, basis, method_version) VALUES ('selfcheck-0120', 'distance', v_value, 'both', 'a basis', 'x@1');
      RAISE EXCEPTION '0120-carbon-inputs: a row with a value and a reason was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.carbon_inputs (scope, input, basis, method_version) VALUES ('selfcheck-0120', 'distance', 'a basis', 'x@1');
      RAISE EXCEPTION '0120-carbon-inputs: a row with neither a value nor a reason was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.carbon_inputs (scope, input, absent_reason, basis, method_version) VALUES ('selfcheck-0120', 'tonnage', 'x', 'a basis', 'x@1');
      RAISE EXCEPTION '0120-carbon-inputs: an input outside the five was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.carbon_inputs (scope, input, absent_reason, basis, method_version) VALUES ('selfcheck-0120', 'payload', 'x', '  ', 'x@1');
      RAISE EXCEPTION '0120-carbon-inputs: a blank basis was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.carbon_inputs (scope, input, absent_reason, basis, source_tier, method_version) VALUES ('selfcheck-0120', 'intensity', 'x', 'a basis', 9, 'x@1');
      RAISE EXCEPTION '0120-carbon-inputs: a tier of 9 was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.carbon_inputs (scope, input, value_id, basis, method_version) VALUES ('selfcheck-0120', 'intensity', gen_random_uuid(), 'a basis', 'x@1');
      RAISE EXCEPTION '0120-carbon-inputs: a pointer to a value that does not exist was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO n FROM public.carbon_inputs WHERE scope = 'selfcheck-0120';
    IF n <> 2 THEN RESET ROLE; RAISE EXCEPTION '0120-carbon-inputs: an authenticated session read % rows, expected 2', n; END IF;
    BEGIN
      UPDATE public.carbon_inputs SET basis = 'changed' WHERE scope = 'selfcheck-0120';
      RESET ROLE;
      RAISE EXCEPTION '0120-carbon-inputs: an authenticated session wrote a row';
    EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
    END;
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM count(*) FROM public.carbon_inputs;
      RESET ROLE;
      RAISE EXCEPTION '0120-carbon-inputs: an anon session read the table';
    EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
    END;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0120-carbon-inputs OK';
END $$;

COMMIT;
