-- Down for 0063_community_member_mute: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TRIGGER community_group_members_mute_column_trg ON public.community_group_members;
DROP TRIGGER community_posts_mute_guard_trg ON public.community_posts;
ALTER TABLE public.community_group_members DROP COLUMN muted_until;
DROP FUNCTION public.community_group_members_mute_column();
DROP FUNCTION public.community_posts_mute_guard();
DROP FUNCTION public.moderate_report(uuid,text,text,integer);
CREATE OR REPLACE FUNCTION public.moderate_report(p_report_id uuid, p_action text, p_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;
REVOKE ALL ON FUNCTION public.moderate_report(uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.moderate_report(uuid,text,text) TO "service_role";
GRANT EXECUTE ON FUNCTION public.moderate_report(uuid,text,text) TO "authenticated";
