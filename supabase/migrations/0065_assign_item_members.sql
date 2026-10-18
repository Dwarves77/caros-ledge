-- 0065 assign_item_members (P2-15 PART A, IMP-115; WHY section 7; the pattern of 0037).
--
-- Multi-person assignment (POST /api/workspace/items/{id}/assignments) inserted the item_assignments rows with one request and queued the notices with a second insert whose failure was reported in the response and lost.
-- One SECURITY DEFINER function now does both in one transaction, so a failed outbox insert rolls the assignments back:
--   assign_item_members(p_org_id, p_item_id, p_assignees, p_due_on, p_notice): the caller must hold member, admin or owner in p_org_id (a viewer or a stranger is refused 42501); 1 to 25 distinct assignees (22023); every assignee
--   must hold a membership of the SAME org and not be a viewer (INV-167, 42501, the whole call refused with nothing written); the item must exist (P0002). assigned_by comes from auth.uid(), never an argument (INV-166).
--   An assignee already assigned is left as it is and reported (`already`), never duplicated and never notified again. A new assignee other than the caller gets one notification_outbox row, kind 'assignment': p_notice
--   (title, body, link, authored by the app where the surface routing lives) plus item_id, assigned_by and due_on.
-- Returns jsonb {created: [item_assignments rows], already: [assignee ids], queued: n}. Not applied to production before the cutover window; until then the route answers 503 with Retry (the function is absent: 42883 / PGRST202).
--
-- Reversal: DROP FUNCTION public.assign_item_members(uuid, uuid, uuid[], date, jsonb).

-- catalog: function

BEGIN;

CREATE FUNCTION public.assign_item_members(p_org_id uuid, p_item_id uuid, p_assignees uuid[], p_due_on date, p_notice jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  uid uuid := auth.uid(); r text; ids uuid[]; a uuid; ar text; row_ public.item_assignments; created jsonb := '[]'::jsonb; already jsonb := '[]'::jsonb; n int := 0;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to assign work' USING ERRCODE = '42501'; END IF;
  SELECT m.role INTO r FROM public.org_memberships m WHERE m.org_id = p_org_id AND m.user_id = uid;
  IF r IS NULL OR r = 'viewer' THEN RAISE EXCEPTION 'a viewer can read this workspace but cannot assign work' USING ERRCODE = '42501'; END IF;
  SELECT coalesce(array_agg(DISTINCT x), '{}'::uuid[]) INTO ids FROM unnest(coalesce(p_assignees, '{}'::uuid[])) x;
  IF cardinality(ids) = 0 OR cardinality(ids) > 25 THEN RAISE EXCEPTION 'assign between 1 and 25 people at a time' USING ERRCODE = '22023'; END IF;
  IF p_notice IS NULL OR jsonb_typeof(p_notice) <> 'object' THEN RAISE EXCEPTION 'p_notice must be a json object (title, body, link)' USING ERRCODE = '22023'; END IF;
  FOREACH a IN ARRAY ids LOOP
    SELECT m.role INTO ar FROM public.org_memberships m WHERE m.org_id = p_org_id AND m.user_id = a;
    IF ar IS NULL THEN RAISE EXCEPTION 'everyone you assign must be a member of your organization' USING ERRCODE = '42501'; END IF;
    IF ar = 'viewer' THEN RAISE EXCEPTION 'a viewer can read this workspace but cannot be assigned work' USING ERRCODE = '42501'; END IF;
  END LOOP;
  PERFORM 1 FROM public.intelligence_items i WHERE i.id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such item' USING ERRCODE = 'P0002'; END IF;
  FOREACH a IN ARRAY ids LOOP
    INSERT INTO public.item_assignments (org_id, item_id, assignee_user_id, assigned_by, due_on) VALUES (p_org_id, p_item_id, a, uid, p_due_on)
      ON CONFLICT (org_id, item_id, assignee_user_id) DO NOTHING RETURNING * INTO row_;
    IF FOUND THEN
      created := created || to_jsonb(row_);
      IF a <> uid THEN
        INSERT INTO public.notification_outbox (user_id, kind, payload) VALUES (a, 'assignment', p_notice || jsonb_build_object('item_id', p_item_id, 'assigned_by', uid, 'due_on', p_due_on));
        n := n + 1;
      END IF;
    ELSE
      already := already || to_jsonb(a);
    END IF;
  END LOOP;
  RETURN jsonb_build_object('created', created, 'already', already, 'queued', n);
END;
$$;
REVOKE ALL ON FUNCTION public.assign_item_members(uuid, uuid, uuid[], date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_item_members(uuid, uuid, uuid[], date, jsonb) TO authenticated, service_role;

-- Self-check 0065-assign-item-members, in a fixture that rolls back: a member assigns two teammates with a due date (both rows stamped assigned_by from the session, one notice each carrying the item, the assigner and the due date); a repeat
-- reports both as already assigned and writes and notifies nothing; assigning yourself writes the row and notifies nobody. REFUSED with nothing written: a viewer caller, a stranger caller, a viewer among the assignees (the whole batch),
-- an assignee of another org, an empty list, twenty-six people, a notice that is not an object, an unknown item. THE ATTACK: a CHECK planted on notification_outbox that refuses the kind 'assignment' makes the call fail with the
-- check's error and leaves NO assignment row (the write rolled back with the notice); the plant is dropped. anon cannot execute the function.
DO $$
DECLARE
  org uuid := gen_random_uuid(); orgb uuid := gen_random_uuid(); um uuid := gen_random_uuid(); uv uuid := gen_random_uuid(); ut uuid := gen_random_uuid(); ut2 uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  it uuid; res jsonb; n int; many uuid[];
  notice jsonb := '{"title":"Assigned to you","body":"x","link":"/regulations/x"}';
BEGIN
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id, email) VALUES (um, 'm-0065@invalid.example'), (uv, 'v-0065@invalid.example'), (ut, 't-0065@invalid.example'), (ut2, 't2-0065@invalid.example'), (ub, 'b-0065@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (um, 'm-0065@invalid.example'), (uv, 'v-0065@invalid.example'), (ut, 't-0065@invalid.example'), (ut2, 't2-0065@invalid.example'), (ub, 'b-0065@invalid.example');
    INSERT INTO public.organizations (id, name, slug) VALUES (org, 'selfcheck-0065', 'selfcheck-0065-' || org), (orgb, 'selfcheck-0065-b', 'selfcheck-0065-b-' || orgb);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, um, 'member'), (org, uv, 'viewer'), (org, ut, 'member'), (org, ut2, 'admin'), (orgb, ub, 'owner');
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0065 one', 1, 'verified', false) RETURNING id INTO it;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', uv::text, true);
    BEGIN PERFORM public.assign_item_members(org, it, ARRAY[ut], NULL, notice); RESET ROLE; RAISE EXCEPTION '0065-assign-item-members: a viewer assigned work';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', ub::text, true);
    BEGIN PERFORM public.assign_item_members(org, it, ARRAY[ut], NULL, notice); RESET ROLE; RAISE EXCEPTION '0065-assign-item-members: a stranger assigned work in another org';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    BEGIN PERFORM public.assign_item_members(org, it, ARRAY[ut, uv], NULL, notice); RESET ROLE; RAISE EXCEPTION '0065-assign-item-members: a viewer assignee was accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN PERFORM public.assign_item_members(org, it, ARRAY[ut, ub], NULL, notice); RESET ROLE; RAISE EXCEPTION '0065-assign-item-members: an assignee of another org was accepted';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN PERFORM public.assign_item_members(org, it, ARRAY[]::uuid[], NULL, notice); RESET ROLE; RAISE EXCEPTION '0065-assign-item-members: an empty list was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    SELECT array_agg(gen_random_uuid()) INTO many FROM generate_series(1, 26);
    BEGIN PERFORM public.assign_item_members(org, it, many, NULL, notice); RESET ROLE; RAISE EXCEPTION '0065-assign-item-members: twenty-six people were accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.assign_item_members(org, it, ARRAY[ut], NULL, '[]'::jsonb); RESET ROLE; RAISE EXCEPTION '0065-assign-item-members: a notice that is not an object was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.assign_item_members(org, gen_random_uuid(), ARRAY[ut], NULL, notice); RESET ROLE; RAISE EXCEPTION '0065-assign-item-members: an unknown item was accepted';
    EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.item_assignments WHERE org_id = org) OR EXISTS (SELECT 1 FROM public.notification_outbox WHERE user_id IN (um, uv, ut, ut2, ub)) THEN RAISE EXCEPTION '0065-assign-item-members: a refused call wrote'; END IF;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    res := public.assign_item_members(org, it, ARRAY[ut, ut2, ut], '2026-12-01', notice);
    RESET ROLE;
    IF jsonb_array_length(res->'created') <> 2 OR jsonb_array_length(res->'already') <> 0 OR (res->>'queued')::int <> 2 THEN RAISE EXCEPTION '0065-assign-item-members: expected 2 created and 2 notices, got %', res; END IF;
    IF (SELECT count(*) FROM public.item_assignments WHERE org_id = org AND item_id = it AND assigned_by = um AND due_on = '2026-12-01' AND state = 'open') <> 2 THEN RAISE EXCEPTION '0065-assign-item-members: the rows were not stamped from the session'; END IF;
    IF (SELECT count(*) FROM public.notification_outbox WHERE kind = 'assignment' AND payload->>'item_id' = it::text AND payload->>'assigned_by' = um::text AND payload->>'due_on' = '2026-12-01') <> 2 THEN RAISE EXCEPTION '0065-assign-item-members: a notice lacks the item, the assigner or the due date'; END IF;
    SET LOCAL ROLE authenticated;
    res := public.assign_item_members(org, it, ARRAY[ut, ut2], NULL, notice);
    RESET ROLE;
    IF jsonb_array_length(res->'created') <> 0 OR jsonb_array_length(res->'already') <> 2 OR (res->>'queued')::int <> 0 THEN RAISE EXCEPTION '0065-assign-item-members: a repeat was not reported as already assigned: %', res; END IF;
    IF (SELECT count(*) FROM public.item_assignments WHERE org_id = org) <> 2 OR (SELECT count(*) FROM public.notification_outbox WHERE kind = 'assignment') <> 2 THEN RAISE EXCEPTION '0065-assign-item-members: a repeat wrote or notified again'; END IF;
    SET LOCAL ROLE authenticated;
    res := public.assign_item_members(org, it, ARRAY[um], NULL, notice);
    RESET ROLE;
    IF jsonb_array_length(res->'created') <> 1 OR (res->>'queued')::int <> 0 OR EXISTS (SELECT 1 FROM public.notification_outbox WHERE user_id = um) THEN RAISE EXCEPTION '0065-assign-item-members: assigning yourself notified someone: %', res; END IF;
    -- THE ATTACK: the outbox refuses the kind, so the assignment must not survive.
    DELETE FROM public.item_assignments WHERE org_id = org;
    ALTER TABLE public.notification_outbox ADD CONSTRAINT planted_refuse_assignment CHECK (kind <> 'assignment') NOT VALID;
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM public.assign_item_members(org, it, ARRAY[ut], NULL, notice);
      RESET ROLE; RAISE EXCEPTION '0065-assign-item-members: the assignment survived a refused notice';
    EXCEPTION WHEN check_violation THEN NULL; END;
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.item_assignments WHERE org_id = org) THEN RAISE EXCEPTION '0065-assign-item-members: the assignment row survived a failed outbox insert'; END IF;
    ALTER TABLE public.notification_outbox DROP CONSTRAINT planted_refuse_assignment;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_function_privilege('anon', 'public.assign_item_members(uuid,uuid,uuid[],date,jsonb)', 'EXECUTE') OR NOT has_function_privilege('authenticated', 'public.assign_item_members(uuid,uuid,uuid[],date,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '0065-assign-item-members: unexpected EXECUTE privileges';
  END IF;
  RAISE NOTICE '0065-assign-item-members OK';
END $$;

COMMIT;
