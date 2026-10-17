-- 0037 write-and-notify in one transaction (P2-S4, IMP-065; accepted by the operator, WHY section 7).
--
-- The archive and the assignment of a workspace item were two requests that could disagree: the override upsert succeeded, then the notice was queued by a second insert whose failure was
-- counted in the response and lost. Two SECURITY DEFINER functions now do both in one transaction, so a failed outbox insert rolls the override back:
--   * archive_item_for_team(p_org_id, p_item_id, p_reason, p_note, p_notice): the team-wide hide. The gate is the one INV-165 states and the old policy path enforced: the caller holds owner or admin in the
--     org (a member, a viewer or a stranger is refused 42501), and a reason is required (22023). Attribution comes from auth.uid(): archived_by, never an argument (INV-166). The notice goes to the org's
--     watchers of the item and to its owner, minus the actor (the recipients overrides.ts computed), one notification_outbox row each, kind 'archive'.
--   * assign_item(p_org_id, p_item_id, p_owner_user_id, p_notice): the single owner. The caller must hold member, admin or owner (a viewer is refused 42501); the assignee must hold a membership of the
--     SAME org and not be a viewer (INV-167, 42501); owner_assigned_by and owner_assigned_at come from the session; NULL clears all three. A new owner other than the actor is notified (kind 'assignment').
-- Arguments beyond the brief's signature: p_org_id (a user may belong to several orgs; the route's active org is passed and the function re-checks the membership) and p_notice (the text and link of the
-- notice, authored by the app where the surface routing lives; the function adds item_id and the actor and chooses WHO). p_note NULL keeps the stored note.
-- Returns jsonb {override, queued}. Not applied to production before the cutover window; until then the route answers 503 with Retry (the function is absent: 42883 / PGRST202).
--
-- Reversal: DROP FUNCTION public.archive_item_for_team(uuid, uuid, text, text, jsonb); DROP FUNCTION public.assign_item(uuid, uuid, uuid, jsonb).

-- catalog: function

BEGIN;

CREATE FUNCTION public.archive_item_for_team(p_org_id uuid, p_item_id uuid, p_reason text, p_note text, p_notice jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  uid uuid := auth.uid(); r text; o public.workspace_item_overrides; legacy text; keys text[]; recipients uuid[]; n int := 0;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to archive for the workspace' USING ERRCODE = '42501'; END IF;
  SELECT m.role INTO r FROM public.org_memberships m WHERE m.org_id = p_org_id AND m.user_id = uid;
  IF r IS NULL OR r NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'workspace archive requires the admin or owner role' USING ERRCODE = '42501'; END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN RAISE EXCEPTION 'a reason is required to archive for the workspace' USING ERRCODE = '22023'; END IF;
  IF p_notice IS NULL OR jsonb_typeof(p_notice) <> 'object' THEN RAISE EXCEPTION 'p_notice must be a json object (title, body, link)' USING ERRCODE = '22023'; END IF;
  SELECT i.legacy_id INTO legacy FROM public.intelligence_items i WHERE i.id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such item' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.workspace_item_overrides (org_id, item_id, is_archived, archive_reason, archive_note, archived_at, archived_by, updated_at)
    VALUES (p_org_id, p_item_id, true, p_reason, p_note, now(), uid, now())
    ON CONFLICT (org_id, item_id) DO UPDATE SET is_archived = true, archive_reason = EXCLUDED.archive_reason, archive_note = coalesce(EXCLUDED.archive_note, public.workspace_item_overrides.archive_note),
      archived_at = EXCLUDED.archived_at, archived_by = EXCLUDED.archived_by, updated_at = EXCLUDED.updated_at
    RETURNING * INTO o;
  keys := ARRAY[p_item_id::text] || CASE WHEN legacy IS NULL OR legacy = '' THEN ARRAY[]::text[] ELSE ARRAY[legacy] END;
  SELECT coalesce(array_agg(DISTINCT u), '{}'::uuid[]) INTO recipients
    FROM (SELECT unnest(w.watcher_ids) AS u FROM public.org_watchers(p_org_id, keys) w UNION SELECT o.owner_user_id WHERE o.owner_user_id IS NOT NULL) s
   WHERE u <> uid;
  INSERT INTO public.notification_outbox (user_id, kind, payload)
    SELECT x, 'archive', p_notice || jsonb_build_object('item_id', p_item_id, 'archived_by', uid) FROM unnest(recipients) x;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('override', to_jsonb(o), 'queued', n);
END;
$$;
REVOKE ALL ON FUNCTION public.archive_item_for_team(uuid, uuid, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.archive_item_for_team(uuid, uuid, text, text, jsonb) TO authenticated, service_role;

CREATE FUNCTION public.assign_item(p_org_id uuid, p_item_id uuid, p_owner_user_id uuid, p_notice jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  uid uuid := auth.uid(); r text; ar text; o public.workspace_item_overrides; n int := 0;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to assign an owner' USING ERRCODE = '42501'; END IF;
  SELECT m.role INTO r FROM public.org_memberships m WHERE m.org_id = p_org_id AND m.user_id = uid;
  IF r IS NULL OR r = 'viewer' THEN RAISE EXCEPTION 'a viewer can read this workspace but cannot assign an owner' USING ERRCODE = '42501'; END IF;
  IF p_owner_user_id IS NOT NULL THEN
    SELECT m.role INTO ar FROM public.org_memberships m WHERE m.org_id = p_org_id AND m.user_id = p_owner_user_id;
    IF ar IS NULL THEN RAISE EXCEPTION 'the assignee is not a member of your organization' USING ERRCODE = '42501'; END IF;
    IF ar = 'viewer' THEN RAISE EXCEPTION 'a viewer can read this workspace but cannot own an item' USING ERRCODE = '42501'; END IF;
  END IF;
  IF p_notice IS NOT NULL AND jsonb_typeof(p_notice) <> 'object' THEN RAISE EXCEPTION 'p_notice must be a json object (title, body, link)' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM public.intelligence_items i WHERE i.id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such item' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.workspace_item_overrides (org_id, item_id, owner_user_id, owner_assigned_by, owner_assigned_at, updated_at)
    VALUES (p_org_id, p_item_id, p_owner_user_id, CASE WHEN p_owner_user_id IS NULL THEN NULL ELSE uid END, CASE WHEN p_owner_user_id IS NULL THEN NULL ELSE now() END, now())
    ON CONFLICT (org_id, item_id) DO UPDATE SET owner_user_id = EXCLUDED.owner_user_id, owner_assigned_by = EXCLUDED.owner_assigned_by, owner_assigned_at = EXCLUDED.owner_assigned_at, updated_at = EXCLUDED.updated_at
    RETURNING * INTO o;
  IF p_owner_user_id IS NOT NULL AND p_owner_user_id <> uid AND p_notice IS NOT NULL THEN
    INSERT INTO public.notification_outbox (user_id, kind, payload) VALUES (p_owner_user_id, 'assignment', p_notice || jsonb_build_object('item_id', p_item_id, 'assigned_by', uid));
    n := 1;
  END IF;
  RETURN jsonb_build_object('override', to_jsonb(o), 'queued', n);
END;
$$;
REVOKE ALL ON FUNCTION public.assign_item(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_item(uuid, uuid, uuid, jsonb) TO authenticated, service_role;

-- Self-check 0037-item-write-rpcs, in a fixture that rolls back: as an admin the archive is stamped from the session, dated, and queues one outbox row per org watcher and the owner, never the actor and never another
-- org's watcher; a member, a viewer, a stranger and a blank reason are each refused with nothing written. THE ATTACK: a CHECK planted on notification_outbox that refuses the kind 'archive' makes the call fail with the
-- check's error and leaves NO override row (the write rolled back with the notice); the same for 'assignment'; the plant is dropped. Assignment: a member assigns a teammate (stamped, one notice), an assignee outside the org
-- or a viewer assignee is refused, a viewer caller is refused, NULL clears the three columns; anon cannot execute either function.
DO $$
DECLARE
  org uuid := gen_random_uuid(); orgb uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); um uuid := gen_random_uuid(); uv uuid := gen_random_uuid(); uw uuid := gen_random_uuid(); uo uuid := gen_random_uuid();
  ub uuid := gen_random_uuid(); it uuid; it2 uuid; res jsonb; n int; row_ public.workspace_item_overrides;
  notice jsonb := '{"title":"Item archived for the workspace","body":"x","link":"/regulations/x"}';
BEGIN
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id, email) VALUES (ua, 'a-0037@invalid.example'), (um, 'm-0037@invalid.example'), (uv, 'v-0037@invalid.example'), (uw, 'w-0037@invalid.example'), (uo, 'o-0037@invalid.example'), (ub, 'b-0037@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (ua, 'a-0037@invalid.example'), (um, 'm-0037@invalid.example'), (uv, 'v-0037@invalid.example'), (uw, 'w-0037@invalid.example'), (uo, 'o-0037@invalid.example'), (ub, 'b-0037@invalid.example');
    INSERT INTO public.organizations (id, name, slug) VALUES (org, 'selfcheck-0037', 'selfcheck-0037-' || org), (orgb, 'selfcheck-0037-b', 'selfcheck-0037-b-' || orgb);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, ua, 'admin'), (org, um, 'member'), (org, uv, 'viewer'), (org, uw, 'member'), (org, uo, 'member'), (orgb, ub, 'owner');
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0037 one', 1, 'verified', false) RETURNING id INTO it;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0037 two', 1, 'verified', false) RETURNING id INTO it2;
    INSERT INTO public.user_watchlist (user_id, item_type, item_id) VALUES (uw, 'reg', it::text), (ub, 'reg', it::text), (ua, 'reg', it::text), (uw, 'reg', it2::text);
    INSERT INTO public.workspace_item_overrides (org_id, item_id, owner_user_id) VALUES (org, it, uo);
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    BEGIN PERFORM public.archive_item_for_team(org, it, 'superseded', NULL, notice); RESET ROLE; RAISE EXCEPTION '0037-item-write-rpcs: a member archived for the team';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', uv::text, true);
    BEGIN PERFORM public.archive_item_for_team(org, it, 'superseded', NULL, notice); RESET ROLE; RAISE EXCEPTION '0037-item-write-rpcs: a viewer archived for the team';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', ub::text, true);
    BEGIN PERFORM public.archive_item_for_team(org, it, 'superseded', NULL, notice); RESET ROLE; RAISE EXCEPTION '0037-item-write-rpcs: a stranger archived in another org';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    BEGIN PERFORM public.archive_item_for_team(org, it, '  ', NULL, notice); RESET ROLE; RAISE EXCEPTION '0037-item-write-rpcs: a blank reason was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    RESET ROLE;
    IF (SELECT is_archived FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it) IS NOT DISTINCT FROM true THEN RAISE EXCEPTION '0037-item-write-rpcs: a refused call changed the override'; END IF;
    SELECT count(*) INTO n FROM public.notification_outbox WHERE user_id IN (ua, um, uv, uw, uo, ub);
    IF n <> 0 THEN RAISE EXCEPTION '0037-item-write-rpcs: a refused call queued % notices', n; END IF;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    res := public.archive_item_for_team(org, it, 'superseded', 'because', notice);
    RESET ROLE;
    IF (res->>'queued')::int <> 2 THEN RAISE EXCEPTION '0037-item-write-rpcs: expected 2 notices (watcher and owner, not the actor, not the other org), got %', res->>'queued'; END IF;
    SELECT * INTO row_ FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it;
    IF NOT row_.is_archived OR row_.archived_by IS DISTINCT FROM ua OR row_.archive_reason <> 'superseded' OR row_.archive_note <> 'because' OR row_.archived_at IS NULL OR row_.owner_user_id IS DISTINCT FROM uo THEN
      RAISE EXCEPTION '0037-item-write-rpcs: the archive was not stamped from the session: %', to_jsonb(row_);
    END IF;
    IF (SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.notification_outbox WHERE kind = 'archive') IS DISTINCT FROM (SELECT string_agg(x::text, ',' ORDER BY x) FROM unnest(ARRAY[uw, uo]) x) THEN
      RAISE EXCEPTION '0037-item-write-rpcs: the archive notices went to the wrong people';
    END IF;
    IF (SELECT count(*) FROM public.notification_outbox WHERE kind = 'archive' AND payload->>'item_id' = it::text AND payload->>'archived_by' = ua::text) <> 2 THEN RAISE EXCEPTION '0037-item-write-rpcs: a notice lacks the item or the actor'; END IF;
    -- THE ATTACK: the outbox refuses the kind, so the write must not survive.
    ALTER TABLE public.notification_outbox ADD CONSTRAINT planted_refuse_archive CHECK (kind <> 'archive') NOT VALID;
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.archive_item_for_team(org, it2, 'superseded', NULL, notice);
      RESET ROLE; RAISE EXCEPTION '0037-item-write-rpcs: the archive survived a refused notice';
    EXCEPTION WHEN check_violation THEN NULL; END;
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it2) THEN RAISE EXCEPTION '0037-item-write-rpcs: the override row survived a failed outbox insert'; END IF;
    ALTER TABLE public.notification_outbox DROP CONSTRAINT planted_refuse_archive;
    -- assignment
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    res := public.assign_item(org, it2, uw, '{"title":"Item assigned to you","body":"x","link":"/regulations/x"}');
    RESET ROLE;
    SELECT * INTO row_ FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it2;
    IF row_.owner_user_id IS DISTINCT FROM uw OR row_.owner_assigned_by IS DISTINCT FROM um OR row_.owner_assigned_at IS NULL OR (res->>'queued')::int <> 1 THEN RAISE EXCEPTION '0037-item-write-rpcs: the assignment was not stamped from the session or not notified: %', res; END IF;
    IF (SELECT count(*) FROM public.notification_outbox WHERE kind = 'assignment' AND user_id = uw AND payload->>'assigned_by' = um::text) <> 1 THEN RAISE EXCEPTION '0037-item-write-rpcs: the assignee was not notified'; END IF;
    ALTER TABLE public.notification_outbox ADD CONSTRAINT planted_refuse_assignment CHECK (kind <> 'assignment') NOT VALID;
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.assign_item(org, it, uw, '{"title":"x"}');
      RESET ROLE; RAISE EXCEPTION '0037-item-write-rpcs: the assignment survived a refused notice';
    EXCEPTION WHEN check_violation THEN NULL; END;
    RESET ROLE;
    IF (SELECT owner_user_id FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it) IS DISTINCT FROM uo THEN RAISE EXCEPTION '0037-item-write-rpcs: the owner changed although its notice failed'; END IF;
    ALTER TABLE public.notification_outbox DROP CONSTRAINT planted_refuse_assignment;
    SET LOCAL ROLE authenticated;
    BEGIN PERFORM public.assign_item(org, it, ub, NULL); RESET ROLE; RAISE EXCEPTION '0037-item-write-rpcs: an assignee outside the org was accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN PERFORM public.assign_item(org, it, uv, NULL); RESET ROLE; RAISE EXCEPTION '0037-item-write-rpcs: a viewer assignee was accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', uv::text, true);
    BEGIN PERFORM public.assign_item(org, it, um, NULL); RESET ROLE; RAISE EXCEPTION '0037-item-write-rpcs: a viewer caller assigned an owner';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    PERFORM public.assign_item(org, it2, NULL, NULL);
    RESET ROLE;
    SELECT * INTO row_ FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it2;
    IF row_.owner_user_id IS NOT NULL OR row_.owner_assigned_by IS NOT NULL OR row_.owner_assigned_at IS NOT NULL THEN RAISE EXCEPTION '0037-item-write-rpcs: NULL did not clear the owner'; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_function_privilege('anon', 'public.archive_item_for_team(uuid,uuid,text,text,jsonb)', 'EXECUTE') OR has_function_privilege('anon', 'public.assign_item(uuid,uuid,uuid,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.archive_item_for_team(uuid,uuid,text,text,jsonb)', 'EXECUTE') OR NOT has_function_privilege('authenticated', 'public.assign_item(uuid,uuid,uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '0037-item-write-rpcs: unexpected EXECUTE privileges';
  END IF;
  RAISE NOTICE '0037-item-write-rpcs OK';
END $$;

COMMIT;
