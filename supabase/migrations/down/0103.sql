-- Down for 0103: the new functions, trigger and constraints go; the verification-method check, decide_signoff and the post-delete policy return to their baseline.
DROP TRIGGER community_groups_privacy_guard_trg ON public.community_groups;
DROP FUNCTION public.community_groups_privacy_guard();
DROP FUNCTION public.set_group_privacy(uuid, text, text);
DROP FUNCTION public.moderator_remove_post(uuid, text);
DROP FUNCTION public.admin_mark_verified(uuid, text, text);
DROP FUNCTION public.record_domain_verification(uuid, text, text, jsonb);
ALTER TABLE public.profiles DROP CONSTRAINT profiles_avatar_url_https;
ALTER TABLE public.community_member_profiles DROP CONSTRAINT community_member_profiles_verified_by_system;
ALTER TABLE public.community_member_profiles DROP CONSTRAINT community_member_profiles_verification_method_check;
ALTER TABLE public.community_member_profiles ADD CONSTRAINT community_member_profiles_verification_method_check CHECK (((verification_method IS NULL) OR (verification_method = ANY (ARRAY['corporate-email'::text, 'linkedin'::text, 'write-in'::text]))));
CREATE OR REPLACE FUNCTION public.decide_signoff(p_request_id uuid, p_decision text, p_primary_doc_url text, p_decision_note text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_url text := nullif(btrim(coalesce(p_primary_doc_url, '')), '');
  v_note text := nullif(btrim(coalesce(p_decision_note, '')), '');
  v_now timestamptz := now();
  v_req public.community_post_signoff_requests;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.verifier_status = 'active') OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'Only active verifiers may record a sign-off decision' USING ERRCODE = '42501';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('signed_off', 'declined') THEN
    RAISE EXCEPTION 'The decision is signed_off or declined' USING ERRCODE = '22023';
  END IF;
  IF v_url IS NOT NULL AND v_url !~* '^https?://[^[:space:]]+$' THEN
    RAISE EXCEPTION 'The primary document must be an http or https address' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN
    RAISE EXCEPTION 'A decision note is at most 2000 characters' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_req FROM public.community_post_signoff_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RAISE EXCEPTION 'Sign-off request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.requested_by = v_uid THEN
    RAISE EXCEPTION 'Nobody decides their own sign-off request' USING ERRCODE = '42501';
  END IF;
  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'This request has already been %', replace(v_req.status, '_', ' ') USING ERRCODE = '22023';
  END IF;
  UPDATE public.community_post_signoff_requests
     SET status = p_decision, verifier_id = v_uid, decided_at = v_now, primary_doc_url = v_url, decision_note = v_note
   WHERE id = v_req.id
   RETURNING * INTO v_req;
  IF p_decision = 'signed_off' THEN
    UPDATE public.community_posts SET signed_off_at = v_now, signed_off_by = v_uid WHERE id = v_req.post_id;
  END IF;
  RETURN jsonb_build_object('id', v_req.id, 'post_id', v_req.post_id, 'requested_by', v_req.requested_by, 'status', v_req.status, 'verifier_id', v_req.verifier_id,
    'primary_doc_url', v_req.primary_doc_url, 'decision_note', v_req.decision_note, 'created_at', v_req.created_at, 'decided_at', v_req.decided_at);
END;
$$;

DROP POLICY community_posts_delete_author ON public.community_posts;
CREATE POLICY community_posts_delete_author_or_admin ON public.community_posts FOR DELETE TO authenticated, service_role USING (((author_user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM public.community_group_members m
  WHERE ((m.group_id = community_posts.group_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));
