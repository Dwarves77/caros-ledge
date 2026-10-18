-- 0055 create_thread (P2-16, INV-236, INV-223).
--
-- A thread was a post insert and an entity-link insert on the caller's client, with a delete to undo the first when the second failed (the delete was never checked). The rpc is one transaction, and it holds the binding
-- rule where the data lives: a top-level thread binds to 1 to 10 distinct, well-formed (cl:<kind>:<16 hex>), EXISTING entities, or nothing is written.
--   create_thread(p_group_id, p_title, p_body, p_anonymous, p_entity_ids) -> jsonb (the post row)
-- Rules, in order: a session (42501); membership of the group by user_is_group_member (42501; a banned user was removed from the group, so cannot post); a title of 1 to 200 and a body of 1 to 8000 characters (22023); the
-- entity binding (22023); the anonymity, resolved HERE and nowhere else: the caller's explicit flag when given, else the member's account default (community_member_profiles.default_anonymous), else false. The post
-- carries the resolved value from then on and does not change when the default is edited later. Each link row carries the entity's kind.
-- Security definer because the checks above replace the RLS insert policies for exactly the two inserts it makes. Executable by authenticated and service_role. Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.create_thread(uuid, text, text, boolean, text[]).

-- catalog: function

BEGIN;

CREATE FUNCTION public.create_thread(p_group_id uuid, p_title text, p_body text, p_anonymous boolean, p_entity_ids text[]) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_title text := btrim(coalesce(p_title, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_ids text[];
  v_found int;
  v_anon boolean;
  v_post public.community_posts;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.user_is_group_member(p_group_id, v_uid) THEN
    RAISE EXCEPTION 'Only group members may post' USING ERRCODE = '42501';
  END IF;
  IF length(v_title) < 1 OR length(v_title) > 200 THEN
    RAISE EXCEPTION 'A title is 1 to 200 characters' USING ERRCODE = '22023';
  END IF;
  IF length(v_body) < 1 OR length(v_body) > 8000 THEN
    RAISE EXCEPTION 'A post body is 1 to 8000 characters' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(DISTINCT btrim(x)), '{}') INTO v_ids FROM unnest(coalesce(p_entity_ids, '{}')) AS x WHERE btrim(coalesce(x, '')) <> '';
  IF coalesce(array_length(v_ids, 1), 0) < 1 OR array_length(v_ids, 1) > 10 THEN
    RAISE EXCEPTION 'A thread binds to 1 to 10 entities' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) AS x WHERE x !~ '^cl:[a-z_]+:[0-9a-f]{16}$') THEN
    RAISE EXCEPTION 'An entity id is malformed' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_found FROM public.entities e WHERE e.entity_id = ANY (v_ids);
  IF v_found <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'A chosen entity does not exist' USING ERRCODE = '22023';
  END IF;
  v_anon := coalesce(p_anonymous, (SELECT c.default_anonymous FROM public.community_member_profiles c WHERE c.user_id = v_uid), false);
  INSERT INTO public.community_posts (group_id, author_user_id, title, body, anonymous) VALUES (p_group_id, v_uid, v_title, v_body, v_anon) RETURNING * INTO v_post;
  INSERT INTO public.community_thread_entities (thread_id, entity_id, entity_kind) SELECT v_post.id, e.entity_id, e.kind FROM public.entities e WHERE e.entity_id = ANY (v_ids);
  RETURN jsonb_build_object('id', v_post.id, 'group_id', v_post.group_id, 'parent_post_id', v_post.parent_post_id, 'author_user_id', v_post.author_user_id, 'title', v_post.title, 'body', v_post.body,
    'created_at', v_post.created_at, 'last_reply_at', v_post.last_reply_at, 'reply_count', v_post.reply_count, 'anonymous', v_post.anonymous, 'signed_off_at', v_post.signed_off_at, 'entity_ids', to_jsonb(v_ids));
END;
$$;
REVOKE ALL ON FUNCTION public.create_thread(uuid, text, text, boolean, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_thread(uuid, text, text, boolean, text[]) TO authenticated, service_role;
COMMENT ON FUNCTION public.create_thread(uuid, text, text, boolean, text[]) IS 'Create a thread and bind it to 1-10 existing entities in one transaction; the anonymity is resolved here (P2-16 migration 0055, INV-236).';

-- Self-check 0055-create-thread: anon cannot execute; no session and a non-member are refused; 0, 11, malformed and unknown entities are refused with NO post left behind; a valid call writes the post and one link per
-- entity (carrying the kind); the anonymity follows the explicit flag, else the member's default, else false; a title or body outside its bounds is refused.
DO $$
DECLARE g uuid := gen_random_uuid(); m uuid := gen_random_uuid(); outsider uuid := gen_random_uuid(); e1 text := 'cl:jurisdiction:aaaaaaaaaaaaaaaa'; e2 text := 'cl:corridor:bbbbbbbbbbbbbbbb';
  ids text[] := ARRAY[]::text[]; res jsonb; pid uuid; n int; k int;
BEGIN
  IF has_function_privilege('anon', 'public.create_thread(uuid, text, text, boolean, text[])', 'EXECUTE') THEN RAISE EXCEPTION '0055-create-thread: anon can execute it'; END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (m, 'm-0055@invalid.example'), (outsider, 'out-0055@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (m, 'm-0055@invalid.example'), (outsider, 'out-0055@invalid.example');
    INSERT INTO public.community_groups (id, name, slug, region, privacy, owner_user_id) VALUES (g, 'g', 'g-0055-' || g, 'GLOBAL', 'public', m);
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g, m, 'admin');
    INSERT INTO public.entities (entity_id, kind, canonical_name) VALUES (e1, 'jurisdiction', 'Selfcheck 0055 jurisdiction'), (e2, 'corridor', 'Selfcheck 0055 corridor');
    FOR k IN 1..11 LOOP ids := ids || ('cl:jurisdiction:' || lpad(k::text, 16, '0')); END LOOP;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN PERFORM public.create_thread(g, 't', 'b', NULL, ARRAY[e1]); RAISE EXCEPTION '0055-create-thread: created with no session';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', outsider::text, true);
    BEGIN PERFORM public.create_thread(g, 't', 'b', NULL, ARRAY[e1]); RAISE EXCEPTION '0055-create-thread: a non-member posted';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', m::text, true);
    BEGIN PERFORM public.create_thread(g, 't', 'b', NULL, ARRAY[]::text[]); RAISE EXCEPTION '0055-create-thread: an unbound thread was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN IF SQLERRM <> 'A thread binds to 1 to 10 entities' THEN RAISE EXCEPTION '0055-create-thread: refused for another reason: %', SQLERRM; END IF; END;
    BEGIN PERFORM public.create_thread(g, 't', 'b', NULL, ids); RAISE EXCEPTION '0055-create-thread: eleven entities were accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN IF SQLERRM <> 'A thread binds to 1 to 10 entities' THEN RAISE EXCEPTION '0055-create-thread: refused for another reason: %', SQLERRM; END IF; END;
    BEGIN PERFORM public.create_thread(g, 't', 'b', NULL, ARRAY['cl:jurisdiction:xyz']); RAISE EXCEPTION '0055-create-thread: a malformed entity id was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.create_thread(g, 't', 'b', NULL, ARRAY['cl:jurisdiction:cccccccccccccccc']); RAISE EXCEPTION '0055-create-thread: an unknown entity was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.create_thread(g, '   ', 'b', NULL, ARRAY[e1]); RAISE EXCEPTION '0055-create-thread: a blank title was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.create_thread(g, 't', repeat('b', 8001), NULL, ARRAY[e1]); RAISE EXCEPTION '0055-create-thread: an over-long body was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    RESET ROLE;
    SELECT count(*) INTO n FROM public.community_posts WHERE group_id = g;
    IF n <> 0 THEN RAISE EXCEPTION '0055-create-thread: % posts remain after the refusals', n; END IF;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', m::text, true);
    res := public.create_thread(g, ' Lane note ', ' body ', NULL, ARRAY[e1, e2, e1]);
    pid := (res ->> 'id')::uuid;
    RESET ROLE;
    IF res ->> 'title' <> 'Lane note' OR (res ->> 'anonymous')::boolean IS NOT FALSE THEN RAISE EXCEPTION '0055-create-thread: the returned post is wrong: %', res; END IF;
    SELECT count(*) INTO n FROM public.community_thread_entities WHERE thread_id = pid AND entity_kind IS NOT NULL;
    IF n <> 2 THEN RAISE EXCEPTION '0055-create-thread: % entity links (with a kind), expected 2', n; END IF;

    INSERT INTO public.community_member_profiles (user_id, org_type, default_anonymous) VALUES (m, 'forwarder', true);
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', m::text, true);
    res := public.create_thread(g, 'Defaulted', 'b', NULL, ARRAY[e1]);
    IF (res ->> 'anonymous')::boolean IS NOT TRUE THEN RAISE EXCEPTION '0055-create-thread: the member default (anonymous) was not applied'; END IF;
    res := public.create_thread(g, 'Overridden', 'b', false, ARRAY[e1]);
    IF (res ->> 'anonymous')::boolean IS NOT FALSE THEN RAISE EXCEPTION '0055-create-thread: the explicit flag did not win over the default'; END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0055-create-thread OK';
END $$;

COMMIT;
