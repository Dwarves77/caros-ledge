-- 0062 the Community social round trip on the real schema (P2-16, WAVE-2-COMMON addendum 2: one system, proven together on `npm run schema:local`).
--
-- No schema change. The round trip is the member journey through the objects 0050-0060 built, each step as the real `authenticated` role under the real policies, in a fixture that rolls back:
--   create a group (create_group_for_self) -> invite a person (the admin-only insert policy) -> the invitee accepts (accept_group_invitation) -> the invitee opens a thread bound to a real entity (create_thread)
--   -> the admin replies (the member insert policy; the counters move by trigger) -> the admin reports the thread -> the admin moderates it with a ban (moderate_report: the ban row, the membership gone, the report closed)
--   -> the banned member's join is refused on both paths (their own session and the service path) -> a member requests sign-off on a thread -> an active verifier decides it (decide_signoff stamps the post).
-- The notification half of the journey (the outbox, the recipient's preferences and mutes, the drain) is the application's and is proven in tests/community/notifications.test.ts and tests/integration/one-turn.test.ts.
-- Not applied to production before the cutover window.

-- catalog: none

BEGIN;

DO $$
DECLARE c uuid := gen_random_uuid(); i uuid := gen_random_uuid(); v uuid := gen_random_uuid(); ent text := 'cl:jurisdiction:eeeeeeeeeeeeeeee';
  g jsonb; gid uuid; inv uuid; thread jsonb; tid uuid; reply uuid; report uuid; req uuid; res jsonb; n int; t timestamptz;
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (c, 'c-0062@invalid.example'), (i, 'i-0062@invalid.example'), (v, 'v-0062@invalid.example');
    INSERT INTO public.profiles (id, email, display_name) VALUES (c, 'c-0062@invalid.example', 'Creator'), (i, 'i-0062@invalid.example', 'Invitee'), (v, 'v-0062@invalid.example', 'Verifier');
    UPDATE public.profiles SET verifier_status = 'active' WHERE id = v;
    INSERT INTO public.entities (entity_id, kind, canonical_name) VALUES (ent, 'jurisdiction', 'Selfcheck 0062');

    -- The report policy reads auth.role() directly; the CI stub's schema has no USAGE grant for the role (Supabase's does), so the fixture grants it, inside the transaction that rolls back.
    GRANT USAGE ON SCHEMA auth TO authenticated;

    -- 1. create the group: the group and its owner-admin row come from one call
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', c::text, true);
    g := public.create_group_for_self('Round trip', 'rt-0062-' || c, 'fine-art', 'A round trip');
    gid := (g ->> 'id')::uuid;
    SELECT count(*) INTO n FROM public.community_group_members WHERE group_id = gid AND user_id = c AND role = 'admin';
    IF n <> 1 THEN RAISE EXCEPTION '0062 step 1: the creator is not the group''s admin'; END IF;

    -- 2. invite: the admin's insert; then the invitee sees it, a stranger does not
    INSERT INTO public.community_group_invitations (group_id, inviter_user_id, invitee_user_id, status) VALUES (gid, c, i, 'pending') RETURNING id INTO inv;
    PERFORM set_config('request.jwt.claim.sub', i::text, true);
    SELECT count(*) INTO n FROM public.community_group_invitations WHERE id = inv;
    IF n <> 1 THEN RAISE EXCEPTION '0062 step 2: the invitee cannot see their invitation'; END IF;
    PERFORM set_config('request.jwt.claim.sub', v::text, true);
    SELECT count(*) INTO n FROM public.community_group_invitations WHERE id = inv;
    IF n <> 0 THEN RAISE EXCEPTION '0062 step 2: a stranger sees the invitation'; END IF;

    -- 3. accept: one transaction, the membership and the status
    PERFORM set_config('request.jwt.claim.sub', i::text, true);
    IF public.accept_group_invitation(inv) <> gid THEN RAISE EXCEPTION '0062 step 3: accept answered another group'; END IF;
    SELECT count(*) INTO n FROM public.community_group_members WHERE group_id = gid AND user_id = i AND role = 'member';
    IF n <> 1 THEN RAISE EXCEPTION '0062 step 3: the invitee is not a member after accepting'; END IF;

    -- 4. a thread bound to a real entity
    thread := public.create_thread(gid, 'Is anyone filing?', 'We are about to file.', NULL, ARRAY[ent]);
    tid := (thread ->> 'id')::uuid;
    SELECT count(*) INTO n FROM public.community_thread_entities WHERE thread_id = tid AND entity_id = ent;
    IF n <> 1 THEN RAISE EXCEPTION '0062 step 4: the thread is not bound to its entity'; END IF;

    -- 5. the admin replies; the counters are the database's
    PERFORM set_config('request.jwt.claim.sub', c::text, true);
    INSERT INTO public.community_posts (group_id, parent_post_id, author_user_id, body) VALUES (gid, tid, c, 'Yes, last week.') RETURNING id INTO reply;
    SELECT reply_count INTO n FROM public.community_posts WHERE id = tid;
    IF n <> 1 THEN RAISE EXCEPTION '0062 step 5: the reply count is %, not 1', n; END IF;

    -- 6. report, then moderate with a ban
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason) VALUES ('post', tid, c, 'spam') RETURNING id INTO report;
    res := public.moderate_report(report, 'ban', 'Repeated spam');
    IF res ->> 'status' <> 'resolved' OR (res ->> 'notify_user_id')::uuid <> i THEN RAISE EXCEPTION '0062 step 6: the ban answered %', res; END IF;
    RESET ROLE;
    SELECT count(*) INTO n FROM public.community_group_bans WHERE group_id = gid AND user_id = i AND banned_by = c;
    IF n <> 1 THEN RAISE EXCEPTION '0062 step 6: the ban was not recorded'; END IF;
    SELECT count(*) INTO n FROM public.community_group_members WHERE group_id = gid AND user_id = i;
    IF n <> 0 THEN RAISE EXCEPTION '0062 step 6: the banned member is still a member'; END IF;

    -- 7. the banned member cannot come back: by their own session (not an admin, so no insert policy) and by the service path (the guard)
    BEGIN
      INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (gid, i, 'member');
      RAISE EXCEPTION '0062 step 7: the service path re-admitted a banned member';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', i::text, true);
    BEGIN
      INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (gid, i, 'member');
      RAISE EXCEPTION '0062 step 7: a banned member joined by their own session';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    RESET ROLE;

    -- 8. sign-off: the creator asks for it on a thread of their own, an active verifier decides, the post is stamped
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', c::text, true);
    thread := public.create_thread(gid, 'Our filing', 'We filed on the first.', NULL, ARRAY[ent]);
    INSERT INTO public.community_post_signoff_requests (post_id, requested_by) VALUES ((thread ->> 'id')::uuid, c) RETURNING id INTO req;
    BEGIN
      PERFORM public.decide_signoff(req, 'signed_off', NULL, NULL);
      RAISE EXCEPTION '0062 step 8: the requester decided their own sign-off';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
    PERFORM set_config('request.jwt.claim.sub', v::text, true);
    res := public.decide_signoff(req, 'signed_off', 'https://eur-lex.europa.eu/example', 'Checked against the Official Journal');
    IF res ->> 'status' <> 'signed_off' THEN RAISE EXCEPTION '0062 step 8: the decision answered %', res; END IF;
    RESET ROLE;
    SELECT signed_off_at INTO t FROM public.community_posts WHERE id = (thread ->> 'id')::uuid;
    IF t IS NULL THEN RAISE EXCEPTION '0062 step 8: the post was not stamped signed off'; END IF;

    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0062-round-trip OK (create, invite, accept, thread, reply, report, ban, refused rejoin, sign-off)';
END $$;

COMMIT;
