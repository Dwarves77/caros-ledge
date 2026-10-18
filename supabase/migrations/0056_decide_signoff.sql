-- 0056 decide_signoff (P2-16, INV-241).
--
-- A verifier's decision was two writes on two clients (the request on the verifier's, the post's citable stamp on the service role) and a stamp that failed was answered 200 with a warning. The rpc is one transaction:
--   decide_signoff(p_request_id, p_decision, p_primary_doc_url, p_decision_note) -> jsonb (the request row)
-- Rules, in order: a session (42501); the caller is an ACTIVE verifier (profiles.verifier_status = 'active') or a platform admin by is_platform_admin() (42501); the decision is signed_off or declined, the document is an
-- http(s) address, the note is at most 2000 characters (22023); the request exists (P0002); the caller did not make the request (42501: nobody decides their own); it is pending (22023, so a decided request never
-- changes). A signed_off decision stamps the post (signed_off_at, signed_off_by) in the same transaction as the decision; a declined one does not.
-- Executable by authenticated and service_role. Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.decide_signoff(uuid, text, text, text).

-- catalog: function

BEGIN;

CREATE FUNCTION public.decide_signoff(p_request_id uuid, p_decision text, p_primary_doc_url text, p_decision_note text) RETURNS jsonb
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
REVOKE ALL ON FUNCTION public.decide_signoff(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_signoff(uuid, text, text, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.decide_signoff(uuid, text, text, text) IS 'Record a sign-off decision and stamp the post in one transaction; active verifier or platform admin only (P2-16 migration 0056, INV-241).';

-- Self-check 0056-decide-signoff: anon cannot execute; no session, an ordinary member and a verifier whose status is not active are refused with the request and post unchanged; an active verifier signs off: the request AND the post
-- stamp change together; a declined decision does not stamp; a second decision is refused and changes nothing; the requester cannot decide their own request; a platform admin may decide; a bad decision, a non-http document and an
-- unknown request are refused.
DO $$
DECLARE g uuid := gen_random_uuid(); req uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); ver uuid := gen_random_uuid(); lapsed uuid := gen_random_uuid(); adm uuid := gen_random_uuid();
  p1 uuid; p2 uuid; p3 uuid; r1 uuid; r2 uuid; r3 uuid; res jsonb;
BEGIN
  IF has_function_privilege('anon', 'public.decide_signoff(uuid, text, text, text)', 'EXECUTE') THEN RAISE EXCEPTION '0056-decide-signoff: anon can execute it'; END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (req, 'req-0056@invalid.example'), (mem, 'mem-0056@invalid.example'), (ver, 'ver-0056@invalid.example'), (lapsed, 'lap-0056@invalid.example'), (adm, 'adm-0056@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (req, 'req-0056@invalid.example'), (mem, 'mem-0056@invalid.example'), (ver, 'ver-0056@invalid.example'), (lapsed, 'lap-0056@invalid.example'), (adm, 'adm-0056@invalid.example');
    UPDATE public.profiles SET verifier_status = 'active' WHERE id = ver;
    UPDATE public.profiles SET verifier_status = 'revoked' WHERE id = lapsed;
    UPDATE public.profiles SET is_platform_admin = true WHERE id = adm;
    INSERT INTO public.community_groups (id, name, slug, region, privacy, owner_user_id) VALUES (g, 'g', 'g-0056-' || g, 'GLOBAL', 'public', req);
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g, req, 'admin');
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, req, 'a', 'a') RETURNING id INTO p1;
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, req, 'b', 'b') RETURNING id INTO p2;
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, req, 'c', 'c') RETURNING id INTO p3;
    INSERT INTO public.community_post_signoff_requests (post_id, requested_by) VALUES (p1, req) RETURNING id INTO r1;
    INSERT INTO public.community_post_signoff_requests (post_id, requested_by) VALUES (p2, mem) RETURNING id INTO r2;
    INSERT INTO public.community_post_signoff_requests (post_id, requested_by) VALUES (p3, ver) RETURNING id INTO r3;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN PERFORM public.decide_signoff(r1, 'signed_off', NULL, NULL); RAISE EXCEPTION '0056-decide-signoff: decided with no session';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', mem::text, true);
    BEGIN PERFORM public.decide_signoff(r1, 'signed_off', NULL, NULL); RAISE EXCEPTION '0056-decide-signoff: an ordinary member decided';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', lapsed::text, true);
    BEGIN PERFORM public.decide_signoff(r1, 'signed_off', NULL, NULL); RAISE EXCEPTION '0056-decide-signoff: a revoked verifier decided';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    RESET ROLE;
    IF (SELECT status FROM public.community_post_signoff_requests WHERE id = r1) <> 'pending' OR (SELECT signed_off_at FROM public.community_posts WHERE id = p1) IS NOT NULL THEN
      RAISE EXCEPTION '0056-decide-signoff: a refused decision still changed state';
    END IF;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ver::text, true);
    BEGIN PERFORM public.decide_signoff(r1, 'maybe', NULL, NULL); RAISE EXCEPTION '0056-decide-signoff: a decision outside the vocabulary was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.decide_signoff(r1, 'signed_off', 'ftp://x.example/doc', NULL); RAISE EXCEPTION '0056-decide-signoff: a non-http document was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.decide_signoff(gen_random_uuid(), 'signed_off', NULL, NULL); RAISE EXCEPTION '0056-decide-signoff: an unknown request was decided';
    EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
    BEGIN PERFORM public.decide_signoff(r3, 'signed_off', NULL, NULL); RAISE EXCEPTION '0056-decide-signoff: a verifier decided their own request';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    res := public.decide_signoff(r1, 'signed_off', 'https://doc.example/primary', ' checked ');
    IF res ->> 'status' <> 'signed_off' OR res ->> 'decision_note' <> 'checked' OR (res ->> 'verifier_id')::uuid <> ver THEN RAISE EXCEPTION '0056-decide-signoff: the returned row is wrong: %', res; END IF;
    BEGIN PERFORM public.decide_signoff(r1, 'declined', NULL, NULL); RAISE EXCEPTION '0056-decide-signoff: a decided request was decided again';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    PERFORM public.decide_signoff(r2, 'declined', NULL, 'not primary');
    PERFORM set_config('request.jwt.claim.sub', adm::text, true);
    PERFORM public.decide_signoff(r3, 'signed_off', NULL, NULL);
    RESET ROLE;
    IF (SELECT signed_off_by FROM public.community_posts WHERE id = p1) IS DISTINCT FROM ver OR (SELECT signed_off_at FROM public.community_posts WHERE id = p1) IS NULL THEN RAISE EXCEPTION '0056-decide-signoff: the post was not stamped with the decision'; END IF;
    IF (SELECT decided_at FROM public.community_post_signoff_requests WHERE id = r1) IS DISTINCT FROM (SELECT signed_off_at FROM public.community_posts WHERE id = p1) THEN RAISE EXCEPTION '0056-decide-signoff: the decision and the stamp are not one instant'; END IF;
    IF (SELECT signed_off_at FROM public.community_posts WHERE id = p2) IS NOT NULL THEN RAISE EXCEPTION '0056-decide-signoff: a declined decision stamped the post'; END IF;
    IF (SELECT signed_off_by FROM public.community_posts WHERE id = p3) IS DISTINCT FROM adm THEN RAISE EXCEPTION '0056-decide-signoff: a platform admin''s decision did not stamp'; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0056-decide-signoff OK';
END $$;

COMMIT;
