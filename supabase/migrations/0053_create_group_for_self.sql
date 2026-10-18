-- 0053 create_group_for_self (P2-16, INV-238).
--
-- Creating a group was two writes on two clients (the group on the caller's, the owner's admin row on the service role), rolled back by a delete nobody checked. The rpc does both in one transaction, so a group
-- cannot exist without its admin:
--   create_group_for_self(p_name, p_slug, p_vertical, p_description) -> jsonb
-- It runs as the caller (auth.uid(); no session is refused 42501), makes a PUBLIC GLOBAL group owned by the caller with the caller as its admin, and returns the group row. A name of 1 to 120 characters and a
-- description of at most 1000 are enforced here (22023), the same pair the settings update uses in code. A taken slug raises 23505 and leaves nothing behind (the route retries with a new suffix). The vertical is a
-- cargo sector id: the vocabulary is the application's, so the route validates it.
-- Executable by authenticated and service_role. Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.create_group_for_self(text, text, text, text).

-- catalog: function

BEGIN;

CREATE FUNCTION public.create_group_for_self(p_name text, p_slug text, p_vertical text, p_description text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_desc text := nullif(btrim(coalesce(p_description, '')), '');
  v_group public.community_groups;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF length(v_name) < 1 OR length(v_name) > 120 THEN
    RAISE EXCEPTION 'A group name is 1 to 120 characters' USING ERRCODE = '22023';
  END IF;
  IF v_desc IS NOT NULL AND length(v_desc) > 1000 THEN
    RAISE EXCEPTION 'A group description is at most 1000 characters' USING ERRCODE = '22023';
  END IF;
  IF coalesce(btrim(p_slug), '') = '' OR coalesce(btrim(p_vertical), '') = '' THEN
    RAISE EXCEPTION 'A slug and a vertical are required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.community_groups (name, slug, region, privacy, owner_user_id, vertical, description)
  VALUES (v_name, btrim(p_slug), 'GLOBAL', 'public', v_uid, btrim(p_vertical), v_desc)
  RETURNING * INTO v_group;
  INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (v_group.id, v_uid, 'admin');
  RETURN jsonb_build_object('id', v_group.id, 'name', v_group.name, 'slug', v_group.slug, 'region', v_group.region, 'privacy', v_group.privacy, 'owner_user_id', v_group.owner_user_id,
    'description', v_group.description, 'vertical', v_group.vertical, 'member_count', 1, 'weekly_post_count', v_group.weekly_post_count, 'last_active_at', v_group.last_active_at, 'created_at', v_group.created_at);
END;
$$;
REVOKE ALL ON FUNCTION public.create_group_for_self(text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_group_for_self(text, text, text, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.create_group_for_self(text, text, text, text) IS 'Create a public vertical group and its admin row for the caller in one transaction (P2-16 migration 0053, INV-238).';

-- Self-check 0053-create-group: anon cannot execute and no session is refused; a call makes the group, its admin row and the member count of one; a name over 120 characters, a blank name and an over-long description are
-- refused with nothing left behind; a taken slug is refused 23505 with no second group and no orphan member row.
DO $$
DECLARE u uuid := gen_random_uuid(); res jsonb; gid uuid; n int;
BEGIN
  IF has_function_privilege('anon', 'public.create_group_for_self(text, text, text, text)', 'EXECUTE') THEN RAISE EXCEPTION '0053-create-group: anon can execute it'; END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (u, 'u-0053@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (u, 'u-0053@invalid.example');
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN PERFORM public.create_group_for_self('x', 'x-0053', 'fine-art', NULL); RAISE EXCEPTION '0053-create-group: created with no session';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    res := public.create_group_for_self('  Art movers  ', 'grp-0053-a', 'fine-art', 'Fine art logistics');
    gid := (res ->> 'id')::uuid;
    RESET ROLE;
    IF res ->> 'name' <> 'Art movers' OR res ->> 'privacy' <> 'public' OR res ->> 'region' <> 'GLOBAL' OR (res ->> 'owner_user_id')::uuid <> u THEN RAISE EXCEPTION '0053-create-group: the returned group is wrong: %', res; END IF;
    IF (SELECT role FROM public.community_group_members WHERE group_id = gid AND user_id = u) <> 'admin' THEN RAISE EXCEPTION '0053-create-group: the creator is not the admin'; END IF;
    IF (SELECT member_count FROM public.community_groups WHERE id = gid) <> 1 THEN RAISE EXCEPTION '0053-create-group: member_count is not 1'; END IF;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', u::text, true);
    BEGIN PERFORM public.create_group_for_self(repeat('n', 121), 'grp-0053-b', 'fine-art', NULL); RAISE EXCEPTION '0053-create-group: a 121-character name was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.create_group_for_self('   ', 'grp-0053-c', 'fine-art', NULL); RAISE EXCEPTION '0053-create-group: a blank name was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.create_group_for_self('ok', 'grp-0053-d', 'fine-art', repeat('d', 1001)); RAISE EXCEPTION '0053-create-group: a 1001-character description was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.create_group_for_self('Again', 'grp-0053-a', 'fine-art', NULL); RAISE EXCEPTION '0053-create-group: a taken slug was accepted';
    EXCEPTION WHEN SQLSTATE '23505' THEN NULL; END;
    RESET ROLE;
    SELECT count(*) INTO n FROM public.community_groups WHERE owner_user_id = u;
    IF n <> 1 THEN RAISE EXCEPTION '0053-create-group: % groups exist after the refusals, expected 1', n; END IF;
    SELECT count(*) INTO n FROM public.community_group_members WHERE user_id = u;
    IF n <> 1 THEN RAISE EXCEPTION '0053-create-group: % member rows exist after the refusals, expected 1', n; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0053-create-group OK';
END $$;

COMMIT;
