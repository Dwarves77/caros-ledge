-- 0059 community_notification_counts (P2-16, community-b register section 7, notifications/counts: B-1885).
--
-- The per-group unread pills read every unread notification row of the caller with no limit and counted them in the route, so past the API's row cap the pills were short. This is the grouped count in SQL:
--   community_notification_counts() -> (group_id, unread_count)
-- One row per group the caller has unread notifications for (the group id is the notification payload's group_id), plus one row with a null group_id for unread notifications that name no group, so the rows sum to the
-- caller's total unread. Security definer, filtered to auth.uid() inside the function: it returns the caller's own counts and nobody else's (a caller with no session gets no rows). Executable by authenticated and service_role. Mentions are
-- not counted: nothing writes a mention notification. Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.community_notification_counts().

-- catalog: function

BEGIN;

CREATE FUNCTION public.community_notification_counts() RETURNS TABLE(group_id text, unread_count bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT n.payload ->> 'group_id', count(*) FROM public.notifications n WHERE n.user_id = auth.uid() AND n.read_at IS NULL GROUP BY n.payload ->> 'group_id' ORDER BY 1 NULLS LAST
$$;
REVOKE ALL ON FUNCTION public.community_notification_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.community_notification_counts() TO authenticated, service_role;
COMMENT ON FUNCTION public.community_notification_counts() IS 'The caller''s unread notification counts per group (P2-16 migration 0059).';

-- Self-check 0059-notification-counts: anon cannot execute; with no session it returns nothing; a caller sees only their own unread rows, grouped (two in one group, one in another, one with no group), a read row is not counted,
-- another user's rows are never counted, and the counts sum to the caller's total unread.
DO $$
DECLARE me uuid := gen_random_uuid(); other uuid := gen_random_uuid(); ga text := gen_random_uuid()::text; gb text := gen_random_uuid()::text; n bigint; total bigint;
BEGIN
  IF has_function_privilege('anon', 'public.community_notification_counts()', 'EXECUTE') THEN RAISE EXCEPTION '0059-notification-counts: anon can execute it'; END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (me, 'me-0059@invalid.example'), (other, 'other-0059@invalid.example');
    INSERT INTO public.notifications (user_id, kind, payload, read_at) VALUES
      (me, 'reply', jsonb_build_object('group_id', ga), NULL), (me, 'invite', jsonb_build_object('group_id', ga), NULL), (me, 'reply', jsonb_build_object('group_id', gb), NULL),
      (me, 'archive', '{}'::jsonb, NULL), (me, 'reply', jsonb_build_object('group_id', ga), now()), (other, 'reply', jsonb_build_object('group_id', ga), NULL);
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    SELECT count(*) INTO n FROM public.community_notification_counts();
    IF n <> 0 THEN RAISE EXCEPTION '0059-notification-counts: % rows with no session', n; END IF;
    PERFORM set_config('request.jwt.claim.sub', me::text, true);
    SELECT unread_count INTO n FROM public.community_notification_counts() WHERE group_id = ga;
    IF n <> 2 THEN RAISE EXCEPTION '0059-notification-counts: group A counts %, expected 2 (a read row and another user''s row are not counted)', n; END IF;
    SELECT unread_count INTO n FROM public.community_notification_counts() WHERE group_id = gb;
    IF n <> 1 THEN RAISE EXCEPTION '0059-notification-counts: group B counts %, expected 1', n; END IF;
    SELECT unread_count INTO n FROM public.community_notification_counts() WHERE group_id IS NULL;
    IF n <> 1 THEN RAISE EXCEPTION '0059-notification-counts: the no-group row counts %, expected 1', n; END IF;
    SELECT sum(unread_count) INTO total FROM public.community_notification_counts();
    IF total <> 4 THEN RAISE EXCEPTION '0059-notification-counts: the counts sum to %, expected the 4 unread', total; END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0059-notification-counts OK';
END $$;

COMMIT;
