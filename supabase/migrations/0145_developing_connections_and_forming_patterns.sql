-- 0145 developing_connections_and_forming_patterns: a pair that nearly connects is kept as a candidate edge, and a pattern whose inputs are only partly held is kept as a forming derived value that says what is missing (ENGINE-JOIN-1, addendum B and C).
-- change: item_cross_references.origin admits candidate; derived_values.lifecycle admits forming and the table gains missing jsonb; derived_values_admissible hides forming rows
--
-- Before: a discovery pass kept an edge only at score 0.30 or more, so a pair holding most of a connection (a shared entity, a score of 0.22) was discarded and never seen again; a pattern detector either found its full pattern or left nothing, so "the ratchet is dated, the grid-queue
-- figure is absent" was not recorded anywhere a surface could say it.
-- After: origin candidate marks a developing connection (the writer upgrades it in place to provenance_discovery when a later pass scores the threshold and deletes it when a later pass no longer scores the floor; every reader of customer connections excludes it). lifecycle forming marks a
-- pattern still forming; its row carries missing {surface, truth, entity}, the surface that does not yet hold its other half in a reader's words. A forming row is not admissible: derived_values_admissible hides it, so no analysis, figure or display reads it as a value; the pattern step supersedes
-- it when the pattern appears and obsoletes it when its inputs vanish.
-- Access: unchanged (a CHECK list, a nullable column and the same view body with one more hidden lifecycle). Reversal: down/0145.sql restores the three; it fails, loudly, while a candidate edge, a forming row or a stored `missing` exists (remove or let the next pass obsolete them first).

-- catalog: constraint, column, relation

BEGIN;

ALTER TABLE public.item_cross_references DROP CONSTRAINT item_cross_references_origin_check;
ALTER TABLE public.item_cross_references ADD CONSTRAINT item_cross_references_origin_check CHECK (origin = ANY (ARRAY['manual'::text, 'agent_semantic'::text, 'entity_extraction'::text, 'provenance_discovery'::text, 'candidate'::text]));

ALTER TABLE public.derived_values DROP CONSTRAINT derived_values_lifecycle_check;
ALTER TABLE public.derived_values ADD CONSTRAINT derived_values_lifecycle_check CHECK (lifecycle = ANY (ARRAY['forming'::text, 'emerging'::text, 'strengthening'::text, 'corroborated'::text, 'verified'::text, 'stalled'::text, 'falsified'::text, 'superseded'::text, 'obsolete'::text]));
ALTER TABLE public.derived_values ADD COLUMN missing jsonb, ADD CONSTRAINT derived_values_missing_is_object CHECK (missing IS NULL OR jsonb_typeof(missing) = 'object');
COMMENT ON COLUMN public.derived_values.missing IS 'Migration 0145. For a forming pattern: {surface, truth, entity}, the surface that does not yet hold its other half (regulations, market, operations or research), what is missing in words a reader understands, and the entity it is about. Null for every other row.';

CREATE OR REPLACE VIEW public.derived_values_admissible WITH (security_invoker = on) AS
 SELECT d.value_id,
    d.entity_id,
    d.method_id,
    d.method_version,
    d.value,
    d.value_low,
    d.value_high,
    d.unit,
    d.currency,
    d.derivation,
    d.origin_class,
    d.lifecycle,
    d.admissibility,
    d.base_confidence,
    d.asserted_at,
    d.half_life_days,
    d.inputs,
    d.supersedes,
    d.computed_at,
    d.computed_by,
    d.invalidated_at,
    d.invalidated_by_event,
    public.effective_confidence(d.base_confidence, d.asserted_at, d.half_life_days, now()) AS effective_confidence,
    CASE d.admissibility WHEN 'display_only' THEN 0 WHEN 'analysis_ok' THEN 1 WHEN 'calculation_ok' THEN 2 WHEN 'filing_ok' THEN 3 END AS ceiling_rank
   FROM public.derived_values d
  WHERE d.lifecycle <> ALL (ARRAY['falsified'::text, 'obsolete'::text, 'superseded'::text, 'forming'::text]) AND d.admissibility <> 'stale'::text;

-- Self-check 0145-developing-forming: the shapes; the attacks on scratch copies of the real tables (temp tables made LIKE them, so the real CHECKs are attacked): an unknown origin and an unknown lifecycle are refused, a non-object missing is refused, candidate and forming
-- are accepted; and the view, on a rolled-back fixture, shows a verified value and hides a forming one.
DO $$
DECLARE
  tag text := 'selfcheck_0145'; n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'derived_values' AND column_name = 'missing' AND data_type = 'jsonb') THEN
    RAISE EXCEPTION '0145-developing-forming: derived_values.missing is not jsonb';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conname IN ('item_cross_references_origin_check', 'derived_values_lifecycle_check', 'derived_values_missing_is_object') AND convalidated) <> 3 THEN
    RAISE EXCEPTION '0145-developing-forming: a CHECK is missing or not validated';
  END IF;

  CREATE TEMP TABLE selfcheck_0145_edges (LIKE public.item_cross_references INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP;
  CREATE TEMP TABLE selfcheck_0145_values (LIKE public.derived_values INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP;
  BEGIN
    INSERT INTO selfcheck_0145_edges (source_item_id, target_item_id, relationship, origin) VALUES (gen_random_uuid(), gen_random_uuid(), 'related', 'speculative');
    RAISE EXCEPTION '0145-developing-forming: the origin "speculative" was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO selfcheck_0145_edges (source_item_id, target_item_id, relationship, origin, score) VALUES (gen_random_uuid(), gen_random_uuid(), 'related', 'candidate', 0.22);
  BEGIN
    INSERT INTO selfcheck_0145_values (method_id, method_version, derivation, origin_class, lifecycle, admissibility, base_confidence, asserted_at, inputs, computed_by) VALUES (tag, 'x', 'calculated', 'derived', 'budding', 'display_only', 0.5, now(), '[]'::jsonb, tag);
    RAISE EXCEPTION '0145-developing-forming: the lifecycle "budding" was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO selfcheck_0145_values (method_id, method_version, derivation, origin_class, lifecycle, admissibility, base_confidence, asserted_at, inputs, computed_by, missing) VALUES (tag, 'x', 'calculated', 'derived', 'forming', 'display_only', 0.5, now(), '[]'::jsonb, tag, '["a"]'::jsonb);
    RAISE EXCEPTION '0145-developing-forming: a non-object missing was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO selfcheck_0145_values (method_id, method_version, derivation, origin_class, lifecycle, admissibility, base_confidence, asserted_at, inputs, computed_by, missing)
  VALUES (tag, 'x', 'calculated', 'derived', 'forming', 'display_only', 0.5, now(), '[]'::jsonb, tag, '{"surface":"operations","truth":"a grid figure","entity":"e"}'::jsonb);
  DROP TABLE selfcheck_0145_edges;
  DROP TABLE selfcheck_0145_values;

  BEGIN
    INSERT INTO public.derived_values (method_id, method_version, value, derivation, origin_class, lifecycle, admissibility, base_confidence, asserted_at, inputs, computed_by) VALUES
      (tag, 'live', 1, 'calculated', 'derived', 'emerging', 'display_only', 0.5, now(), '[]'::jsonb, tag);
    INSERT INTO public.derived_values (method_id, method_version, derivation, origin_class, lifecycle, admissibility, base_confidence, asserted_at, inputs, computed_by, missing) VALUES
      (tag, 'forming', 'calculated', 'derived', 'forming', 'display_only', 0.5, now(), '[]'::jsonb, tag, '{"surface":"market","truth":"a price series","entity":"e"}'::jsonb);
    SELECT count(*) INTO n FROM public.derived_values_admissible WHERE method_id = tag;
    IF n <> 1 OR EXISTS (SELECT 1 FROM public.derived_values_admissible WHERE method_id = tag AND method_version = 'forming') THEN
      RAISE EXCEPTION '0145-developing-forming: the admissible view holds % row(s) of the fixture, expected only the live one (a forming row is hidden)', n;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0145-developing-forming OK';
END
$$;

COMMIT;
