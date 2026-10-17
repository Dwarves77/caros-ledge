--
-- 0035 admin triage rpcs (P2-14: INV-283, INV-289 and the rejections count the console owes).
--
-- Two changes, both owed by the admin slice:
--   * resolve_pending_jurisdiction_review(review, action, resolution, actor): the item array swap and the queue stamp are ONE statement
--     sequence in one transaction, so a failed second write can no longer leave an item changed under an open row (the old route did two
--     calls and answered "item updated but resolve failed"). A missing row answers P0002 (404), a resolved row 22023 (409), a bad
--     source column or action 22023. Executable by service_role only: the caller is the admin route behind its guard, which passes the actor.
--   * admin_attention_counts() gains ingest_rejections_untriaged (the rejections tab had no count, so the issues rail could not sum it). The
--     return type changes, so the function is dropped and created; the total includes the new count. Anon no longer executes it.
-- Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION resolve_pending_jurisdiction_review; restore admin_attention_counts from the baseline.

-- catalog: function, acl

BEGIN;

CREATE FUNCTION public.resolve_pending_jurisdiction_review(p_review_id uuid, p_action text, p_resolution text, p_actor uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_row public.pending_jurisdiction_review;
  v_value text;
  v_now timestamptz := now();
BEGIN
  IF p_action NOT IN ('confirm', 'manually-classify', 'dismiss') THEN
    RAISE EXCEPTION 'action must be confirm, manually-classify or dismiss' USING ERRCODE = '22023';
  END IF;
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'an actor is required' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'manually-classify' AND coalesce(btrim(p_resolution), '') = '' THEN
    RAISE EXCEPTION 'resolution_value is required for manually-classify' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.pending_jurisdiction_review WHERE id = p_review_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'row not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'row already resolved' USING ERRCODE = '22023';
  END IF;

  v_value := CASE p_action WHEN 'confirm' THEN v_row.current_value WHEN 'manually-classify' THEN btrim(p_resolution) ELSE NULL END;

  IF p_action <> 'confirm' THEN
    IF v_row.source_column = 'jurisdictions' THEN
      UPDATE public.intelligence_items
         SET jurisdictions = ARRAY(
               SELECT DISTINCT x FROM unnest(array_remove(jurisdictions, v_row.current_value) || CASE WHEN v_value IS NULL THEN ARRAY[]::text[] ELSE ARRAY[v_value] END) AS x)
       WHERE id = v_row.intelligence_item_id;
    ELSIF v_row.source_column = 'jurisdiction_iso' THEN
      UPDATE public.intelligence_items
         SET jurisdiction_iso = ARRAY(
               SELECT DISTINCT x FROM unnest(array_remove(jurisdiction_iso, v_row.current_value) || CASE WHEN v_value IS NULL THEN ARRAY[]::text[] ELSE ARRAY[v_value] END) AS x)
       WHERE id = v_row.intelligence_item_id;
    ELSE
      RAISE EXCEPTION 'invalid source_column on row: %', v_row.source_column USING ERRCODE = '22023';
    END IF;
  END IF;

  UPDATE public.pending_jurisdiction_review
     SET resolved_at = v_now, resolved_by = p_actor, resolution_value = v_value
   WHERE id = v_row.id;

  RETURN jsonb_build_object('resolution_value', v_value, 'resolved_at', v_now);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_pending_jurisdiction_review(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_pending_jurisdiction_review(uuid, text, text, uuid) TO service_role;

DROP FUNCTION public.admin_attention_counts();

CREATE FUNCTION public.admin_attention_counts() RETURNS TABLE(provisional_sources_pending integer, staged_updates_pending integer, staged_updates_materialization_failed integer, integrity_flags_unresolved integer, platform_integrity_flags_open integer, source_attribution_mismatches integer, auto_approved_awaiting_spotcheck integer, coverage_gaps_critical integer, ingest_rejections_untriaged integer, total integer)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  WITH counts AS (
    SELECT
      (SELECT COUNT(*)::INT FROM provisional_sources
        WHERE status IN ('pending_review', 'needs_more_data')) AS provisional_sources_pending,
      (SELECT COUNT(*)::INT FROM staged_updates WHERE status = 'pending') AS staged_updates_pending,
      (SELECT COUNT(*)::INT FROM staged_updates
        WHERE status = 'approved'
          AND materialized_at IS NULL
          AND materialization_error IS NOT NULL) AS staged_updates_materialization_failed,
      (SELECT COUNT(*)::INT FROM intelligence_items
        WHERE agent_integrity_flag = TRUE
          AND agent_integrity_resolved_at IS NULL) AS integrity_flags_unresolved,
      (SELECT COUNT(*)::INT FROM integrity_flags
        WHERE status IN ('open', 'in_review')) AS platform_integrity_flags_open,
      0 AS source_attribution_mismatches,
      (SELECT COUNT(*)::INT FROM sources
        WHERE created_at > NOW() - INTERVAL '7 days'
          AND COALESCE(spotchecked, FALSE) = FALSE) AS auto_approved_awaiting_spotcheck,
      0 AS coverage_gaps_critical,
      (SELECT COUNT(*)::INT FROM ingest_rejections WHERE triaged_at IS NULL) AS ingest_rejections_untriaged
  )
  SELECT
    provisional_sources_pending,
    staged_updates_pending,
    staged_updates_materialization_failed,
    integrity_flags_unresolved,
    platform_integrity_flags_open,
    source_attribution_mismatches,
    auto_approved_awaiting_spotcheck,
    coverage_gaps_critical,
    ingest_rejections_untriaged,
    (provisional_sources_pending
     + staged_updates_pending
     + staged_updates_materialization_failed
     + integrity_flags_unresolved
     + platform_integrity_flags_open
     + source_attribution_mismatches
     + auto_approved_awaiting_spotcheck
     + coverage_gaps_critical
     + ingest_rejections_untriaged) AS total
  FROM counts;
$$;

REVOKE ALL ON FUNCTION public.admin_attention_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_attention_counts() TO authenticated, service_role;

DO $$
DECLARE
  item uuid;
  rev1 uuid;
  rev2 uuid;
  rev3 uuid;
  actor uuid;
  arr text[];
  n int;
  got jsonb;
  before_n int;
BEGIN
  IF has_function_privilege('anon', 'public.resolve_pending_jurisdiction_review(uuid,text,text,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_pending_jurisdiction_review(uuid,text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0035-admin-triage: the resolve rpc is executable by a non-service role';
  END IF;
  IF has_function_privilege('anon', 'public.admin_attention_counts()', 'EXECUTE') THEN
    RAISE EXCEPTION '0035-admin-triage: anon can read the attention counts';
  END IF;

  SELECT COUNT(*) INTO before_n FROM public.ingest_rejections WHERE triaged_at IS NULL;
  SELECT c.ingest_rejections_untriaged INTO n FROM public.admin_attention_counts() c;
  IF n IS DISTINCT FROM before_n THEN
    RAISE EXCEPTION '0035-admin-triage: attention counts say % untriaged rejections, the table says %', n, before_n;
  END IF;

  BEGIN
    SELECT id INTO actor FROM public.profiles LIMIT 1;
    SELECT id INTO item FROM public.intelligence_items LIMIT 1;
    IF actor IS NOT NULL AND item IS NOT NULL THEN
      INSERT INTO public.pending_jurisdiction_review (intelligence_item_id, current_value, flagged_reason) VALUES (item, 'ASIA', 'continent') RETURNING id INTO rev1;
      INSERT INTO public.pending_jurisdiction_review (intelligence_item_id, current_value, flagged_reason) VALUES (item, 'ASIA', 'continent') RETURNING id INTO rev2;
      INSERT INTO public.pending_jurisdiction_review (intelligence_item_id, current_value, flagged_reason) VALUES (item, 'ASIA', 'continent') RETURNING id INTO rev3;

      BEGIN PERFORM public.resolve_pending_jurisdiction_review(rev1, 'manually-classify', '  ', actor); RAISE EXCEPTION '0035-admin-triage: a blank classification resolved';
      EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
      BEGIN PERFORM public.resolve_pending_jurisdiction_review(gen_random_uuid(), 'confirm', NULL, actor); RAISE EXCEPTION '0035-admin-triage: a missing row resolved';
      EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;

      got := public.resolve_pending_jurisdiction_review(rev1, 'confirm', NULL, actor);
      IF got->>'resolution_value' IS DISTINCT FROM 'ASIA' THEN RAISE EXCEPTION '0035-admin-triage: confirm resolved to %', got; END IF;
      BEGIN PERFORM public.resolve_pending_jurisdiction_review(rev1, 'confirm', NULL, actor); RAISE EXCEPTION '0035-admin-triage: a resolved row resolved twice';
      EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

      PERFORM public.resolve_pending_jurisdiction_review(rev2, 'manually-classify', 'CN', actor);
      SELECT jurisdictions INTO arr FROM public.intelligence_items WHERE id = item;
      IF 'ASIA' = ANY (arr) OR NOT ('CN' = ANY (arr)) THEN RAISE EXCEPTION '0035-admin-triage: manually-classify left %', arr; END IF;

      PERFORM public.resolve_pending_jurisdiction_review(rev3, 'dismiss', NULL, actor);
      SELECT COUNT(*) INTO n FROM public.pending_jurisdiction_review WHERE id IN (rev1, rev2, rev3) AND resolved_at IS NOT NULL AND resolved_by = actor;
      IF n <> 3 THEN RAISE EXCEPTION '0035-admin-triage: % of 3 reviews were stamped', n; END IF;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0035-admin-triage OK';
END $$;

COMMIT;
