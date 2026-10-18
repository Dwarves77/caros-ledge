-- 0057 moderate_report (P2-16, INV-239, ROUTES-1).
--
-- A moderation action was a route that read the report, checked the reviewer, ran the side effect (a post delete, a membership delete, a notification) and only then closed the report, as separate calls: a raced second
-- action ran the side effect twice, and a "ban" deleted a membership and recorded nothing. The rpc is one transaction in the order the rules need:
--   moderate_report(p_report_id, p_action, p_notes) -> jsonb {report_id, status, action, group_id, post_id, notify_user_id}
-- 1. a session (42501); 2. the action is dismiss, warn, remove or ban (22023; mute is a value the column admits but this function refuses: nothing defines what a mute does); 3. the report exists (P0002);
-- 4. THE REVIEWER GATE, before any side effect: the caller moderates or administers the report's group (user_is_group_admin) or is a platform admin by is_platform_admin(); anything else, an unknown group included,
-- is 42501 and nothing changes (fail closed); 5. the report is open (22023): a closed report never changes; 6. the side effect: remove deletes the post, ban removes the author's membership, records the group ban
-- (0050) with the reviewer and revokes the author's pending invitations to the group, warn changes nothing; 7. the report closes (resolved, or dismissed for a dismiss) with the action, the note, the time and the reviewer.
-- Any failure rolls the whole call back, so there is no half-applied action. The author to notify is returned for the route to queue (notify_user_id; the id never reaches a browser).
-- Executable by authenticated and service_role. Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.moderate_report(uuid, text, text).

-- catalog: function

BEGIN;

CREATE FUNCTION public.moderate_report(p_report_id uuid, p_action text, p_notes text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_report public.moderation_reports;
  v_post public.community_posts;
  v_group uuid;
  v_notify uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('dismiss', 'warn', 'remove', 'ban') THEN
    RAISE EXCEPTION 'The action is dismiss, warn, remove or ban' USING ERRCODE = '22023';
  END IF;
  IF v_notes IS NOT NULL AND length(v_notes) > 1000 THEN
    RAISE EXCEPTION 'A note is at most 1000 characters' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_report FROM public.moderation_reports WHERE id = p_report_id FOR UPDATE;
  IF v_report.id IS NULL THEN
    RAISE EXCEPTION 'Report not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_report.target_kind = 'post' THEN
    SELECT * INTO v_post FROM public.community_posts WHERE id = v_report.target_id;
    v_group := v_post.group_id;
  ELSIF v_report.target_kind = 'group' THEN
    v_group := v_report.target_id;
  END IF;
  IF NOT ((v_group IS NOT NULL AND public.user_is_group_admin(v_group, v_uid)) OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'Moderator or platform admin access required' USING ERRCODE = '42501';
  END IF;
  IF v_report.status <> 'open' THEN
    RAISE EXCEPTION 'This report is already %', v_report.status USING ERRCODE = '22023';
  END IF;
  IF p_action = 'remove' THEN
    IF v_post.id IS NULL THEN
      RAISE EXCEPTION 'The reported post no longer exists' USING ERRCODE = 'P0002';
    END IF;
    DELETE FROM public.community_posts WHERE id = v_post.id;
    v_notify := v_post.author_user_id;
  ELSIF p_action = 'warn' THEN
    IF v_post.author_user_id IS NULL THEN
      RAISE EXCEPTION 'There is no author to warn on this report' USING ERRCODE = '22023';
    END IF;
    v_notify := v_post.author_user_id;
  ELSIF p_action = 'ban' THEN
    IF v_post.author_user_id IS NULL OR v_group IS NULL THEN
      RAISE EXCEPTION 'There is no member to ban on this report' USING ERRCODE = '22023';
    END IF;
    IF v_post.author_user_id = v_uid THEN
      RAISE EXCEPTION 'You cannot ban yourself' USING ERRCODE = '22023';
    END IF;
    DELETE FROM public.community_group_members WHERE group_id = v_group AND user_id = v_post.author_user_id;
    INSERT INTO public.community_group_bans (group_id, user_id, banned_by, reason) VALUES (v_group, v_post.author_user_id, v_uid, coalesce(v_notes, v_report.reason))
      ON CONFLICT (group_id, user_id) DO UPDATE SET banned_by = excluded.banned_by, reason = excluded.reason;
    UPDATE public.community_group_invitations SET status = 'revoked' WHERE group_id = v_group AND invitee_user_id = v_post.author_user_id AND status = 'pending';
    v_notify := v_post.author_user_id;
  END IF;
  UPDATE public.moderation_reports
     SET status = CASE WHEN p_action = 'dismiss' THEN 'dismissed' ELSE 'resolved' END, action = p_action, notes = v_notes, resolved_at = now(), resolved_by_user_id = v_uid
   WHERE id = v_report.id
   RETURNING * INTO v_report;
  RETURN jsonb_build_object('report_id', v_report.id, 'status', v_report.status, 'action', v_report.action, 'group_id', v_group, 'post_id', v_post.id, 'notify_user_id', v_notify);
END;
$$;
REVOKE ALL ON FUNCTION public.moderate_report(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.moderate_report(uuid, text, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.moderate_report(uuid, text, text) IS 'Act on a moderation report: reviewer gate first, then the side effect, the ban record and the close in one transaction (P2-16 migration 0057, INV-239).';

-- Self-check 0057-moderate-report: anon cannot execute. REFUSED, with the report still open, the post still there and the author still a member: no session, the plain member who filed the report, an outsider, the admin of
-- ANOTHER group, mute and an unknown action. ALLOWED: a moderator removes a post (post gone, report resolved with the action, note and reviewer); a second action on the closed report is refused and the closed row is byte-for-byte
-- unchanged; an admin dismisses (post kept); an admin bans (membership gone, ban recorded with the reviewer, the author's pending invitation revoked, a rejoin refused); banning the only admin is refused and rolls everything back;
-- a platform admin warns on a group they do not belong to; a warn with no author is refused.
DO $$
DECLARE g uuid := gen_random_uuid(); g2 uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); modr uuid := gen_random_uuid(); rep uuid := gen_random_uuid(); au uuid := gen_random_uuid(); au2 uuid := gen_random_uuid();
  other uuid := gen_random_uuid(); plat uuid := gen_random_uuid(); outsider uuid := gen_random_uuid(); solo uuid := gen_random_uuid(); g3 uuid := gen_random_uuid();
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid; res jsonb; before_row public.moderation_reports; after_row public.moderation_reports; n int; inv uuid;
BEGIN
  IF has_function_privilege('anon', 'public.moderate_report(uuid, text, text)', 'EXECUTE') THEN RAISE EXCEPTION '0057-moderate-report: anon can execute it'; END IF;
  BEGIN
    INSERT INTO auth.users (id, email) SELECT u, left(u::text, 8) || '-0057@invalid.example' FROM unnest(ARRAY[adm, modr, rep, au, au2, other, plat, outsider, solo]) AS u;
    INSERT INTO public.profiles (id, email) SELECT u, left(u::text, 8) || '-0057@invalid.example' FROM unnest(ARRAY[adm, modr, rep, au, au2, other, plat, outsider, solo]) AS u;
    UPDATE public.profiles SET is_platform_admin = true WHERE id = plat;
    INSERT INTO public.community_groups (id, name, slug, region, privacy, owner_user_id) VALUES (g, 'g', 'g-0057-' || g, 'GLOBAL', 'public', adm), (g2, 'g2', 'g2-0057-' || g2, 'GLOBAL', 'public', other), (g3, 'g3', 'g3-0057-' || g3, 'GLOBAL', 'public', solo);
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g, adm, 'admin'), (g, modr, 'moderator'), (g, rep, 'member'), (g, au, 'member'), (g, au2, 'member'), (g2, other, 'admin'), (g3, solo, 'admin');
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, au, 'p1', 'x') RETURNING id INTO p1;
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, au2, 'p2', 'x') RETURNING id INTO p2;
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, au, 'p3', 'x') RETURNING id INTO p3;
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g3, solo, 'p4', 'x') RETURNING id INTO p4;
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, au2, 'p5', 'x') RETURNING id INTO p5;
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason, body) VALUES ('post', p1, rep, 'spam', 'ad') RETURNING id INTO r1;
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason) VALUES ('post', p2, rep, 'off-topic') RETURNING id INTO r2;
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason) VALUES ('post', p3, rep, 'harassment') RETURNING id INTO r3;
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason) VALUES ('post', p4, rep, 'spam') RETURNING id INTO r4;
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason) VALUES ('post', p5, rep, 'other') RETURNING id INTO r5;
    INSERT INTO public.community_group_invitations (group_id, inviter_user_id, invitee_user_id) VALUES (g, adm, au) RETURNING id INTO inv;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN PERFORM public.moderate_report(r1, 'remove', NULL); RAISE EXCEPTION '0057-moderate-report: acted with no session';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', rep::text, true);
    BEGIN PERFORM public.moderate_report(r1, 'remove', NULL); RAISE EXCEPTION '0057-moderate-report: the reporter acted on their own report';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.moderate_report(r3, 'ban', NULL); RAISE EXCEPTION '0057-moderate-report: the reporter banned';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', outsider::text, true);
    BEGIN PERFORM public.moderate_report(r1, 'remove', NULL); RAISE EXCEPTION '0057-moderate-report: an outsider acted';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', other::text, true);
    BEGIN PERFORM public.moderate_report(r1, 'remove', NULL); RAISE EXCEPTION '0057-moderate-report: the admin of another group acted';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM public.community_posts WHERE id = p1) OR NOT EXISTS (SELECT 1 FROM public.community_group_members WHERE group_id = g AND user_id = au)
       OR (SELECT count(*) FROM public.moderation_reports WHERE status = 'open' AND id IN (r1, r2, r3, r4, r5)) <> 5 THEN
      RAISE EXCEPTION '0057-moderate-report: a refused call still changed state';
    END IF;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', modr::text, true);
    BEGIN PERFORM public.moderate_report(r1, 'mute', NULL); RAISE EXCEPTION '0057-moderate-report: mute was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.moderate_report(r1, 'delete', NULL); RAISE EXCEPTION '0057-moderate-report: an unknown action was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    res := public.moderate_report(r1, 'remove', ' off topic ad ');
    IF res ->> 'status' <> 'resolved' OR res ->> 'action' <> 'remove' OR (res ->> 'notify_user_id')::uuid <> au OR (res ->> 'group_id')::uuid <> g THEN RAISE EXCEPTION '0057-moderate-report: the returned row is wrong: %', res; END IF;
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.community_posts WHERE id = p1) THEN RAISE EXCEPTION '0057-moderate-report: a remove left the post'; END IF;
    SELECT * INTO before_row FROM public.moderation_reports WHERE id = r1;
    IF before_row.status <> 'resolved' OR before_row.action <> 'remove' OR before_row.notes <> 'off topic ad' OR before_row.resolved_by_user_id <> modr OR before_row.resolved_at IS NULL OR before_row.reason <> 'spam' OR before_row.body <> 'ad' THEN
      RAISE EXCEPTION '0057-moderate-report: the closed row is wrong';
    END IF;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', plat::text, true);
    BEGIN PERFORM public.moderate_report(r1, 'dismiss', 'second thoughts'); RAISE EXCEPTION '0057-moderate-report: a closed report was acted on again';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    RESET ROLE;
    SELECT * INTO after_row FROM public.moderation_reports WHERE id = r1;
    IF after_row IS DISTINCT FROM before_row THEN RAISE EXCEPTION '0057-moderate-report: a closed report changed'; END IF;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', adm::text, true);
    res := public.moderate_report(r2, 'dismiss', NULL);
    IF res ->> 'status' <> 'dismissed' OR res ->> 'notify_user_id' IS NOT NULL THEN RAISE EXCEPTION '0057-moderate-report: the dismiss returned %', res; END IF;
    BEGIN PERFORM public.moderate_report(r2, 'remove', 'changed my mind'); RAISE EXCEPTION '0057-moderate-report: a dismissed report was acted on again';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    res := public.moderate_report(r3, 'ban', 'harassment');
    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM public.community_posts WHERE id = p2) OR (SELECT action FROM public.moderation_reports WHERE id = r2) <> 'dismiss' THEN RAISE EXCEPTION '0057-moderate-report: a dismiss removed the post or a closed report changed'; END IF;
    IF EXISTS (SELECT 1 FROM public.community_group_members WHERE group_id = g AND user_id = au) THEN RAISE EXCEPTION '0057-moderate-report: a ban left the membership'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.community_group_bans WHERE group_id = g AND user_id = au AND banned_by = adm AND reason = 'harassment') THEN RAISE EXCEPTION '0057-moderate-report: a ban recorded nothing'; END IF;
    IF (SELECT status FROM public.community_group_invitations WHERE id = inv) <> 'revoked' THEN RAISE EXCEPTION '0057-moderate-report: the banned author kept a pending invitation'; END IF;
    BEGIN INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g, au, 'member'); RAISE EXCEPTION '0057-moderate-report: the banned author joined again';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', plat::text, true);
    BEGIN PERFORM public.moderate_report(r4, 'ban', NULL); RAISE EXCEPTION '0057-moderate-report: the only admin was banned';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM public.community_group_members WHERE group_id = g3 AND user_id = solo) OR EXISTS (SELECT 1 FROM public.community_group_bans WHERE group_id = g3)
       OR (SELECT status FROM public.moderation_reports WHERE id = r4) <> 'open' THEN
      RAISE EXCEPTION '0057-moderate-report: a refused ban was not rolled back whole';
    END IF;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', plat::text, true);
    res := public.moderate_report(r5, 'warn', NULL);
    IF (res ->> 'notify_user_id')::uuid <> au2 OR res ->> 'status' <> 'resolved' THEN RAISE EXCEPTION '0057-moderate-report: the platform admin warn returned %', res; END IF;
    RESET ROLE;
    SELECT count(*) INTO n FROM public.community_posts WHERE id = p5;
    IF n <> 1 THEN RAISE EXCEPTION '0057-moderate-report: a warn removed the post'; END IF;
    UPDATE public.community_posts SET author_user_id = NULL WHERE id = p5;
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason) VALUES ('post', p5, rep, 'other') RETURNING id INTO r5;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', plat::text, true);
    BEGIN PERFORM public.moderate_report(r5, 'warn', NULL); RAISE EXCEPTION '0057-moderate-report: a warn with no author was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0057-moderate-report OK';
END $$;

COMMIT;
