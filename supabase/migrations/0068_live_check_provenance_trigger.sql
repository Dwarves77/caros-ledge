-- 0068 live_check_provenance_trigger (P2-15 PART A; IMP-074's residue: the trigger is the one home of provenance status, and the apply relies on it, so the cutover proves it by attack on the live database).
--
-- live_check_provenance_trigger() plants a verified fixture item, touches it with an ordinary UPDATE (the write the grounding apply makes) and reports whether set_provenance_status_trg took it OUT of `verified` because
-- the ledger of an item with no sections and no claims cannot validate. Everything it does is inside a sub-transaction that is rolled back by a sentinel exception, so no row is left behind; the result is carried out in
-- local variables. It returns jsonb {flipped, before, after, left_behind}: a presence check would pass a disabled trigger, this reports `flipped: false` for one. Called by scripts/ci/live-checks.mjs (check
-- `provenance-trigger`) with the service key; executable by service_role only. Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.live_check_provenance_trigger().

-- catalog: function

BEGIN;

CREATE FUNCTION public.live_check_provenance_trigger() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
  AS $$
DECLARE
  it uuid; before_ text; after_ text; left_ int;
BEGIN
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('live-check provenance trigger', 1, 'verified', false) RETURNING id INTO it;
    SET LOCAL session_replication_role = origin;
    SELECT provenance_status::text INTO before_ FROM public.intelligence_items WHERE id = it;
    UPDATE public.intelligence_items SET title = 'live-check provenance trigger (touched)' WHERE id = it;
    SELECT provenance_status::text INTO after_ FROM public.intelligence_items WHERE id = it;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'live check rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  SELECT count(*) INTO left_ FROM public.intelligence_items WHERE title LIKE 'live-check provenance trigger%';
  RETURN jsonb_build_object('flipped', before_ = 'verified' AND after_ IS DISTINCT FROM 'verified', 'before', before_, 'after', after_, 'left_behind', left_);
END;
$$;
REVOKE ALL ON FUNCTION public.live_check_provenance_trigger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.live_check_provenance_trigger() TO service_role;

-- Self-check 0068-live-check-provenance: with the trigger enabled the call reports flipped true (verified before, something else after) and leaves nothing behind; THE ATTACK: with set_provenance_status_trg DISABLED the same call
-- reports flipped false (a disabled trigger is what the live check exists to catch), still leaves nothing behind, and the trigger is enabled again; anon and authenticated cannot execute the function.
DO $$
DECLARE res jsonb;
BEGIN
  res := public.live_check_provenance_trigger();
  IF NOT (res->>'flipped')::boolean OR res->>'before' <> 'verified' OR res->>'after' = 'verified' OR (res->>'left_behind')::int <> 0 THEN RAISE EXCEPTION '0068-live-check-provenance: the enabled trigger did not flip the fixture: %', res; END IF;
  ALTER TABLE public.intelligence_items DISABLE TRIGGER set_provenance_status_trg;
  res := public.live_check_provenance_trigger();
  ALTER TABLE public.intelligence_items ENABLE TRIGGER set_provenance_status_trg;
  IF (res->>'flipped')::boolean OR (res->>'left_behind')::int <> 0 THEN RAISE EXCEPTION '0068-live-check-provenance: a disabled trigger was not reported: %', res; END IF;
  IF (SELECT tgenabled FROM pg_trigger WHERE tgname = 'set_provenance_status_trg' AND tgrelid = 'public.intelligence_items'::regclass) <> 'O' THEN RAISE EXCEPTION '0068-live-check-provenance: the trigger was not re-enabled'; END IF;
  IF has_function_privilege('anon', 'public.live_check_provenance_trigger()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.live_check_provenance_trigger()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.live_check_provenance_trigger()', 'EXECUTE') THEN
    RAISE EXCEPTION '0068-live-check-provenance: unexpected EXECUTE privileges';
  END IF;
  RAISE NOTICE '0068-live-check-provenance OK';
END $$;

COMMIT;
