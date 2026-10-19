-- 0069 live_check_provenance_no_replica (P2-15k; replaces the body of 0068's live_check_provenance_trigger(), which production refuses).
--
-- 0068 planted its fixture under `SET LOCAL session_replication_role = replica`. Through PostgREST that statement fails with 42501 `permission denied to set parameter "session_replication_role"`: supautils lists the
-- parameter in supautils.privileged_role_allowed_configs, which only members of supabase_privileged_role may set, and the session role of an API call is authenticator, not a member, so a SECURITY DEFINER function owned by
-- postgres cannot set it. (A direct postgres connection can, which is why 0068's self-check passed.) The trigger offers no bypass to plant through instead: set_provenance_status_trg is AFTER INSERT OR UPDATE WHEN
-- pg_trigger_depth() = 0 and recomputes the status on every top-level insert, and guard_provenance_flip admits a transition INTO verified only for the reconciler role or at trigger depth >= 2.
--
-- This body plants the fixture with set_provenance_status_trg DISABLED for the one INSERT (ALTER TABLE ... DISABLE TRIGGER is a table-owner privilege, held by the definer, not a restricted parameter), under
-- lock_timeout 2s so a live check can never hold production writers for more than two seconds (a timeout is a reported failure, never a hang). The trigger's state before the call is read first and restored
-- before the touch: a trigger that was ALREADY disabled stays disabled, the touch leaves the fixture verified and the check reports flipped false (a blanket ENABLE here would mask exactly the fault the check exists to catch).
-- The sub-transaction is rolled back by a sentinel exception, which also reverts the DISABLE/ENABLE (catalog changes are transactional), so no other session ever sees the trigger off and no row is left behind.
-- Returns jsonb {flipped, before, after, left_behind, trigger_enabled}. Same signature and grants as 0068.
--
-- Reversal: re-run the body of 0068_live_check_provenance_trigger.sql as CREATE OR REPLACE.

-- catalog: function

BEGIN;

CREATE OR REPLACE FUNCTION public.live_check_provenance_trigger() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
  AS $$
DECLARE
  it uuid; before_ text; after_ text; left_ int; state_ "char";
BEGIN
  SELECT tgenabled INTO state_ FROM pg_trigger WHERE tgname = 'set_provenance_status_trg' AND tgrelid = 'public.intelligence_items'::regclass;
  IF state_ IS NULL THEN
    RETURN jsonb_build_object('flipped', false, 'before', NULL, 'after', NULL, 'left_behind', 0, 'trigger_enabled', NULL);
  END IF;
  BEGIN
    SET LOCAL lock_timeout = '2s';
    ALTER TABLE public.intelligence_items DISABLE TRIGGER set_provenance_status_trg;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('live-check provenance trigger', 1, 'verified', false) RETURNING id INTO it;
    IF state_ = 'O' THEN
      ALTER TABLE public.intelligence_items ENABLE TRIGGER set_provenance_status_trg;
    END IF;
    SELECT provenance_status::text INTO before_ FROM public.intelligence_items WHERE id = it;
    UPDATE public.intelligence_items SET title = 'live-check provenance trigger (touched)' WHERE id = it;
    SELECT provenance_status::text INTO after_ FROM public.intelligence_items WHERE id = it;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'live check rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  SELECT count(*) INTO left_ FROM public.intelligence_items WHERE title LIKE 'live-check provenance trigger%';
  RETURN jsonb_build_object('flipped', before_ = 'verified' AND after_ IS DISTINCT FROM 'verified', 'before', before_, 'after', after_, 'left_behind', left_, 'trigger_enabled', state_ = 'O');
END;
$$;
REVOKE ALL ON FUNCTION public.live_check_provenance_trigger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.live_check_provenance_trigger() TO service_role;

-- Self-check 0069-live-check-no-replica: with the trigger enabled the call reports flipped true (verified before, something else after), leaves nothing behind and leaves the trigger enabled; THE ATTACK: with
-- set_provenance_status_trg DISABLED the same call reports flipped false and trigger_enabled false (it must not re-enable what it found off), leaves nothing behind, and leaves the trigger in the disabled state it was
-- given (then it is enabled again); the call also runs as service_role, the production caller; anon and authenticated cannot execute the function.
DO $$
DECLARE res jsonb;
BEGIN
  res := public.live_check_provenance_trigger();
  IF NOT (res->>'flipped')::boolean OR res->>'before' <> 'verified' OR res->>'after' = 'verified' OR (res->>'left_behind')::int <> 0 OR NOT (res->>'trigger_enabled')::boolean THEN RAISE EXCEPTION '0069-live-check-no-replica: the enabled trigger did not flip the fixture: %', res; END IF;
  IF (SELECT tgenabled FROM pg_trigger WHERE tgname = 'set_provenance_status_trg' AND tgrelid = 'public.intelligence_items'::regclass) <> 'O' THEN RAISE EXCEPTION '0069-live-check-no-replica: the call left the trigger not enabled'; END IF;
  ALTER TABLE public.intelligence_items DISABLE TRIGGER set_provenance_status_trg;
  res := public.live_check_provenance_trigger();
  IF (SELECT tgenabled FROM pg_trigger WHERE tgname = 'set_provenance_status_trg' AND tgrelid = 'public.intelligence_items'::regclass) <> 'D' THEN RAISE EXCEPTION '0069-live-check-no-replica: the call changed the state of a disabled trigger'; END IF;
  ALTER TABLE public.intelligence_items ENABLE TRIGGER set_provenance_status_trg;
  IF (res->>'flipped')::boolean OR (res->>'trigger_enabled')::boolean OR (res->>'left_behind')::int <> 0 THEN RAISE EXCEPTION '0069-live-check-no-replica: a disabled trigger was not reported: %', res; END IF;
  SET LOCAL ROLE service_role;
  res := public.live_check_provenance_trigger();
  RESET ROLE;
  IF NOT (res->>'flipped')::boolean OR (res->>'left_behind')::int <> 0 THEN RAISE EXCEPTION '0069-live-check-no-replica: the call as service_role did not flip the fixture: %', res; END IF;
  IF has_function_privilege('anon', 'public.live_check_provenance_trigger()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.live_check_provenance_trigger()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.live_check_provenance_trigger()', 'EXECUTE') THEN
    RAISE EXCEPTION '0069-live-check-no-replica: unexpected EXECUTE privileges';
  END IF;
  RAISE NOTICE '0069-live-check-no-replica OK';
END $$;

COMMIT;
