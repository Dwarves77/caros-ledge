-- 0103 community trust marks that state what was recorded (R2e M3; register rows W:26, W:27, W:30, W:32, W:33; INV-R2e-2).
--
-- The Community said more than the system had recorded: "Verified" meant a domain not in a list of 32 free-mail names (mailinator.com verified), the sign-off badge said "against a primary document" with the document optional,
-- a moderator deleted a post with a bare DELETE (no report, no note, no notice), a moderator could widen a private group to public by API with no record, and any string was accepted as an avatar address.
--   * Verified is a verification the system PERFORMED and RECORDED, two kinds only: 'domain-dns' (the route read the member's DNS TXT proof for the domain of their account address and calls record_domain_verification,
--     service_role only) and 'admin-mark' (admin_mark_verified, a platform admin with a reason). Both write the profile and an admin_events row in one transaction. community_member_profiles_verified_by_system refuses a verified row
--     with any other method (NOT VALID: the legacy corporate-email rows stay until data migration 0105 clears them, and no new one can be written).
--   * decide_signoff refuses a sign-off with no primary document (22023); the document lives on the request row the decision closes, so the badge can name what it was checked against; a post signed off before this has
--     no document and shows no badge.
--   * community_posts delete is the author's alone; a moderator or group admin removes another member's post through moderator_remove_post, which opens the report, requires the note and runs moderate_report (0057) so the
--     report, the removal and the author's notice come from one audited path.
--   * A group's privacy is changed only through set_group_privacy: narrowing (public to private) by the owner or a group admin, WIDENING by the owner alone with a stated reason and an admin_events row. A direct UPDATE of the column
--     by a client role is refused (community_groups_privacy_guard).
--   * profiles.avatar_url must be an https address (NOT VALID, so existing rows are untouched); the page draws an avatar only from the app's own storage origin.
-- Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.record_domain_verification(uuid, text, text, jsonb), public.admin_mark_verified(uuid, text, text), public.set_group_privacy(uuid, text, text), public.moderator_remove_post(uuid, text);
-- DROP TRIGGER community_groups_privacy_guard_trg ON public.community_groups; DROP FUNCTION public.community_groups_privacy_guard(); restore decide_signoff from 0056 and policy community_posts_delete_author_or_admin from schema.sql;
-- ALTER TABLE public.profiles DROP CONSTRAINT profiles_avatar_url_https;
-- ALTER TABLE public.community_member_profiles DROP CONSTRAINT community_member_profiles_verified_by_system; restore community_member_profiles_verification_method_check from schema.sql.

-- catalog: constraint, function, policy, trigger

BEGIN;

ALTER TABLE public.community_member_profiles DROP CONSTRAINT community_member_profiles_verification_method_check;
ALTER TABLE public.community_member_profiles ADD CONSTRAINT community_member_profiles_verification_method_check CHECK (verification_method IS NULL OR verification_method IN ('corporate-email', 'linkedin', 'write-in', 'domain-dns', 'admin-mark'));
ALTER TABLE public.community_member_profiles ADD CONSTRAINT community_member_profiles_verified_by_system CHECK (NOT verified OR verification_method IN ('domain-dns', 'admin-mark')) NOT VALID;

ALTER TABLE public.profiles ADD CONSTRAINT profiles_avatar_url_https CHECK (avatar_url IS NULL OR avatar_url ~ '^https://[^/[:space:]]+/[^[:space:]]*$') NOT VALID;

CREATE FUNCTION public.record_domain_verification(p_user_id uuid, p_domain text, p_organisation_key text, p_evidence jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE r public.community_member_profiles; v_domain text := lower(btrim(coalesce(p_domain, '')));
BEGIN
  IF p_user_id IS NULL OR v_domain !~ '^[a-z0-9.-]+\.[a-z]{2,}$' OR coalesce(p_organisation_key, '') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'a verification needs a member, a domain and an organisation key' USING ERRCODE = '22023'; END IF;
  PERFORM set_config('request.jwt.claim.sub', p_user_id::text, true);
  INSERT INTO public.community_member_profiles (user_id, org_type, verified, verified_at, verification_method, organisation_key)
    VALUES (p_user_id, 'other', true, now(), 'domain-dns', p_organisation_key)
    ON CONFLICT (user_id) DO UPDATE SET verified = true, verified_at = now(), verification_method = 'domain-dns', organisation_key = EXCLUDED.organisation_key, updated_at = now()
    RETURNING * INTO r;
  PERFORM public.record_admin_event(NULL, 'member_verified_domain', 'member', p_user_id::text, NULL, jsonb_build_object('domain', v_domain, 'evidence', coalesce(p_evidence, '{}'::jsonb)));
  RETURN jsonb_build_object('verified', r.verified, 'verified_at', r.verified_at, 'verification_method', r.verification_method);
END;
$$;
REVOKE ALL ON FUNCTION public.record_domain_verification(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_domain_verification(uuid, text, text, jsonb) TO service_role;
COMMENT ON FUNCTION public.record_domain_verification(uuid, text, text, jsonb) IS 'R2e migration 0103. Record a domain-ownership verification the route performed (a DNS TXT proof): the verified columns and the admin_events row in one transaction. service_role only: the proof is the route''s, so no client role can claim it.';

CREATE FUNCTION public.admin_mark_verified(p_user_id uuid, p_organisation_key text, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_reason text := public.admin_require(p_reason); r public.community_member_profiles;
BEGIN
  IF p_user_id IS NULL OR coalesce(p_organisation_key, '') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'a mark needs a member and an organisation key' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM public.profiles WHERE id = p_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'member not found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.community_member_profiles (user_id, org_type, verified, verified_at, verification_method, organisation_key)
    VALUES (p_user_id, 'other', true, now(), 'admin-mark', p_organisation_key)
    ON CONFLICT (user_id) DO UPDATE SET verified = true, verified_at = now(), verification_method = 'admin-mark', organisation_key = EXCLUDED.organisation_key, updated_at = now()
    RETURNING * INTO r;
  PERFORM public.record_admin_event(NULL, 'member_verified_admin', 'member', p_user_id::text, v_reason, '{}'::jsonb);
  RETURN jsonb_build_object('verified', r.verified, 'verified_at', r.verified_at, 'verification_method', r.verification_method);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_mark_verified(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_mark_verified(uuid, text, text) TO authenticated;
COMMENT ON FUNCTION public.admin_mark_verified(uuid, text, text) IS 'R2e migration 0103. A platform admin marks a member verified, with a reason; the mark and its admin_events row are one transaction.';

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
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF NOT (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.verifier_status = 'active') OR public.is_platform_admin()) THEN
    RAISE EXCEPTION 'Only active verifiers may record a sign-off decision' USING ERRCODE = '42501';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('signed_off', 'declined') THEN RAISE EXCEPTION 'The decision is signed_off or declined' USING ERRCODE = '22023'; END IF;
  IF v_url IS NOT NULL AND v_url !~* '^https?://[^[:space:]]+$' THEN RAISE EXCEPTION 'The primary document must be an http or https address' USING ERRCODE = '22023'; END IF;
  IF p_decision = 'signed_off' AND v_url IS NULL THEN RAISE EXCEPTION 'A sign-off names the primary document it was checked against' USING ERRCODE = '22023'; END IF;
  IF v_note IS NOT NULL AND length(v_note) > 2000 THEN RAISE EXCEPTION 'A decision note is at most 2000 characters' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_req FROM public.community_post_signoff_requests WHERE id = p_request_id FOR UPDATE;
  IF v_req.id IS NULL THEN RAISE EXCEPTION 'Sign-off request not found' USING ERRCODE = 'P0002'; END IF;
  IF v_req.requested_by = v_uid THEN RAISE EXCEPTION 'Nobody decides their own sign-off request' USING ERRCODE = '42501'; END IF;
  IF v_req.status <> 'pending' THEN RAISE EXCEPTION 'This request has already been %', replace(v_req.status, '_', ' ') USING ERRCODE = '22023'; END IF;
  UPDATE public.community_post_signoff_requests SET status = p_decision, verifier_id = v_uid, decided_at = v_now, primary_doc_url = v_url, decision_note = v_note WHERE id = v_req.id RETURNING * INTO v_req;
  IF p_decision = 'signed_off' THEN
    UPDATE public.community_posts SET signed_off_at = v_now, signed_off_by = v_uid WHERE id = v_req.post_id;
  END IF;
  RETURN jsonb_build_object('id', v_req.id, 'post_id', v_req.post_id, 'requested_by', v_req.requested_by, 'status', v_req.status, 'verifier_id', v_req.verifier_id,
    'primary_doc_url', v_req.primary_doc_url, 'decision_note', v_req.decision_note, 'created_at', v_req.created_at, 'decided_at', v_req.decided_at);
END;
$$;

DROP POLICY community_posts_delete_author_or_admin ON public.community_posts;
CREATE POLICY community_posts_delete_author ON public.community_posts FOR DELETE TO authenticated USING (author_user_id = (SELECT auth.uid()));

CREATE FUNCTION public.moderator_remove_post(p_post_id uuid, p_notes text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_uid uuid := auth.uid(); v_notes text := nullif(btrim(coalesce(p_notes, '')), ''); p public.community_posts; v_report uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO p FROM public.community_posts WHERE id = p_post_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Post not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT (public.user_is_group_admin(p.group_id, v_uid) OR public.is_platform_admin()) THEN RAISE EXCEPTION 'Moderator or platform admin access required' USING ERRCODE = '42501'; END IF;
  IF p.author_user_id = v_uid THEN RAISE EXCEPTION 'Delete your own post directly' USING ERRCODE = '22023'; END IF;
  IF v_notes IS NULL THEN RAISE EXCEPTION 'A removal needs a note for the author and the record' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason, status) VALUES ('post', p.id, v_uid, 'moderator removal', 'open') RETURNING id INTO v_report;
  RETURN public.moderate_report(v_report, 'remove', v_notes);
END;
$$;
REVOKE ALL ON FUNCTION public.moderator_remove_post(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.moderator_remove_post(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.moderator_remove_post(uuid, text) IS 'R2e migration 0103. A moderator or group admin removes another member''s post: the report is opened and closed with the note through moderate_report in one transaction, so a removal always has its record and notice.';

CREATE FUNCTION public.community_groups_privacy_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NEW.privacy IS DISTINCT FROM OLD.privacy AND NOT public.is_sanctioned_writer('public.community_groups'::regclass) THEN
    RAISE EXCEPTION 'community_groups_privacy_guard: a group''s privacy is changed through set_group_privacy; current_user=%', current_user USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.community_groups_privacy_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER community_groups_privacy_guard_trg BEFORE UPDATE OF privacy ON public.community_groups FOR EACH ROW EXECUTE FUNCTION public.community_groups_privacy_guard();

CREATE FUNCTION public.set_group_privacy(p_group_id uuid, p_privacy text, p_reason text DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_uid uuid := auth.uid(); g public.community_groups; v_reason text := nullif(btrim(coalesce(p_reason, '')), ''); v_admin boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_privacy IS NULL OR p_privacy NOT IN ('public', 'private') THEN RAISE EXCEPTION 'The privacy is public or private' USING ERRCODE = '22023'; END IF;
  SELECT * INTO g FROM public.community_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Group not found' USING ERRCODE = 'P0002'; END IF;
  IF g.privacy = p_privacy THEN RETURN jsonb_build_object('id', g.id, 'privacy', g.privacy); END IF;
  SELECT EXISTS (SELECT 1 FROM public.community_group_members m WHERE m.group_id = g.id AND m.user_id = v_uid AND m.role = 'admin') INTO v_admin;
  IF p_privacy = 'private' THEN
    IF g.owner_user_id IS DISTINCT FROM v_uid AND NOT v_admin THEN RAISE EXCEPTION 'Only the owner or a group admin can make a group private' USING ERRCODE = '42501'; END IF;
  ELSE
    IF g.owner_user_id IS DISTINCT FROM v_uid THEN RAISE EXCEPTION 'Only the owner can make a private group public: its past threads become visible to everyone' USING ERRCODE = '42501'; END IF;
    IF v_reason IS NULL THEN RAISE EXCEPTION 'A reason is required to make a group public' USING ERRCODE = '22023'; END IF;
  END IF;
  UPDATE public.community_groups SET privacy = p_privacy WHERE id = g.id;
  PERFORM public.record_admin_event(NULL, CASE WHEN p_privacy = 'public' THEN 'group_privacy_widened' ELSE 'group_privacy_narrowed' END, 'community_group', g.id::text, v_reason, jsonb_build_object('from', g.privacy, 'to', p_privacy));
  RETURN jsonb_build_object('id', g.id, 'privacy', p_privacy);
END;
$$;
REVOKE ALL ON FUNCTION public.set_group_privacy(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_group_privacy(uuid, text, text) TO authenticated;
COMMENT ON FUNCTION public.set_group_privacy(uuid, text, text) IS 'R2e migration 0103. The only way a group''s privacy changes: narrowing by the owner or a group admin; widening by the owner alone, with a reason, with an admin_events row.';

-- Self-check 0103-community-trust, in a fixture that rolls back. VERIFIED: no client role can run record_domain_verification; it records a 'domain-dns' verification with its event naming the member as actor; a verified row with the legacy method
-- 'corporate-email' is refused by the check; a non-admin cannot mark, an admin needs a reason and the mark carries its event. SIGN-OFF: a verifier signing off with no document is refused, with a document the request row carries it; a decline needs none.
-- DELETE: an admin''s direct DELETE of another member''s post removes nothing, the author''s removes it; moderator_remove_post needs a note, refuses the author, a plain member and a stranger, and with a note leaves the post gone and the report
-- closed with action remove. PRIVACY: an admin narrows (event), cannot widen, a direct UPDATE of the column is refused, the owner widens only with a reason (event). AVATAR: an http address and a javascript: one are refused, https is accepted.
DO $$
DECLARE
  g uuid := gen_random_uuid(); uo uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); um uuid := gen_random_uuid(); uu uuid := gen_random_uuid(); ver uuid := gen_random_uuid(); up uuid := gen_random_uuid();
  key text := repeat('a', 64); p1 uuid; p2 uuid; p3 uuid; r1 uuid; r2 uuid; res jsonb; n int;
BEGIN
  IF has_function_privilege('authenticated', 'public.record_domain_verification(uuid, text, text, jsonb)', 'EXECUTE') OR has_function_privilege('anon', 'public.moderator_remove_post(uuid, text)', 'EXECUTE') OR has_function_privilege('anon', 'public.set_group_privacy(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0103-community-trust: a client role can execute a function it must not';
  END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (uo, 'o-0103@invalid.example'), (ua, 'a-0103@invalid.example'), (um, 'm-0103@invalid.example'), (uu, 'u-0103@invalid.example'), (ver, 'v-0103@invalid.example'), (up, 'p-0103@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (uo, 'o-0103@invalid.example'), (ua, 'a-0103@invalid.example'), (um, 'm-0103@invalid.example'), (uu, 'u-0103@invalid.example'), (ver, 'v-0103@invalid.example'), (up, 'p-0103@invalid.example');
    UPDATE public.profiles SET verifier_status = 'active' WHERE id = ver;
    UPDATE public.profiles SET is_platform_admin = true WHERE id = up;
    INSERT INTO public.community_groups (id, name, slug, region, privacy, owner_user_id) VALUES (g, 'g', 'g-0103-' || g, 'GLOBAL', 'private', uo);
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g, uo, 'admin'), (g, ua, 'admin'), (g, um, 'member');
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, um, 'p1', 'x') RETURNING id INTO p1;
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, um, 'p2', 'x') RETURNING id INTO p2;
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, ua, 'p3', 'x') RETURNING id INTO p3;

    -- verification
    res := public.record_domain_verification(um, 'Example-0103.test', key, '{"txt":"caros-ledge-verification=abc"}'::jsonb);
    IF res ->> 'verification_method' <> 'domain-dns' OR (SELECT count(*) FROM public.admin_events WHERE action = 'member_verified_domain' AND actor_id = um AND target_id = um::text AND detail ->> 'domain' = 'example-0103.test') <> 1 THEN RAISE EXCEPTION '0103-community-trust: the domain verification or its event is wrong: %', res; END IF;
    BEGIN UPDATE public.community_member_profiles SET verification_method = 'corporate-email' WHERE user_id = um; RAISE EXCEPTION '0103-community-trust: a legacy verification method was accepted on a verified row'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.record_domain_verification(uu, 'bad domain', key, NULL); RAISE EXCEPTION '0103-community-trust: a malformed domain was accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    BEGIN PERFORM public.admin_mark_verified(uu, key, 'known to us'); RAISE EXCEPTION '0103-community-trust: a member marked someone verified'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.record_domain_verification(um, 'example-0103.test', key, NULL); RAISE EXCEPTION '0103-community-trust: a member claimed their own domain verification'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', up::text, true);
    BEGIN PERFORM public.admin_mark_verified(uu, key, ''); RAISE EXCEPTION '0103-community-trust: a mark with no reason was accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    res := public.admin_mark_verified(uu, key, 'confirmed by phone');
    RESET ROLE;
    IF res ->> 'verification_method' <> 'admin-mark' OR (SELECT count(*) FROM public.admin_events WHERE action = 'member_verified_admin' AND actor_id = up AND target_id = uu::text AND reason = 'confirmed by phone') <> 1 THEN RAISE EXCEPTION '0103-community-trust: the admin mark or its event is wrong: %', res; END IF;

    -- sign-off needs a document
    INSERT INTO public.community_post_signoff_requests (post_id, requested_by) VALUES (p1, um) RETURNING id INTO r1;
    INSERT INTO public.community_post_signoff_requests (post_id, requested_by) VALUES (p2, um) RETURNING id INTO r2;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ver::text, true);
    BEGIN PERFORM public.decide_signoff(r1, 'signed_off', NULL, 'looks right'); RAISE EXCEPTION '0103-community-trust: a sign-off with no document was accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    PERFORM public.decide_signoff(r1, 'signed_off', 'https://doc.example/primary', NULL);
    PERFORM public.decide_signoff(r2, 'declined', NULL, 'not primary');
    RESET ROLE;
    IF (SELECT primary_doc_url FROM public.community_post_signoff_requests WHERE id = r1) <> 'https://doc.example/primary' OR (SELECT signed_off_at FROM public.community_posts WHERE id = p1) IS NULL OR (SELECT signed_off_at FROM public.community_posts WHERE id = p2) IS NOT NULL THEN RAISE EXCEPTION '0103-community-trust: the sign-off stamp is wrong'; END IF;

    -- delete: the author alone directly; a moderator through the audited path with a note
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    DELETE FROM public.community_posts WHERE id = p2;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION '0103-community-trust: an admin deleted another member''s post directly'; END IF;
    BEGIN PERFORM public.moderator_remove_post(p2, '  '); RAISE EXCEPTION '0103-community-trust: a removal with no note was accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.moderator_remove_post(p3, 'my own'); RAISE EXCEPTION '0103-community-trust: a moderator removed their own post through the audited path'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', uu::text, true);
    BEGIN PERFORM public.moderator_remove_post(p2, 'spam'); RAISE EXCEPTION '0103-community-trust: a stranger removed a post'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    res := public.moderator_remove_post(p2, 'off topic advert');
    IF res ->> 'action' <> 'remove' OR res ->> 'status' <> 'resolved' OR (res ->> 'notify_user_id')::uuid <> um THEN RAISE EXCEPTION '0103-community-trust: the removal answered %', res; END IF;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    DELETE FROM public.community_posts WHERE id = p1;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION '0103-community-trust: the author could not delete their own post'; END IF;
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.community_posts WHERE id = p2) OR (SELECT count(*) FROM public.moderation_reports WHERE target_id = p2 AND status = 'resolved' AND action = 'remove' AND notes = 'off topic advert' AND resolved_by_user_id = ua) <> 1 THEN
      RAISE EXCEPTION '0103-community-trust: the removal left the post or no closed report';
    END IF;

    -- privacy: private now; an admin can only narrow; the owner widens with a reason and an event
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    BEGIN PERFORM public.set_group_privacy(g, 'public', 'let them in'); RAISE EXCEPTION '0103-community-trust: an admin widened a group'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN UPDATE public.community_groups SET privacy = 'public' WHERE id = g; RAISE EXCEPTION '0103-community-trust: a direct UPDATE widened a group'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    UPDATE public.community_groups SET name = 'renamed by admin' WHERE id = g;
    PERFORM set_config('request.jwt.claim.sub', uo::text, true);
    BEGIN PERFORM public.set_group_privacy(g, 'public', NULL); RAISE EXCEPTION '0103-community-trust: widening with no reason was accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    res := public.set_group_privacy(g, 'public', 'open the regional room');
    PERFORM public.set_group_privacy(g, 'private', NULL);
    RESET ROLE;
    IF (SELECT privacy FROM public.community_groups WHERE id = g) <> 'private' OR (SELECT name FROM public.community_groups WHERE id = g) <> 'renamed by admin'
       OR (SELECT count(*) FROM public.admin_events WHERE target_id = g::text AND action = 'group_privacy_widened' AND reason = 'open the regional room' AND actor_id = uo) <> 1
       OR (SELECT count(*) FROM public.admin_events WHERE target_id = g::text AND action = 'group_privacy_narrowed' AND actor_id = uo) <> 1 THEN RAISE EXCEPTION '0103-community-trust: privacy state or events are wrong'; END IF;

    -- avatar
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    BEGIN UPDATE public.profiles SET avatar_url = 'http://tracker.example/a.png' WHERE id = um; RAISE EXCEPTION '0103-community-trust: an http avatar was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.profiles SET avatar_url = 'javascript:alert(1)' WHERE id = um; RAISE EXCEPTION '0103-community-trust: a javascript avatar was accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
    UPDATE public.profiles SET avatar_url = 'https://img.example/a.png' WHERE id = um;
    UPDATE public.profiles SET avatar_url = NULL WHERE id = um;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0103-community-trust OK';
END $$;

COMMIT;
