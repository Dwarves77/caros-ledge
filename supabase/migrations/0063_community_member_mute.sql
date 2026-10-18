-- 0063 a real mute: community_group_members.muted_until (P2-16, the register's "mute and ban real"; INV-239 extended).
--
-- A mute was a moderation action the column admitted and nothing defined. It is now one thing in one home. community_group_members gains muted_until (timestamptz, null = not muted):
--   * set ONLY by moderate_report with the action 'mute' and p_days in 1, 7 or 30 (22023 otherwise): the reviewer gate, the closed-report check, the side effect and the close are the one transaction of 0057, whose
--     function this file replaces with a four-argument one (p_days defaults to null, so a three-argument call still resolves). The reported post's author must still be a member (22023 otherwise).
--   * enforced by ONE trigger on community_posts (BEFORE INSERT, any writer): a post or a reply by a member whose mute has not expired is refused (42501) with a sentence that names the date, so create_thread and the
--     reply write are both covered by the same line and a new writer cannot forget it. An expired mute posts again; nothing needs to clear it.
--   * guarded against the member: a trigger on community_group_members refuses (42501) a change of muted_until by a client role (the member may update their own row for star and mute prefs; this column is not theirs).
-- Not applied to production before the cutover window.
--
-- Reversal: DROP TRIGGER community_posts_mute_guard_trg ON public.community_posts; DROP TRIGGER community_group_members_mute_column_trg ON public.community_group_members; DROP FUNCTION public.community_posts_mute_guard();
-- DROP FUNCTION public.community_group_members_mute_column(); DROP FUNCTION public.moderate_report(uuid, text, text, integer); ALTER TABLE public.community_group_members DROP COLUMN muted_until;
-- then recreate moderate_report(uuid, text, text) from 0057.

-- catalog: column, function, trigger

BEGIN;

ALTER TABLE public.community_group_members ADD COLUMN muted_until timestamptz;
COMMENT ON COLUMN public.community_group_members.muted_until IS 'A moderator''s mute: until this instant the member cannot post or reply in the group (P2-16 migration 0063). Written only by moderate_report.';

CREATE FUNCTION public.community_group_members_mute_column() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') AND (TG_OP = 'INSERT' AND NEW.muted_until IS NOT NULL OR TG_OP = 'UPDATE' AND NEW.muted_until IS DISTINCT FROM OLD.muted_until) THEN
    RAISE EXCEPTION 'A mute is set by a moderator, not by the member' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.community_group_members_mute_column() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER community_group_members_mute_column_trg BEFORE INSERT OR UPDATE ON public.community_group_members FOR EACH ROW EXECUTE FUNCTION public.community_group_members_mute_column();

CREATE FUNCTION public.community_posts_mute_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE v_until timestamptz;
BEGIN
  IF NEW.author_user_id IS NOT NULL THEN
    SELECT m.muted_until INTO v_until FROM public.community_group_members m WHERE m.group_id = NEW.group_id AND m.user_id = NEW.author_user_id AND m.muted_until > now();
    IF FOUND THEN
      RAISE EXCEPTION 'You are muted in this group until %.', to_char(v_until AT TIME ZONE 'UTC', 'FMDD Mon YYYY') USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.community_posts_mute_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER community_posts_mute_guard_trg BEFORE INSERT ON public.community_posts FOR EACH ROW EXECUTE FUNCTION public.community_posts_mute_guard();

DROP FUNCTION public.moderate_report(uuid, text, text);
CREATE FUNCTION public.moderate_report(p_report_id uuid, p_action text, p_notes text, p_days integer DEFAULT NULL) RETURNS jsonb
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
  v_until timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('dismiss', 'warn', 'remove', 'mute', 'ban') THEN
    RAISE EXCEPTION 'The action is dismiss, warn, remove, mute or ban' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'mute' AND (p_days IS NULL OR p_days NOT IN (1, 7, 30)) THEN
    RAISE EXCEPTION 'A mute lasts 1, 7 or 30 days' USING ERRCODE = '22023';
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
  ELSIF p_action = 'mute' THEN
    IF v_post.author_user_id IS NULL OR v_group IS NULL THEN
      RAISE EXCEPTION 'There is no member to mute on this report' USING ERRCODE = '22023';
    END IF;
    IF v_post.author_user_id = v_uid THEN
      RAISE EXCEPTION 'You cannot mute yourself' USING ERRCODE = '22023';
    END IF;
    v_until := now() + make_interval(days => p_days);
    UPDATE public.community_group_members SET muted_until = v_until WHERE group_id = v_group AND user_id = v_post.author_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That person is not a member of this group' USING ERRCODE = '22023';
    END IF;
    v_notify := v_post.author_user_id;
  END IF;
  UPDATE public.moderation_reports
     SET status = CASE WHEN p_action = 'dismiss' THEN 'dismissed' ELSE 'resolved' END, action = p_action, notes = v_notes, resolved_at = now(), resolved_by_user_id = v_uid
   WHERE id = v_report.id
   RETURNING * INTO v_report;
  RETURN jsonb_build_object('report_id', v_report.id, 'status', v_report.status, 'action', v_report.action, 'group_id', v_group, 'post_id', v_post.id, 'notify_user_id', v_notify, 'muted_until', v_until);
END;
$$;
REVOKE ALL ON FUNCTION public.moderate_report(uuid, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.moderate_report(uuid, text, text, integer) TO authenticated, service_role;
COMMENT ON FUNCTION public.moderate_report(uuid, text, text, integer) IS 'Act on a moderation report: reviewer gate first, then the side effect (dismiss, warn, remove, a 1, 7 or 30 day mute, ban), the record and the close in one transaction (P2-16 migrations 0057 and 0063, INV-239).';

-- Self-check 0063-member-mute, by attack. REFUSED: a moderator's mute of 3 days, of no days, of a person who left the group; a plain member's mute of anyone; a member setting or clearing their OWN muted_until by their own session.
-- ALLOWED and proven: a moderator mutes the reported author for 7 days (muted_until about seven days ahead, the report resolved as 'mute'); the muted member's thread (create_thread) and reply insert are both refused with the
-- date in the sentence and no row left behind; a member muted in another group still posts here; once the mute has expired (set in the past by the owner) the same member posts again; an unmuted member posts throughout.
DO $$
DECLARE g uuid := gen_random_uuid(); g2 uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); modr uuid := gen_random_uuid(); au uuid := gen_random_uuid(); plain uuid := gen_random_uuid(); gone uuid := gen_random_uuid();
  ent text := 'cl:jurisdiction:ffffffffffffffff'; p1 uuid; p2 uuid; p3 uuid; r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid; pm uuid; res jsonb; n int; until_at timestamptz; msg text;
BEGIN
  IF has_function_privilege('authenticated', 'public.community_posts_mute_guard()', 'EXECUTE') OR has_function_privilege('authenticated', 'public.community_group_members_mute_column()', 'EXECUTE') THEN
    RAISE EXCEPTION '0063-member-mute: a client role can execute a trigger function';
  END IF;
  BEGIN
    INSERT INTO auth.users (id, email) SELECT u, left(u::text, 8) || '-0063@invalid.example' FROM unnest(ARRAY[adm, modr, au, plain, gone]) AS u;
    INSERT INTO public.profiles (id, email) SELECT u, left(u::text, 8) || '-0063@invalid.example' FROM unnest(ARRAY[adm, modr, au, plain, gone]) AS u;
    INSERT INTO public.entities (entity_id, kind, canonical_name) VALUES (ent, 'jurisdiction', 'Selfcheck 0063');
    INSERT INTO public.community_groups (id, name, slug, region, privacy, owner_user_id) VALUES (g, 'g', 'g-0063-' || g, 'GLOBAL', 'public', adm), (g2, 'g2', 'g2-0063-' || g2, 'GLOBAL', 'public', adm);
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g, adm, 'admin'), (g, modr, 'moderator'), (g, au, 'member'), (g, plain, 'member'), (g2, adm, 'admin'), (g2, au, 'member');
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, au, 'p1', 'x') RETURNING id INTO p1;
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, plain, 'p2', 'x') RETURNING id INTO p2;
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, gone, 'p3', 'x') RETURNING id INTO p3;
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason) VALUES ('post', p1, plain, 'spam') RETURNING id INTO r1;
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason) VALUES ('post', p1, plain, 'spam') RETURNING id INTO r2;
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason) VALUES ('post', p3, plain, 'spam') RETURNING id INTO r3;
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason) VALUES ('post', p2, adm, 'spam') RETURNING id INTO r4;

    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, modr, 'pm', 'x') RETURNING id INTO pm;
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason) VALUES ('post', pm, plain, 'spam') RETURNING id INTO r5;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    PERFORM set_config('request.jwt.claim.sub', modr::text, true);
    BEGIN PERFORM public.moderate_report(r5, 'mute', NULL, 7); RAISE EXCEPTION '0063-member-mute: a moderator muted themselves';
    EXCEPTION WHEN SQLSTATE '22023' THEN IF SQLERRM <> 'You cannot mute yourself' THEN RAISE EXCEPTION '0063-member-mute: refused for another reason: %', SQLERRM; END IF; END;
    BEGIN PERFORM public.moderate_report(r1, 'mute', NULL, 3); RAISE EXCEPTION '0063-member-mute: a 3 day mute was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN IF SQLERRM <> 'A mute lasts 1, 7 or 30 days' THEN RAISE EXCEPTION '0063-member-mute: refused for another reason: %', SQLERRM; END IF; END;
    BEGIN PERFORM public.moderate_report(r1, 'mute', NULL, NULL); RAISE EXCEPTION '0063-member-mute: a mute with no days was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.moderate_report(r3, 'mute', NULL, 7); RAISE EXCEPTION '0063-member-mute: a person who left the group was muted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', plain::text, true);
    BEGIN PERFORM public.moderate_report(r1, 'mute', NULL, 7); RAISE EXCEPTION '0063-member-mute: a plain member muted someone';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', au::text, true);
    BEGIN UPDATE public.community_group_members SET muted_until = now() + interval '1 day' WHERE group_id = g AND user_id = au; RAISE EXCEPTION '0063-member-mute: a member muted themselves through the column';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    RESET ROLE;
    IF (SELECT count(*) FROM public.community_group_members WHERE group_id = g AND muted_until IS NOT NULL) <> 0 OR (SELECT status FROM public.moderation_reports WHERE id = r1) <> 'open' THEN
      RAISE EXCEPTION '0063-member-mute: a refused call still changed state';
    END IF;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', modr::text, true);
    res := public.moderate_report(r1, 'mute', 'Cool off', 7);
    RESET ROLE;
    until_at := (res ->> 'muted_until')::timestamptz;
    IF res ->> 'action' <> 'mute' OR res ->> 'status' <> 'resolved' OR (res ->> 'notify_user_id')::uuid <> au OR until_at < now() + interval '6 days 23 hours' OR until_at > now() + interval '7 days 1 hour' THEN
      RAISE EXCEPTION '0063-member-mute: the mute answered %', res;
    END IF;
    IF (SELECT muted_until FROM public.community_group_members WHERE group_id = g AND user_id = au) IS DISTINCT FROM until_at THEN RAISE EXCEPTION '0063-member-mute: the member row does not carry the mute'; END IF;
    SELECT count(*) INTO n FROM public.community_posts WHERE group_id = g;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', au::text, true);
    BEGIN PERFORM public.create_thread(g, 't', 'b', NULL, ARRAY[ent]); RAISE EXCEPTION '0063-member-mute: a muted member opened a thread';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      IF SQLERRM <> 'You are muted in this group until ' || to_char(until_at AT TIME ZONE 'UTC', 'FMDD Mon YYYY') || '.' THEN RAISE EXCEPTION '0063-member-mute: the sentence is %', SQLERRM; END IF;
    END;
    BEGIN INSERT INTO public.community_posts (group_id, parent_post_id, author_user_id, body) VALUES (g, p2, au, 'a reply'); RAISE EXCEPTION '0063-member-mute: a muted member replied';
    EXCEPTION WHEN SQLSTATE '42501' THEN GET STACKED DIAGNOSTICS msg = MESSAGE_TEXT; IF msg NOT LIKE 'You are muted in this group until %' THEN RAISE EXCEPTION '0063-member-mute: the reply refusal says %', msg; END IF; END;
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g2, au, 'other group', 'x');
    PERFORM set_config('request.jwt.claim.sub', plain::text, true);
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, plain, 'unmuted', 'x');
    RESET ROLE;
    IF (SELECT count(*) FROM public.community_posts WHERE group_id = g) <> n + 1 THEN RAISE EXCEPTION '0063-member-mute: a refused post left a row behind, or an allowed one is missing'; END IF;

    UPDATE public.community_group_members SET muted_until = now() - interval '1 minute' WHERE group_id = g AND user_id = au;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', au::text, true);
    PERFORM public.create_thread(g, 'after the mute', 'b', NULL, ARRAY[ent]);
    INSERT INTO public.community_posts (group_id, parent_post_id, author_user_id, body) VALUES (g, p2, au, 'a reply after the mute');
    RESET ROLE;

    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0063-member-mute OK (refusals, a real mute, both writes refused with the date, expiry posts again)';
END $$;

COMMIT;
