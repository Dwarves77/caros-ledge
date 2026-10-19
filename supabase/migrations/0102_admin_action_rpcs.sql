-- 0102 admin actions with a reason and an event in one transaction (R2e M2; register rows W:36, W:38, W:40, W:43; INV-R2e-2).
--
-- Pause a source, hide it from workspaces, move a platform flag, resolve a brief flag, triage a rejection or a jurisdiction row, engage the emergency stop or change the hold, and ask for a re-ground of the whole live corpus were
-- one click, no reason, no record (the brief-flag resolve wrote its audit row as a second statement that could fail after the change). Each is now ONE SECURITY DEFINER function: the caller must be a platform admin by
-- is_platform_admin() (the route is the first wall, this is the second), a reason of the operator's own is required (22023), the change and its admin_events row (0100) are one transaction. The actor is auth.uid(); the routes call
-- these on the admin's own client, so no actor argument can be forged by a caller that is not already a platform admin.
--   admin_set_source_switch(source, switch, value, reason)         processing_paused or admin_only
--   admin_set_flag_status(flag, status, reason)                    an integrity_flags row to open, in_review, resolved or archived; a terminal status stamps who and when and keeps the reason as the resolution note
--   admin_resolve_brief_flag(item, action, new_url, reason)        mark_resolved or replace_url on an item's integrity flag (the old extra integrity_flags audit row is the event now)
--   admin_triage_rejection(id, action, reason)                     discarded, reclassified or escalated, once
--   admin_resolve_jurisdiction_review(id, action, resolution, reason)   resolve_pending_jurisdiction_review (0035) and the event in one call
--   admin_set_hold(paused, cadence, start_date, clear_start, judgement_drain, reason)   the emergency stop and the cadence/drain switches through their two sanctioned writers, with the event
--   admin_corpus_turn_preview(scope, source) and admin_request_corpus_turns(scope, source, item, reason)   the count before the click and the request rows with the event (scope all, source or item)
-- Not applied to production before the cutover window.
--
-- Reversal: DROP the nine functions below.

-- catalog: function

BEGIN;

CREATE FUNCTION public.admin_require(p_reason text) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin() THEN RAISE EXCEPTION 'platform admin access required' USING ERRCODE = '42501'; END IF;
  IF v_reason IS NULL THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023'; END IF;
  IF length(v_reason) > 2000 THEN RAISE EXCEPTION 'the reason is at most 2000 characters' USING ERRCODE = '22023'; END IF;
  RETURN v_reason;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_require(text) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.admin_set_source_switch(p_source_id uuid, p_switch text, p_value boolean, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_reason text := public.admin_require(p_reason); v_before boolean;
BEGIN
  IF p_switch IS NULL OR p_switch NOT IN ('processing_paused', 'admin_only') OR p_value IS NULL THEN RAISE EXCEPTION 'the switch is processing_paused or admin_only, set to true or false' USING ERRCODE = '22023'; END IF;
  IF p_switch = 'processing_paused' THEN
    SELECT processing_paused INTO v_before FROM public.sources WHERE id = p_source_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source not found' USING ERRCODE = 'P0002'; END IF;
    UPDATE public.sources SET processing_paused = p_value WHERE id = p_source_id;
  ELSE
    SELECT admin_only INTO v_before FROM public.sources WHERE id = p_source_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'source not found' USING ERRCODE = 'P0002'; END IF;
    UPDATE public.sources SET admin_only = p_value WHERE id = p_source_id;
  END IF;
  PERFORM public.record_admin_event(NULL, 'source_switch_set', 'source', p_source_id::text, v_reason, jsonb_build_object('switch', p_switch, 'from', v_before, 'to', p_value));
  RETURN jsonb_build_object('source_id', p_source_id, 'switch', p_switch, 'value', p_value);
END;
$$;

CREATE FUNCTION public.admin_set_flag_status(p_flag_id uuid, p_status text, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_reason text := public.admin_require(p_reason); f public.integrity_flags; v_before text; v_terminal boolean := p_status IN ('resolved', 'archived');
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('open', 'in_review', 'resolved', 'archived') THEN RAISE EXCEPTION 'the status is open, in_review, resolved or archived' USING ERRCODE = '22023'; END IF;
  SELECT status INTO v_before FROM public.integrity_flags WHERE id = p_flag_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'flag not found' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.integrity_flags SET status = p_status, resolved_at = CASE WHEN v_terminal THEN now() END, resolved_by = CASE WHEN v_terminal THEN auth.uid()::text END,
    resolution_note = CASE WHEN v_terminal THEN v_reason ELSE resolution_note END
   WHERE id = p_flag_id RETURNING * INTO f;
  PERFORM public.record_admin_event(NULL, 'flag_status_set', 'integrity_flag', p_flag_id::text, v_reason, jsonb_build_object('from', v_before, 'to', p_status));
  RETURN to_jsonb(f);
END;
$$;

CREATE FUNCTION public.admin_resolve_brief_flag(p_item_id uuid, p_action text, p_new_url text, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_reason text := public.admin_require(p_reason); i public.intelligence_items; v_at timestamptz := now();
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('replace_url', 'mark_resolved') THEN RAISE EXCEPTION 'the action is replace_url or mark_resolved' USING ERRCODE = '22023'; END IF;
  IF p_action = 'replace_url' AND (p_new_url IS NULL OR p_new_url !~* '^https?://[^[:space:]]+$') THEN RAISE EXCEPTION 'a replacement address must be an http or https address' USING ERRCODE = '22023'; END IF;
  SELECT * INTO i FROM public.intelligence_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT coalesce(i.agent_integrity_flag, false) THEN RAISE EXCEPTION 'item is not flagged; nothing to resolve' USING ERRCODE = '22023'; END IF;
  IF i.agent_integrity_resolved_at IS NOT NULL THEN RAISE EXCEPTION 'the flag is already resolved' USING ERRCODE = '22023'; END IF;
  UPDATE public.intelligence_items SET agent_integrity_resolved_at = v_at, agent_integrity_resolved_by = auth.uid(), source_url = CASE WHEN p_action = 'replace_url' THEN p_new_url ELSE source_url END WHERE id = p_item_id;
  PERFORM public.record_admin_event(NULL, 'brief_flag_resolved', 'intelligence_item', p_item_id::text, v_reason,
    jsonb_build_object('action', p_action, 'prior_url', i.source_url, 'new_url', CASE WHEN p_action = 'replace_url' THEN p_new_url END, 'phrase', i.agent_integrity_phrase));
  RETURN jsonb_build_object('item_id', p_item_id, 'action', p_action, 'resolved_at', v_at);
END;
$$;

CREATE FUNCTION public.admin_triage_rejection(p_id uuid, p_action text, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_reason text := public.admin_require(p_reason); r public.ingest_rejections; v_at timestamptz := now();
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('discarded', 'reclassified', 'escalated') THEN RAISE EXCEPTION 'the action is discarded, reclassified or escalated' USING ERRCODE = '22023'; END IF;
  SELECT * INTO r FROM public.ingest_rejections WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'row not found' USING ERRCODE = 'P0002'; END IF;
  IF r.triaged_at IS NOT NULL THEN RAISE EXCEPTION 'row already triaged' USING ERRCODE = '22023'; END IF;
  UPDATE public.ingest_rejections SET triage_action = p_action, triaged_by = auth.uid(), triaged_at = v_at, triage_notes = v_reason WHERE id = p_id;
  PERFORM public.record_admin_event(NULL, 'rejection_triaged', 'ingest_rejection', p_id::text, v_reason, jsonb_build_object('action', p_action));
  RETURN jsonb_build_object('id', p_id, 'triage_action', p_action, 'triaged_at', v_at);
END;
$$;

CREATE FUNCTION public.admin_resolve_jurisdiction_review(p_review_id uuid, p_action text, p_resolution text, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_reason text := public.admin_require(p_reason); res jsonb;
BEGIN
  res := public.resolve_pending_jurisdiction_review(p_review_id, p_action, p_resolution, auth.uid());
  PERFORM public.record_admin_event(NULL, 'jurisdiction_review_resolved', 'pending_jurisdiction_review', p_review_id::text, v_reason, jsonb_build_object('action', p_action, 'resolution', res -> 'resolution_value'));
  RETURN res;
END;
$$;

CREATE FUNCTION public.admin_set_hold(p_paused boolean, p_cadence text, p_start_date date, p_clear_start boolean, p_judgement_drain text, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_reason text := public.admin_require(p_reason); v_actor text := 'admin:' || auth.uid()::text; s public.system_state;
BEGIN
  IF p_paused IS NULL AND p_cadence IS NULL AND p_judgement_drain IS NULL AND NOT coalesce(p_clear_start, false) THEN RAISE EXCEPTION 'provide paused, cadence or judgement_drain' USING ERRCODE = '22023'; END IF;
  IF p_paused IS NOT NULL OR p_cadence IS NOT NULL OR coalesce(p_clear_start, false) THEN s := public.admin_set_pause_state(v_actor, p_paused, p_cadence, p_start_date, coalesce(p_clear_start, false)); END IF;
  IF p_judgement_drain IS NOT NULL THEN s := public.admin_set_judgement_drain(v_actor, p_judgement_drain); END IF;
  PERFORM public.record_admin_event(NULL, CASE WHEN p_paused IS TRUE THEN 'emergency_stop_engaged' WHEN p_paused IS FALSE THEN 'emergency_stop_lifted' ELSE 'hold_changed' END, 'system_state', 'hold', v_reason,
    jsonb_build_object('paused', p_paused, 'cadence', p_cadence, 'start_date', p_start_date, 'clear_start', coalesce(p_clear_start, false), 'judgement_drain', p_judgement_drain));
  RETURN to_jsonb(s);
END;
$$;

CREATE FUNCTION public.admin_corpus_turn_preview(p_scope text, p_source_id uuid DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE live int; opened int;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_platform_admin() THEN RAISE EXCEPTION 'platform admin access required' USING ERRCODE = '42501'; END IF;
  IF p_scope IS NULL OR p_scope NOT IN ('all', 'source') OR (p_scope = 'source' AND p_source_id IS NULL) THEN RAISE EXCEPTION 'the scope is all, or source with a source id' USING ERRCODE = '22023'; END IF;
  SELECT count(*), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.corpus_turn_requests r WHERE r.intelligence_item_id = i.id AND r.consumed_at IS NULL)) INTO live, opened
    FROM public.intelligence_items i WHERE NOT i.is_archived AND i.provenance_status = 'verified' AND (p_scope = 'all' OR i.source_id = p_source_id);
  RETURN jsonb_build_object('total_live', live, 'already_open', opened, 'would_request', live - opened);
END;
$$;

CREATE FUNCTION public.admin_request_corpus_turns(p_scope text, p_source_id uuid, p_item_id uuid, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_reason text := public.admin_require(p_reason); live int; opened int; inserted int;
BEGIN
  IF p_scope IS NULL OR p_scope NOT IN ('all', 'source', 'item') OR (p_scope = 'source' AND p_source_id IS NULL) OR (p_scope = 'item' AND p_item_id IS NULL) THEN RAISE EXCEPTION 'the scope is all, source or item, with its id' USING ERRCODE = '22023'; END IF;
  IF p_scope = 'source' THEN PERFORM 1 FROM public.sources WHERE id = p_source_id; IF NOT FOUND THEN RAISE EXCEPTION 'source not found' USING ERRCODE = 'P0002'; END IF; END IF;
  IF p_scope = 'item' THEN
    PERFORM 1 FROM public.intelligence_items WHERE id = p_item_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'item not found' USING ERRCODE = 'P0002'; END IF;
    PERFORM 1 FROM public.intelligence_items WHERE id = p_item_id AND NOT is_archived AND provenance_status = 'verified';
    IF NOT FOUND THEN RAISE EXCEPTION 'item is not live (archived or not verified): nothing for a corpus turn to act on' USING ERRCODE = '22023'; END IF;
  END IF;
  SELECT count(*), count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.corpus_turn_requests r WHERE r.intelligence_item_id = i.id AND r.consumed_at IS NULL)) INTO live, opened
    FROM public.intelligence_items i WHERE NOT i.is_archived AND i.provenance_status = 'verified' AND (p_scope = 'all' OR (p_scope = 'source' AND i.source_id = p_source_id) OR (p_scope = 'item' AND i.id = p_item_id));
  INSERT INTO public.corpus_turn_requests (intelligence_item_id, reason)
    SELECT i.id, 'manual' FROM public.intelligence_items i
     WHERE NOT i.is_archived AND i.provenance_status = 'verified' AND (p_scope = 'all' OR (p_scope = 'source' AND i.source_id = p_source_id) OR (p_scope = 'item' AND i.id = p_item_id))
       AND NOT EXISTS (SELECT 1 FROM public.corpus_turn_requests r WHERE r.intelligence_item_id = i.id AND r.consumed_at IS NULL);
  GET DIAGNOSTICS inserted = ROW_COUNT;
  PERFORM public.record_admin_event(NULL, 'corpus_turns_requested', CASE p_scope WHEN 'source' THEN 'source' WHEN 'item' THEN 'intelligence_item' ELSE 'corpus' END, coalesce(p_item_id::text, p_source_id::text, 'all'), v_reason,
    jsonb_build_object('scope', p_scope, 'inserted', inserted, 'already_open', opened, 'total_live', live));
  RETURN jsonb_build_object('ok', true, 'inserted', inserted, 'already_open', opened, 'total_live', live);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_source_switch(uuid, text, boolean, text), public.admin_set_flag_status(uuid, text, text), public.admin_resolve_brief_flag(uuid, text, text, text), public.admin_triage_rejection(uuid, text, text),
  public.admin_resolve_jurisdiction_review(uuid, text, text, text), public.admin_set_hold(boolean, text, date, boolean, text, text), public.admin_corpus_turn_preview(text, uuid), public.admin_request_corpus_turns(text, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_source_switch(uuid, text, boolean, text), public.admin_set_flag_status(uuid, text, text), public.admin_resolve_brief_flag(uuid, text, text, text), public.admin_triage_rejection(uuid, text, text),
  public.admin_resolve_jurisdiction_review(uuid, text, text, text), public.admin_set_hold(boolean, text, date, boolean, text, text), public.admin_corpus_turn_preview(text, uuid), public.admin_request_corpus_turns(text, uuid, uuid, text) TO authenticated;
COMMENT ON FUNCTION public.admin_set_source_switch(uuid, text, boolean, text) IS 'R2e migration 0102. Pause a source or hide it from workspaces: platform admin, a reason, one admin_events row in the same transaction.';
COMMENT ON FUNCTION public.admin_set_hold(boolean, text, date, boolean, text, text) IS 'R2e migration 0102. The emergency stop and the cadence and drain switches through their sanctioned writers, with the admin_events row, in one transaction.';
COMMENT ON FUNCTION public.admin_request_corpus_turns(text, uuid, uuid, text) IS 'R2e migration 0102. Open manual corpus-turn requests for all live items, one source or one item, with the admin_events row (scope, counts, reason) in the same transaction.';

-- Self-check 0102-admin-actions, in a fixture that rolls back. REFUSED with no change and no event: no session, an ordinary member, an org owner who is not a platform admin; a platform admin with no reason or a blank one. ALLOWED, each with one event
-- carrying the actor, the reason and the detail: pause and hide a source (and the unknown source is P0002), a flag moved to resolved (stamped) and back to open (cleared), a brief flag resolved (url replaced, a second resolve refused), a rejection triaged
-- once, the emergency stop engaged and lifted, the corpus preview equals what a request inserts and a second request inserts nothing. THE ATTACK (INV-R2e-2): a CHECK planted on admin_events refusing each action makes the act fail and leaves the change undone.
DO $$
DECLARE
  up uuid := gen_random_uuid(); uo uuid := gen_random_uuid(); org uuid := gen_random_uuid(); src uuid; flg uuid; it uuid; it2 uuid; rej uuid; res jsonb; n int; pre jsonb; ev_before int; held boolean;
BEGIN
  IF has_function_privilege('anon', 'public.admin_set_hold(boolean, text, date, boolean, text, text)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.admin_require(text)', 'EXECUTE') THEN RAISE EXCEPTION '0102-admin-actions: a client role can execute a function it must not'; END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (up, 'p-0102@invalid.example'), (uo, 'o-0102@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (up, 'p-0102@invalid.example'), (uo, 'o-0102@invalid.example');
    UPDATE public.profiles SET is_platform_admin = true WHERE id = up;
    INSERT INTO public.organizations (id, name, slug) VALUES (org, 'selfcheck-0102', 'selfcheck-0102-' || org);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, uo, 'owner');
    INSERT INTO public.sources (name, url, base_tier, tier_at_creation) VALUES ('selfcheck-0102', 'https://invalid.example/0102/' || gen_random_uuid(), 3, 3) RETURNING id INTO src;
    INSERT INTO public.integrity_flags (category, subject_type, subject_ref, description, created_by) VALUES ('data_quality', 'system', 'x', 'selfcheck-0102', 'selfcheck') RETURNING id INTO flg;
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, source_id, source_url, agent_integrity_flag, agent_integrity_phrase) VALUES ('selfcheck-0102 one', 1, 'verified', false, src, 'https://invalid.example/old', true, 'phrase') RETURNING id INTO it;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, source_id) VALUES ('selfcheck-0102 two', 1, 'verified', false, src) RETURNING id INTO it2;
    SET LOCAL session_replication_role = origin;
    DELETE FROM public.corpus_turn_requests WHERE intelligence_item_id IN (it, it2);
    INSERT INTO public.ingest_rejections (raw_value, rejection_reason) VALUES ('selfcheck-0102', 'unparseable') RETURNING id INTO rej;
    INSERT INTO public.system_state (id) VALUES (true) ON CONFLICT DO NOTHING;
    SELECT global_processing_paused INTO held FROM public.system_state WHERE id = true;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN PERFORM public.admin_set_source_switch(src, 'processing_paused', true, 'why'); RAISE EXCEPTION '0102-admin-actions: acted with no session'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', uo::text, true);
    BEGIN PERFORM public.admin_set_source_switch(src, 'processing_paused', true, 'why'); RAISE EXCEPTION '0102-admin-actions: an org owner paused a source'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.admin_set_hold(true, NULL, NULL, false, NULL, 'why'); RAISE EXCEPTION '0102-admin-actions: an org owner engaged the emergency stop'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.admin_request_corpus_turns('all', NULL, NULL, 'why'); RAISE EXCEPTION '0102-admin-actions: an org owner re-grounded the corpus'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', up::text, true);
    BEGIN PERFORM public.admin_set_source_switch(src, 'processing_paused', true, NULL); RAISE EXCEPTION '0102-admin-actions: paused with no reason'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.admin_set_hold(true, NULL, NULL, false, NULL, '   '); RAISE EXCEPTION '0102-admin-actions: stopped with a blank reason'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.admin_request_corpus_turns('all', NULL, NULL, ''); RAISE EXCEPTION '0102-admin-actions: re-grounded with no reason'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.admin_triage_rejection(rej, 'maybe', 'why'); RAISE EXCEPTION '0102-admin-actions: an action outside the vocabulary was accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.admin_set_source_switch(gen_random_uuid(), 'admin_only', true, 'why'); RAISE EXCEPTION '0102-admin-actions: an unknown source was switched'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.admin_events WHERE actor_id IN (up, uo)) OR (SELECT processing_paused FROM public.sources WHERE id = src) OR (SELECT global_processing_paused FROM public.system_state WHERE id = true) IS DISTINCT FROM held
       OR EXISTS (SELECT 1 FROM public.corpus_turn_requests WHERE intelligence_item_id IN (it, it2)) THEN RAISE EXCEPTION '0102-admin-actions: a refused call changed state or wrote an event'; END IF;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', up::text, true);
    PERFORM public.admin_set_source_switch(src, 'processing_paused', true, 'bad feed');
    PERFORM public.admin_set_source_switch(src, 'admin_only', true, 'hide while checking');
    res := public.admin_set_flag_status(flg, 'resolved', 'fixed in the registry');
    IF res ->> 'status' <> 'resolved' OR res ->> 'resolved_by' <> up::text OR res ->> 'resolution_note' <> 'fixed in the registry' THEN RAISE EXCEPTION '0102-admin-actions: the flag was not stamped: %', res; END IF;
    res := public.admin_set_flag_status(flg, 'open', 'reopened');
    IF res ->> 'resolved_at' IS NOT NULL OR res ->> 'resolved_by' IS NOT NULL THEN RAISE EXCEPTION '0102-admin-actions: reopening kept the stamp: %', res; END IF;
    pre := public.admin_corpus_turn_preview('source', src);
    IF (pre ->> 'total_live')::int <> 2 OR (pre ->> 'would_request')::int <> 2 THEN RAISE EXCEPTION '0102-admin-actions: the preview is wrong: %', pre; END IF;
    res := public.admin_request_corpus_turns('source', src, NULL, 'refresh after a feed change');
    IF (res ->> 'inserted')::int <> 2 OR (res ->> 'already_open')::int <> 0 THEN RAISE EXCEPTION '0102-admin-actions: the request disagrees with the preview: %', res; END IF;
    res := public.admin_request_corpus_turns('source', src, NULL, 'again');
    IF (res ->> 'inserted')::int <> 0 OR (res ->> 'already_open')::int <> 2 THEN RAISE EXCEPTION '0102-admin-actions: a repeat inserted: %', res; END IF;
    res := public.admin_resolve_brief_flag(it, 'replace_url', 'https://invalid.example/new', 'dead link replaced');
    BEGIN PERFORM public.admin_resolve_brief_flag(it, 'mark_resolved', NULL, 'again'); RAISE EXCEPTION '0102-admin-actions: a resolved flag was resolved twice'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.admin_resolve_brief_flag(it2, 'mark_resolved', NULL, 'not flagged'); RAISE EXCEPTION '0102-admin-actions: an unflagged item was resolved'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    PERFORM public.admin_triage_rejection(rej, 'discarded', 'noise');
    BEGIN PERFORM public.admin_triage_rejection(rej, 'escalated', 'again'); RAISE EXCEPTION '0102-admin-actions: a triaged row was triaged twice'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    PERFORM public.admin_set_hold(true, NULL, NULL, false, NULL, 'incident drill');
    PERFORM public.admin_set_hold(false, NULL, NULL, false, NULL, 'drill over');
    RESET ROLE;
    IF (SELECT processing_paused FROM public.sources WHERE id = src) IS NOT TRUE OR (SELECT admin_only FROM public.sources WHERE id = src) IS NOT TRUE OR (SELECT source_url FROM public.intelligence_items WHERE id = it) <> 'https://invalid.example/new'
       OR (SELECT agent_integrity_resolved_by FROM public.intelligence_items WHERE id = it) <> up OR (SELECT triaged_by FROM public.ingest_rejections WHERE id = rej) <> up OR (SELECT global_processing_paused FROM public.system_state WHERE id = true) IS DISTINCT FROM held THEN
      RAISE EXCEPTION '0102-admin-actions: an allowed call left the wrong state';
    END IF;
    SELECT count(*) INTO n FROM public.admin_events WHERE actor_id = up AND org_id IS NULL AND reason IS NOT NULL AND action IN ('source_switch_set', 'flag_status_set', 'brief_flag_resolved', 'rejection_triaged', 'emergency_stop_engaged', 'emergency_stop_lifted', 'corpus_turns_requested');
    IF n <> 10 THEN RAISE EXCEPTION '0102-admin-actions: % events written, expected 10', n; END IF;
    IF (SELECT detail ->> 'inserted' FROM public.admin_events WHERE actor_id = up AND action = 'corpus_turns_requested' AND reason = 'refresh after a feed change') <> '2' THEN RAISE EXCEPTION '0102-admin-actions: the corpus event lacks its count'; END IF;

    -- THE ATTACK: a refused event undoes the act.
    DELETE FROM public.corpus_turn_requests WHERE intelligence_item_id IN (it, it2);
    ALTER TABLE public.admin_events ADD CONSTRAINT planted_refuse_event CHECK (action NOT IN ('source_switch_set', 'flag_status_set', 'brief_flag_resolved', 'rejection_triaged', 'emergency_stop_engaged', 'corpus_turns_requested', 'jurisdiction_review_resolved')) NOT VALID;
    INSERT INTO public.ingest_rejections (raw_value, rejection_reason) VALUES ('selfcheck-0102-b', 'unparseable') RETURNING id INTO rej;
    UPDATE public.intelligence_items SET agent_integrity_resolved_at = NULL, agent_integrity_resolved_by = NULL WHERE id = it;
    SELECT count(*) INTO ev_before FROM public.admin_events WHERE actor_id = up;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', up::text, true);
    BEGIN PERFORM public.admin_set_source_switch(src, 'processing_paused', false, 'x'); RAISE EXCEPTION '0102-admin-actions: the switch survived a refused event'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.admin_set_flag_status(flg, 'archived', 'x'); RAISE EXCEPTION '0102-admin-actions: the flag survived a refused event'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.admin_resolve_brief_flag(it, 'mark_resolved', NULL, 'x'); RAISE EXCEPTION '0102-admin-actions: the brief flag survived a refused event'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.admin_triage_rejection(rej, 'discarded', 'x'); RAISE EXCEPTION '0102-admin-actions: the triage survived a refused event'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.admin_set_hold(true, NULL, NULL, false, NULL, 'x'); RAISE EXCEPTION '0102-admin-actions: the stop survived a refused event'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.admin_request_corpus_turns('all', NULL, NULL, 'x'); RAISE EXCEPTION '0102-admin-actions: the requests survived a refused event'; EXCEPTION WHEN check_violation THEN NULL; END;
    RESET ROLE;
    IF (SELECT processing_paused FROM public.sources WHERE id = src) IS NOT TRUE OR (SELECT status FROM public.integrity_flags WHERE id = flg) <> 'open' OR (SELECT agent_integrity_resolved_at FROM public.intelligence_items WHERE id = it) IS NOT NULL
       OR (SELECT triaged_at FROM public.ingest_rejections WHERE id = rej) IS NOT NULL OR (SELECT global_processing_paused FROM public.system_state WHERE id = true) IS DISTINCT FROM held
       OR EXISTS (SELECT 1 FROM public.corpus_turn_requests WHERE intelligence_item_id IN (it, it2)) OR (SELECT count(*) FROM public.admin_events WHERE actor_id = up) <> ev_before THEN RAISE EXCEPTION '0102-admin-actions: a change survived its refused event'; END IF;
    ALTER TABLE public.admin_events DROP CONSTRAINT planted_refuse_event;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0102-admin-actions OK';
END $$;

COMMIT;
