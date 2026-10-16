-- 0013 fire_signpost (P2-06, owed by register P1-10 flywheel-b.md section 8 "Gaps" 7: fireSignpost was three writes, not one transaction;
-- BUILD-PLAN ruling: fireSignpost becomes ONE RPC).
--
-- Before: firing a signpost stamped signposts.fired_at, then wrote the propagation event, then moved research_assessments.lifecycle_state, as three
-- separate statements from the client. A failure between them left a fired signpost whose assessment never moved (the repair pass existed for
-- exactly that). After: public.fire_signpost(entity, at, reason) does all of it in one transaction and returns what it did:
--   1. locks the signpost and its assessment (a concurrent firing waits, then sees fired_at already set and fires nothing twice);
--   2. stamps fired_at where it is NULL (a signpost fires once; a later call never moves the stamp);
--   3. writes ONE propagation event (table signposts, entity = what it watches, old_row/new_row carry fired_at, direction, predicate, reason);
--   4. moves research_assessments.lifecycle_state by the transition table below and stamps signposts.lifecycle_applied_at where it is NULL.
-- The transition table is DATA inside the function (24 rows: 8 states x 3 directions, spec 08 section 3.1 and the 2026-10-02 coordinator ruling,
-- ADR-039: refutes -> falsified, delays -> stalled, confirms advances one step toward corroborated and never auto-promotes to verified; falsified,
-- superseded and obsolete are terminal). tests/connect/propagation.test.ts compares these rows with nextLifecycleState so the two cannot drift.
-- Callable by service_role only. Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.fire_signpost(text, timestamptz, text);

-- catalog: function

BEGIN;

CREATE FUNCTION public.fire_signpost(p_entity_id text, p_at timestamptz, p_reason text DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  s public.signposts%ROWTYPE;
  v_prev text;
  v_new text;
  v_first boolean;
BEGIN
  SELECT * INTO s FROM public.signposts WHERE entity_id = p_entity_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fire_signpost: no signpost %', p_entity_id USING ERRCODE = 'P0002';
  END IF;
  SELECT lifecycle_state INTO v_prev FROM public.research_assessments WHERE id = s.assessment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fire_signpost: signpost % names assessment % which does not exist', p_entity_id, s.assessment_id USING ERRCODE = 'P0002';
  END IF;

  SELECT t.next_state INTO v_new
    FROM (VALUES
      ('emerging', 'confirms', 'strengthening'), ('emerging', 'refutes', 'falsified'), ('emerging', 'delays', 'stalled'),
      ('strengthening', 'confirms', 'corroborated'), ('strengthening', 'refutes', 'falsified'), ('strengthening', 'delays', 'stalled'),
      ('corroborated', 'confirms', 'corroborated'), ('corroborated', 'refutes', 'falsified'), ('corroborated', 'delays', 'stalled'),
      ('verified', 'confirms', 'verified'), ('verified', 'refutes', 'falsified'), ('verified', 'delays', 'stalled'),
      ('stalled', 'confirms', 'stalled'), ('stalled', 'refutes', 'falsified'), ('stalled', 'delays', 'stalled'),
      ('falsified', 'confirms', 'falsified'), ('falsified', 'refutes', 'falsified'), ('falsified', 'delays', 'falsified'),
      ('superseded', 'confirms', 'superseded'), ('superseded', 'refutes', 'superseded'), ('superseded', 'delays', 'superseded'),
      ('obsolete', 'confirms', 'obsolete'), ('obsolete', 'refutes', 'obsolete'), ('obsolete', 'delays', 'obsolete')
    ) AS t(current_state, direction, next_state)
   WHERE t.current_state = v_prev AND t.direction = s.direction;
  IF v_new IS NULL THEN
    RAISE EXCEPTION 'fire_signpost: no transition from % on %', v_prev, s.direction USING ERRCODE = '22023';
  END IF;

  v_first := s.fired_at IS NULL;
  IF v_first THEN
    UPDATE public.signposts SET fired_at = p_at WHERE entity_id = s.entity_id;
  END IF;

  INSERT INTO public.propagation_events (table_name, row_pk, entity_id, change_kind, old_row, new_row, occurred_at)
  VALUES ('signposts', s.entity_id, s.watches, 'update',
          jsonb_build_object('fired_at', s.fired_at),
          jsonb_build_object('fired_at', COALESCE(s.fired_at, p_at), 'direction', s.direction, 'predicate', s.predicate, 'reason', p_reason),
          p_at);

  UPDATE public.research_assessments SET lifecycle_state = v_new WHERE id = s.assessment_id;
  UPDATE public.signposts SET lifecycle_applied_at = COALESCE(lifecycle_applied_at, p_at) WHERE entity_id = s.entity_id;

  RETURN jsonb_build_object('fired', true, 'first_firing', v_first, 'signpost_entity_id', s.entity_id,
                            'previous_lifecycle_state', v_prev, 'new_lifecycle_state', v_new);
END $$;

REVOKE ALL ON FUNCTION public.fire_signpost(text, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fire_signpost(text, timestamptz, text) TO service_role;

COMMENT ON FUNCTION public.fire_signpost(text, timestamptz, text) IS
  'P2-06 0013. Fire one signpost in ONE transaction: stamp fired_at once, write the propagation event, move the assessment lifecycle_state by the transition table, stamp lifecycle_applied_at. See the migration header.';

-- Self-check 0013-fire-signpost: real rows, the live function, rolled back by a sentinel. Attacks: a missing signpost writes nothing; firing twice
-- stamps once and moves the lifecycle by the table both times; a refutation is terminal (a later confirmation does not revive it); a client
-- role cannot execute the function.
DO $$
DECLARE
  v_item uuid := gen_random_uuid();
  v_assess uuid := gen_random_uuid();
  r jsonb;
  v_at timestamptz := '2026-10-15T00:00:00Z';
  n int;
  v_state text;
  v_stamp timestamptz;
BEGIN
  BEGIN
    INSERT INTO public.entities (entity_id, kind, canonical_name) VALUES
      ('cl:signpost:selfcheck0013', 'signpost', 'selfcheck 0013 signpost'),
      ('cl:technology:selfcheck0013', 'technology', 'selfcheck 0013 watched');
    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0013', 7);
    INSERT INTO public.research_assessments (id, item_id, refusal_reason, computed_by, status_token)
      VALUES (v_assess, v_item, 'selfcheck 0013', 'selfcheck', 'HYPOTHESIS');
    INSERT INTO public.signposts (entity_id, assessment_id, watches, predicate, direction)
      VALUES ('cl:signpost:selfcheck0013', v_assess, 'cl:technology:selfcheck0013', '{"op":"date_passed","field":"x"}', 'confirms');

    -- attack 1: a signpost that does not exist fires nothing
    BEGIN
      PERFORM public.fire_signpost('cl:signpost:missing0013', v_at, 'selfcheck');
      RAISE EXCEPTION '0013-fire-signpost: a missing signpost fired';
    EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL;
    END;
    SELECT count(*) INTO n FROM public.propagation_events WHERE table_name = 'signposts' AND row_pk = 'cl:signpost:missing0013';
    IF n <> 0 THEN RAISE EXCEPTION '0013-fire-signpost: a missing signpost left % event(s)', n; END IF;

    -- first firing: emerging + confirms -> strengthening, stamp, one event, lifecycle_applied_at
    r := public.fire_signpost('cl:signpost:selfcheck0013', v_at, 'selfcheck');
    SELECT lifecycle_state INTO v_state FROM public.research_assessments WHERE id = v_assess;
    IF v_state <> 'strengthening' OR (r ->> 'new_lifecycle_state') <> 'strengthening' OR (r ->> 'first_firing') <> 'true' THEN
      RAISE EXCEPTION '0013-fire-signpost: first firing gave state % / %', v_state, r;
    END IF;
    SELECT fired_at, (SELECT count(*) FROM public.propagation_events WHERE table_name = 'signposts' AND row_pk = 'cl:signpost:selfcheck0013')
      INTO v_stamp, n FROM public.signposts WHERE entity_id = 'cl:signpost:selfcheck0013';
    IF v_stamp IS DISTINCT FROM v_at OR n <> 1 THEN RAISE EXCEPTION '0013-fire-signpost: stamp % / events % after the first firing', v_stamp, n; END IF;
    IF (SELECT lifecycle_applied_at FROM public.signposts WHERE entity_id = 'cl:signpost:selfcheck0013') IS DISTINCT FROM v_at THEN
      RAISE EXCEPTION '0013-fire-signpost: lifecycle_applied_at was not stamped';
    END IF;

    -- attack 2: firing again later never moves the stamp, advances by the table again
    r := public.fire_signpost('cl:signpost:selfcheck0013', v_at + interval '1 day', 'again');
    SELECT lifecycle_state INTO v_state FROM public.research_assessments WHERE id = v_assess;
    IF v_state <> 'corroborated' OR (r ->> 'first_firing') <> 'false' THEN RAISE EXCEPTION '0013-fire-signpost: second firing gave % / %', v_state, r; END IF;
    IF (SELECT fired_at FROM public.signposts WHERE entity_id = 'cl:signpost:selfcheck0013') IS DISTINCT FROM v_at THEN
      RAISE EXCEPTION '0013-fire-signpost: the second firing moved fired_at';
    END IF;

    -- attack 3: a refutation is terminal
    UPDATE public.signposts SET direction = 'refutes' WHERE entity_id = 'cl:signpost:selfcheck0013';
    PERFORM public.fire_signpost('cl:signpost:selfcheck0013', v_at + interval '2 days', 'refute');
    UPDATE public.signposts SET direction = 'confirms' WHERE entity_id = 'cl:signpost:selfcheck0013';
    PERFORM public.fire_signpost('cl:signpost:selfcheck0013', v_at + interval '3 days', 'confirm after refute');
    SELECT lifecycle_state INTO v_state FROM public.research_assessments WHERE id = v_assess;
    IF v_state <> 'falsified' THEN RAISE EXCEPTION '0013-fire-signpost: a confirmation revived a falsified assessment (%)', v_state; END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '0013-fire-signpost: rollback sentinel';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> '0013-fire-signpost: rollback sentinel' THEN RAISE; END IF;
  END;
  IF has_function_privilege('authenticated', 'public.fire_signpost(text, timestamptz, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fire_signpost(text, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0013-fire-signpost: a client role can execute fire_signpost';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fire_signpost(text, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0013-fire-signpost: service_role cannot execute fire_signpost';
  END IF;
  RAISE NOTICE '0013-fire-signpost OK';
END $$;

COMMIT;
