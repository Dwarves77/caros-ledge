-- 0112 item_impact_scores: the stored impact of an item on three of its four dimensions (IMPACT-1).
--
-- Written by the propagate stage for every verified item whose inputs changed since computed_at (and every item on the first run), by the method impact_scores@<method_version> (src/core/propagation/methods.ts): compliance from the item's current
-- obligation objects, cost from its figures, operational from its modes, scenario tags and duty holders. Each dimension is 0 to 3, or NULL when the item's input for it has not been read yet; a NULL dimension is never a 0, and `missing` names the
-- absent input of every NULL dimension (obligations, cost, operational), so a list row says what it is waiting for. The fourth dimension (client) is read-time and workspace-relative and is never stored. `basis` records what each dimension was computed
-- from (obligation ids, the column or computation of a figure, the tags and modes).
-- Columns: item_id uuid primary key referencing intelligence_items(id) ON DELETE CASCADE; cost, compliance, operational integer 0..3 or NULL; basis jsonb object; missing text[] (a subset of obligations, cost, operational); method_version; computed_at.
-- CHECK: a dimension is NULL exactly when its input is in missing.
-- Access: RLS on. authenticated reads every row (a score is derived from items a member may read); service_role writes. anon: nothing.
--
-- Reversal: down/0112.sql drops the table.

-- catalog: column, relation, constraint, index, policy, acl

BEGIN;

CREATE TABLE public.item_impact_scores (
  item_id uuid NOT NULL,
  cost integer,
  compliance integer,
  operational integer,
  basis jsonb NOT NULL,
  missing text[] NOT NULL DEFAULT '{}'::text[],
  method_version text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT item_impact_scores_range_check CHECK ((cost IS NULL OR cost BETWEEN 0 AND 3) AND (compliance IS NULL OR compliance BETWEEN 0 AND 3) AND (operational IS NULL OR operational BETWEEN 0 AND 3)),
  CONSTRAINT item_impact_scores_basis_check CHECK (jsonb_typeof(basis) = 'object'),
  CONSTRAINT item_impact_scores_missing_vocabulary_check CHECK (missing <@ ARRAY['obligations', 'cost', 'operational']::text[]),
  CONSTRAINT item_impact_scores_null_names_input_check CHECK (
    (cost IS NULL) = ('cost' = ANY (missing)) AND (compliance IS NULL) = ('obligations' = ANY (missing)) AND (operational IS NULL) = ('operational' = ANY (missing))
  ),
  CONSTRAINT item_impact_scores_method_check CHECK (length(btrim(method_version)) > 0)
);

ALTER TABLE public.item_impact_scores
  ADD CONSTRAINT item_impact_scores_pkey PRIMARY KEY (item_id),
  ADD CONSTRAINT item_impact_scores_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;

COMMENT ON TABLE public.item_impact_scores IS 'The stored impact scores of an item (cost, compliance, operational; client is read-time and workspace-relative), one row per item, written by the propagate stage with impact_scores@method_version (IMPACT-1 migration 0112). A NULL dimension is an input not read yet and is named in missing; it is never a zero.';

ALTER TABLE public.item_impact_scores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.item_impact_scores FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.item_impact_scores TO authenticated;
GRANT ALL ON TABLE public.item_impact_scores TO service_role;
CREATE POLICY item_impact_scores_read ON public.item_impact_scores FOR SELECT TO authenticated USING (true);

-- Self-check 0112-impact-scores: shape, key, cascade, access, and attacks: a dimension outside 0..3, a NULL dimension that names no missing input, a missing input whose dimension holds a value, an input outside the vocabulary and a non-object basis are refused;
-- an authenticated session reads the row and cannot write; an anon session reads nothing; deleting the item deletes the row.
DO $$
DECLARE v_item uuid := gen_random_uuid(); n int;
BEGIN
  IF (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'item_impact_scores') <> 'basis,compliance,computed_at,cost,item_id,method_version,missing,operational' THEN
    RAISE EXCEPTION '0112-impact-scores: unexpected columns';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'item_impact_scores_pkey') <> 'PRIMARY KEY (item_id)' THEN
    RAISE EXCEPTION '0112-impact-scores: the primary key is not (item_id)';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.item_impact_scores'::regclass) THEN
    RAISE EXCEPTION '0112-impact-scores: RLS is off';
  END IF;
  IF has_table_privilege('anon', 'public.item_impact_scores', 'SELECT') OR has_table_privilege('authenticated', 'public.item_impact_scores', 'INSERT')
     OR has_table_privilege('authenticated', 'public.item_impact_scores', 'UPDATE') OR has_table_privilege('authenticated', 'public.item_impact_scores', 'DELETE') THEN
    RAISE EXCEPTION '0112-impact-scores: anon reads or authenticated writes';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.item_impact_scores', 'INSERT') OR NOT has_table_privilege('authenticated', 'public.item_impact_scores', 'SELECT') THEN
    RAISE EXCEPTION '0112-impact-scores: service_role cannot write or authenticated cannot read';
  END IF;
  IF (SELECT confdeltype FROM pg_constraint WHERE conname = 'item_impact_scores_item_id_fkey') <> 'c' THEN
    RAISE EXCEPTION '0112-impact-scores: the item FK does not cascade';
  END IF;
  BEGIN
    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0112', 1);
    INSERT INTO public.item_impact_scores (item_id, cost, compliance, operational, basis, missing, method_version) VALUES (v_item, 0, 3, NULL, '{}'::jsonb, ARRAY['operational'], 'impact_scores@1.0.0');
    BEGIN
      UPDATE public.item_impact_scores SET cost = 4 WHERE item_id = v_item;
      RAISE EXCEPTION '0112-impact-scores: a dimension of 4 was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      UPDATE public.item_impact_scores SET compliance = NULL WHERE item_id = v_item;
      RAISE EXCEPTION '0112-impact-scores: a NULL dimension that names no missing input was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      UPDATE public.item_impact_scores SET missing = ARRAY['operational', 'cost'] WHERE item_id = v_item;
      RAISE EXCEPTION '0112-impact-scores: a missing input whose dimension holds a value was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      UPDATE public.item_impact_scores SET missing = ARRAY['client'] WHERE item_id = v_item;
      RAISE EXCEPTION '0112-impact-scores: a missing input outside the vocabulary was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      UPDATE public.item_impact_scores SET basis = '[]'::jsonb WHERE item_id = v_item;
      RAISE EXCEPTION '0112-impact-scores: a basis that is not an object was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO n FROM public.item_impact_scores WHERE item_id = v_item;
    IF n <> 1 THEN RESET ROLE; RAISE EXCEPTION '0112-impact-scores: an authenticated session read % rows, expected 1', n; END IF;
    BEGIN
      UPDATE public.item_impact_scores SET cost = 3 WHERE item_id = v_item;
      RESET ROLE;
      RAISE EXCEPTION '0112-impact-scores: an authenticated session wrote a score';
    EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
    END;
    SET LOCAL ROLE anon;
    BEGIN
      PERFORM count(*) FROM public.item_impact_scores;
      RESET ROLE;
      RAISE EXCEPTION '0112-impact-scores: an anon session read the table';
    EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
    END;
    DELETE FROM public.intelligence_items WHERE id = v_item;
    SELECT count(*) INTO n FROM public.item_impact_scores WHERE item_id = v_item;
    IF n <> 0 THEN RAISE EXCEPTION '0112-impact-scores: deleting the item left its score row'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0112-impact-scores OK';
END $$;

COMMIT;
