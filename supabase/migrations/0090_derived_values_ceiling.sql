-- 0090 the derivation ceiling in the database (R2d, MASTER I14, register flywheel:6).
--
-- The code gate (src/core/propagation/admissible.ts) refuses a use above the ceiling the value stored (display < analysis < calculation < filing) and refuses a superseded value; the view that was the
-- second enforcement point had the same hole: it hid stale, falsified and obsolete rows and admitted a display_only superseded value to any caller, whatever it meant to do with it. After this file:
--   * derived_values_admissible hides a superseded value as well, and carries `ceiling_rank` (0 display_only .. 3 filing_ok; NULL for a value whose ceiling is not one of the four, which no use admits).
--   * derived_values_for_use(p_use) returns the admissible rows whose ceiling reaches the use, for 'display', 'analysis', 'calculation' or 'filing'; any other use is an error, never an empty answer.
-- Reversal: restore the view body of schema.sql (without ceiling_rank and the superseded test); DROP FUNCTION public.derived_values_for_use(text).
-- Not applied to production before the cutover window.

-- catalog: relation, column, function

BEGIN;

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
  WHERE d.lifecycle <> ALL (ARRAY['falsified'::text, 'obsolete'::text, 'superseded'::text]) AND d.admissibility <> 'stale'::text;

COMMENT ON VIEW public.derived_values_admissible IS 'Spec 08 §3.3''s second enforcement point: the derived values that are live (not falsified, obsolete or superseded) and not stale, with effective_confidence pre-computed and ceiling_rank (0 display_only .. 3 filing_ok) so a caller reads the use ceiling in SQL (R2d migration 0090; derived_values_for_use(p_use) applies it). Runs with the caller''s rights (security_invoker).';

CREATE FUNCTION public.derived_values_for_use(p_use text) RETURNS SETOF public.derived_values_admissible
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp
  AS $$
DECLARE needed int := CASE p_use WHEN 'display' THEN 0 WHEN 'analysis' THEN 1 WHEN 'calculation' THEN 2 WHEN 'filing' THEN 3 END;
BEGIN
  IF needed IS NULL THEN RAISE EXCEPTION 'derived_values_for_use: % is not a use (display, analysis, calculation, filing)', p_use USING ERRCODE = '22023'; END IF;
  RETURN QUERY SELECT v.* FROM public.derived_values_admissible v WHERE v.ceiling_rank >= needed;
END $$;
COMMENT ON FUNCTION public.derived_values_for_use(text) IS 'The admissible derived values whose stored ceiling reaches the use (R2d migration 0090): the SQL twin of admissibleFor in src/core/propagation/admissible.ts. Invoker rights: the caller''s RLS applies.';
REVOKE ALL ON FUNCTION public.derived_values_for_use(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.derived_values_for_use(text) TO authenticated, service_role;

-- Self-check 0090-derived-values-ceiling: one value per (ceiling, lifecycle) cell that matters. A superseded display_only value is in neither the view nor any use; a display_only value serves display only; a
-- calculation_ok value serves calculation and below but not filing; a filing_ok value serves every use; an unknown use is an error; anon holds no execute right.
DO $$
DECLARE
  tag text := 'selfcheck_0090'; n int; failed boolean;
BEGIN
  BEGIN
    INSERT INTO public.derived_values (method_id, method_version, value, derivation, origin_class, lifecycle, admissibility, base_confidence, asserted_at, inputs, computed_at, computed_by) VALUES
      (tag, 'sup-display', 1, 'calculated', 'derived', 'superseded', 'display_only', 0.99, now(), '[]'::jsonb, now(), tag),
      (tag, 'ok-display', 1, 'calculated', 'derived', 'verified', 'display_only', 0.99, now(), '[]'::jsonb, now(), tag),
      (tag, 'ok-calc', 1, 'calculated', 'derived', 'verified', 'calculation_ok', 0.99, now(), '[]'::jsonb, now(), tag),
      (tag, 'ok-filing', 1, 'calculated', 'derived', 'verified', 'filing_ok', 0.99, now(), '[]'::jsonb, now(), tag);
    SELECT count(*) INTO n FROM public.derived_values_admissible WHERE method_id = tag;
    IF n <> 3 THEN RAISE EXCEPTION '0090-derived-values-ceiling: the view holds % rows of the fixture, expected 3 (the superseded one hidden)', n; END IF;
    IF EXISTS (SELECT 1 FROM public.derived_values_admissible WHERE method_id = tag AND method_version = 'sup-display') THEN RAISE EXCEPTION '0090-derived-values-ceiling: the view shows a superseded value'; END IF;
    SELECT count(*) INTO n FROM public.derived_values_for_use('display') WHERE method_id = tag;
    IF n <> 3 THEN RAISE EXCEPTION '0090-derived-values-ceiling: display serves % of the fixture, expected 3', n; END IF;
    SELECT count(*) INTO n FROM public.derived_values_for_use('analysis') WHERE method_id = tag;
    IF n <> 2 THEN RAISE EXCEPTION '0090-derived-values-ceiling: analysis serves %, expected 2 (display_only is below it)', n; END IF;
    SELECT count(*) INTO n FROM public.derived_values_for_use('calculation') WHERE method_id = tag;
    IF n <> 2 THEN RAISE EXCEPTION '0090-derived-values-ceiling: calculation serves %, expected 2', n; END IF;
    SELECT count(*) INTO n FROM public.derived_values_for_use('filing') WHERE method_id = tag;
    IF n <> 1 OR NOT EXISTS (SELECT 1 FROM public.derived_values_for_use('filing') WHERE method_id = tag AND method_version = 'ok-filing') THEN RAISE EXCEPTION '0090-derived-values-ceiling: filing serves % rows, expected only the filing_ok one', n; END IF;
    failed := false;
    BEGIN
      PERFORM 1 FROM public.derived_values_for_use('everything') WHERE method_id = tag;
    EXCEPTION WHEN SQLSTATE '22023' THEN failed := true;
    END;
    IF NOT failed THEN RAISE EXCEPTION '0090-derived-values-ceiling: an unknown use did not raise'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_function_privilege('anon', 'public.derived_values_for_use(text)', 'EXECUTE') THEN RAISE EXCEPTION '0090-derived-values-ceiling: anon can execute derived_values_for_use'; END IF;
  RAISE NOTICE '0090-derived-values-ceiling OK';
END $$;

COMMIT;
