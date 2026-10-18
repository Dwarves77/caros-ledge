-- 0060 the Community row-security attacks (P2-16, CLAUDE.md rule 15: a guard is proven by attack, not by presence; B-0832 and B-0852 retire).
--
-- No schema change. This file is the attack: six scripted breaches run as the real `authenticated` role against the real policies, each of which MUST fail, in a fixture that rolls back. A policy that was merely present
-- (or defeated by one grant) fails this file, and with it the schema job.
--   1. a member session reads another organisation's profiles row                       (SEC-5, INV-234)
--   2. a non-member reads a private group, its posts and its thread-entity rows         (INV-150, B-0852)
--   3. a member writes verified, verified_at, verification_method or organisation_key   (INV-137, INV-235)
--   4. a reporter acts on their own report                                              (INV-239)
--   5. an inviter who is no longer an admin updates an invitation                       (INV-240)
--   6. a banned user joins the group again, by their own session and by the service path (INV-240)
-- Not applied to production before the cutover window.

-- catalog: none

BEGIN;

DO $$
DECLARE oa uuid := gen_random_uuid(); ob uuid := gen_random_uuid(); a1 uuid := gen_random_uuid(); b1 uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); inv uuid := gen_random_uuid();
  bad uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); rep uuid := gen_random_uuid(); pg uuid := gen_random_uuid(); pub uuid := gen_random_uuid();
  post uuid; post2 uuid; report uuid; invitation uuid; n int; ent text := 'cl:jurisdiction:dddddddddddddddd';
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email) SELECT u, left(u::text, 8) || '-0060@invalid.example' FROM unnest(ARRAY[a1, b1, adm, inv, bad, mem, rep]) AS u;
    INSERT INTO public.profiles (id, email, display_name) SELECT u, left(u::text, 8) || '-0060@invalid.example', 'name ' || left(u::text, 4) FROM unnest(ARRAY[a1, b1, adm, inv, bad, mem, rep]) AS u;
    INSERT INTO public.organizations (id, name, slug) VALUES (oa, 'org-a-0060', 'org-a-0060-' || oa), (ob, 'org-b-0060', 'org-b-0060-' || ob);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (oa, a1, 'member'), (ob, b1, 'member');
    INSERT INTO public.entities (entity_id, kind, canonical_name) VALUES (ent, 'jurisdiction', 'Selfcheck 0060');
    INSERT INTO public.community_groups (id, name, slug, region, privacy, owner_user_id) VALUES (pg, 'private', 'pg-0060-' || pg, 'GLOBAL', 'private', adm), (pub, 'public', 'pub-0060-' || pub, 'GLOBAL', 'public', adm);
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (pg, adm, 'admin'), (pg, mem, 'member'), (pub, adm, 'admin'), (pub, inv, 'admin'), (pub, rep, 'member');
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (pg, mem, 'secret', 'x') RETURNING id INTO post;
    INSERT INTO public.community_thread_entities (thread_id, entity_id, entity_kind) VALUES (post, ent, 'jurisdiction');
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (pub, rep, 'public one', 'x') RETURNING id INTO post2;
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason) VALUES ('post', post2, rep, 'spam') RETURNING id INTO report;
    INSERT INTO public.community_group_invitations (group_id, inviter_user_id, invitee_user_id) VALUES (pub, inv, bad) RETURNING id INTO invitation;
    UPDATE public.community_group_members SET role = 'member' WHERE group_id = pub AND user_id = inv;
    INSERT INTO public.community_group_bans (group_id, user_id, banned_by) VALUES (pub, bad, adm);

    -- 1. another organisation's profile row
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', a1::text, true);
    SELECT count(*) INTO n FROM public.profiles WHERE id = b1;
    IF n <> 0 THEN RAISE EXCEPTION '0060 attack 1: a member of org A read org B''s profiles row'; END IF;
    SELECT count(*) INTO n FROM public.profiles WHERE id = a1;
    IF n <> 1 THEN RAISE EXCEPTION '0060 attack 1: the control failed, a member cannot read their own row'; END IF;

    -- 2. a private group, its posts and its thread-entity rows, as a non-member (a1) and then as a member (mem)
    SELECT count(*) INTO n FROM public.community_groups WHERE id = pg;
    IF n <> 0 THEN RAISE EXCEPTION '0060 attack 2: a non-member read a private group'; END IF;
    SELECT count(*) INTO n FROM public.community_posts WHERE group_id = pg;
    IF n <> 0 THEN RAISE EXCEPTION '0060 attack 2: a non-member read a private group''s posts'; END IF;
    SELECT count(*) INTO n FROM public.community_thread_entities WHERE thread_id = post;
    IF n <> 0 THEN RAISE EXCEPTION '0060 attack 2: a non-member read a private group''s thread-entity rows'; END IF;
    PERFORM set_config('request.jwt.claim.sub', mem::text, true);
    SELECT (SELECT count(*) FROM public.community_groups WHERE id = pg) + (SELECT count(*) FROM public.community_posts WHERE group_id = pg) + (SELECT count(*) FROM public.community_thread_entities WHERE thread_id = post) INTO n;
    IF n <> 3 THEN RAISE EXCEPTION '0060 attack 2: the control failed, a member reads % of the 3 private rows', n; END IF;

    -- 3. a member writes the verification columns
    PERFORM set_config('request.jwt.claim.sub', a1::text, true);
    INSERT INTO public.community_member_profiles (user_id, org_type) VALUES (a1, 'forwarder');
    BEGIN UPDATE public.community_member_profiles SET verified = true WHERE user_id = a1; RAISE EXCEPTION '0060 attack 3: a member set verified';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN UPDATE public.community_member_profiles SET organisation_key = 'forged' WHERE user_id = a1; RAISE EXCEPTION '0060 attack 3: a member set organisation_key';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN UPDATE public.community_member_profiles SET verification_method = 'corporate-email', verified_at = now() WHERE user_id = a1; RAISE EXCEPTION '0060 attack 3: a member set the verification method';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN INSERT INTO public.community_member_profiles (user_id, org_type, verified) VALUES (b1, 'other', true); RAISE EXCEPTION '0060 attack 3: a member created a verified profile for someone else';
    EXCEPTION WHEN SQLSTATE '42501' OR SQLSTATE '23514' THEN NULL; END;
    UPDATE public.community_member_profiles SET role = 'ops lead' WHERE user_id = a1;

    -- 4. the reporter acts on their own report
    PERFORM set_config('request.jwt.claim.sub', rep::text, true);
    BEGIN
      UPDATE public.moderation_reports SET status = 'dismissed' WHERE id = report;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> 0 THEN RAISE EXCEPTION '0060 attack 4: a reporter closed their own report directly'; END IF;
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.moderate_report(report, 'dismiss', NULL); RAISE EXCEPTION '0060 attack 4: a reporter closed their own report through moderate_report';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

    -- 5. an inviter who is no longer an admin updates an invitation
    PERFORM set_config('request.jwt.claim.sub', inv::text, true);
    BEGIN
      UPDATE public.community_group_invitations SET status = 'revoked' WHERE id = invitation;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> 0 THEN RAISE EXCEPTION '0060 attack 5: an inviter who is no longer an admin revoked an invitation'; END IF;
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN
      UPDATE public.community_group_invitations SET status = 'accepted' WHERE id = invitation;
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n <> 0 THEN RAISE EXCEPTION '0060 attack 5: an inviter accepted an invitation addressed to someone else'; END IF;
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

    -- 6. a banned user joins again
    PERFORM set_config('request.jwt.claim.sub', bad::text, true);
    BEGIN INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (pub, bad, 'member'); RAISE EXCEPTION '0060 attack 6: a banned user joined by their own session';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.accept_group_invitation(invitation); RAISE EXCEPTION '0060 attack 6: a banned user accepted an invitation';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    RESET ROLE;
    BEGIN INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (pub, bad, 'member'); RAISE EXCEPTION '0060 attack 6: a banned user joined by the service path';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0060-rls-attacks OK (six breaches failed)';
END $$;

COMMIT;
