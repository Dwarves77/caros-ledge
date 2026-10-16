-- 0028 accept and decline an invitation by id (P2-02b, owed by the P2-S3 addendum on 0018).
--
-- Since 0018 an invitation row holds sha256(token) and the last four characters only, and the invitee's in-app list (`invitations/mine`) carries
-- token_last4: the raw token is no longer there to send. The in-app Accept and Decline controls act on the row's id instead, in the same rpc
-- family, with the same rules as the token path. The e-mailed or copied link keeps using the raw token.
--   * accept_invitation_by_id(p_invitation_id) and decline_invitation_by_id(p_invitation_id) are SECURITY DEFINER, search_path pinned, executable
--     by authenticated and service_role only. They are the ONE home of the rules: authentication, the caller's auth e-mail equal to the invited
--     e-mail (checked BEFORE the row's status is revealed), pending, not expired, not banned from the org, a role that never downgrades an
--     existing membership. accept_invitation(p_token) and decline_invitation(p_token) now resolve the token's hash to the id and call these, so
--     the two entry points cannot drift apart.
--   * Nothing else changes: lookup_invitation, revoke_invitation, the ban trigger and the membership guard are untouched.
-- Not applied to production before the cutover window.
--
-- Reversal: restore accept_invitation and decline_invitation from 0018, then DROP FUNCTION both *_by_id functions.

-- catalog: function

BEGIN;

CREATE FUNCTION public.accept_invitation_by_id(p_invitation_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_invitation public.org_invitations;
  v_caller_id  uuid;
  v_caller_email text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT lower(u.email) INTO v_caller_email FROM auth.users u WHERE u.id = v_caller_id;
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'Caller email not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_invitation FROM public.org_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF v_invitation IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.invited_email <> v_caller_email THEN
    RAISE EXCEPTION 'Invitation is for a different email' USING ERRCODE = '42501';
  END IF;
  IF v_invitation.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is %', v_invitation.status USING ERRCODE = '22023';
  END IF;
  IF v_invitation.expires_at <= now() THEN
    UPDATE public.org_invitations SET status = 'expired' WHERE id = v_invitation.id;
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.org_member_bans b WHERE b.org_id = v_invitation.org_id AND b.user_id = v_caller_id) THEN
    RAISE EXCEPTION 'This account is banned from the workspace' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.org_memberships (org_id, user_id, role)
  VALUES (v_invitation.org_id, v_caller_id, v_invitation.proposed_role)
  ON CONFLICT (org_id, user_id) DO UPDATE
    SET role = EXCLUDED.role
    WHERE (org_memberships.role = 'viewer' AND EXCLUDED.role IN ('member', 'admin'))
       OR (org_memberships.role = 'member' AND EXCLUDED.role = 'admin');

  UPDATE public.org_invitations
  SET status = 'accepted', accepted_at = now(), accepted_by_user_id = v_caller_id
  WHERE id = v_invitation.id;

  RETURN v_invitation.org_id;
END;
$$;

CREATE FUNCTION public.decline_invitation_by_id(p_invitation_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_invitation public.org_invitations;
  v_caller_id  uuid;
  v_caller_email text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT lower(u.email) INTO v_caller_email FROM auth.users u WHERE u.id = v_caller_id;

  SELECT * INTO v_invitation FROM public.org_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF v_invitation IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.invited_email <> COALESCE(v_caller_email, '') THEN
    RAISE EXCEPTION 'Invitation is for a different email' USING ERRCODE = '42501';
  END IF;
  IF v_invitation.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is %', v_invitation.status USING ERRCODE = '22023';
  END IF;

  UPDATE public.org_invitations SET status = 'declined', declined_at = now() WHERE id = v_invitation.id;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_invitation_by_id(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decline_invitation_by_id(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_invitation_by_id(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decline_invitation_by_id(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.accept_invitation_by_id(uuid) IS 'Accept an org invitation by id (the in-app list, which carries no raw token). The one home of the accept rules; accept_invitation(token) calls it. P2-02b migration 0028.';
COMMENT ON FUNCTION public.decline_invitation_by_id(uuid) IS 'Decline an org invitation by id. The one home of the decline rules; decline_invitation(token) calls it. P2-02b migration 0028.';

-- The token entry points keep their signatures and grants; they resolve the hash to the id and delegate. The caller is authenticated first, so an
-- anonymous probe learns nothing about which tokens exist.
CREATE OR REPLACE FUNCTION public.accept_invitation(p_token text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_id FROM public.org_invitations WHERE token_hash = public.invitation_token_hash(p_token);
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN public.accept_invitation_by_id(v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.decline_invitation(p_token text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE v_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_id FROM public.org_invitations WHERE token_hash = public.invitation_token_hash(p_token);
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.decline_invitation_by_id(v_id);
END;
$$;

-- Self-check 0028-invitation-by-id: as role `authenticated` (RLS on, the real grants): anon cannot execute either function; no session is refused;
-- another user's account cannot accept or decline an invitation addressed to someone else (nothing changes, no membership appears); the invitee
-- accepts by id and gets the proposed role, a second accept is refused; a banned account is refused by the function itself (the trigger behind it is a second wall, not this one); an expired invitation is refused and never
-- joins; an unknown id is not found; an invitee who is already an admin is not downgraded; decline by id works once and then refuses; and the
-- token entry points still resolve (accept by the raw token, a wrong token, no session) through the same rules.
DO $$
DECLARE
  org uuid := gen_random_uuid(); inviter uuid := gen_random_uuid(); invitee uuid := gen_random_uuid(); stranger uuid := gen_random_uuid();
  banned uuid := gen_random_uuid(); veteran uuid := gen_random_uuid(); late uuid := gen_random_uuid();
  raw1 text := encode(sha256(convert_to('0028-one-' || clock_timestamp()::text, 'UTF8')), 'hex');
  raw2 text := encode(sha256(convert_to('0028-two-' || clock_timestamp()::text, 'UTF8')), 'hex');
  inv1 uuid; inv2 uuid; inv3 uuid; inv4 uuid; inv6 uuid; got uuid; r text;
BEGIN
  IF has_function_privilege('anon', 'public.accept_invitation_by_id(uuid)', 'EXECUTE') OR has_function_privilege('anon', 'public.decline_invitation_by_id(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0028-invitation-by-id: anon can execute an invitation action';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.accept_invitation_by_id(uuid)', 'EXECUTE') THEN RAISE EXCEPTION '0028-invitation-by-id: authenticated cannot execute accept'; END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (inviter, 'inviter-0028@invalid.example'), (invitee, 'invitee-0028@invalid.example'), (stranger, 'stranger-0028@invalid.example'),
      (banned, 'banned-0028@invalid.example'), (veteran, 'veteran-0028@invalid.example'), (late, 'late-0028@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (inviter, 'inviter-0028@invalid.example'), (invitee, 'invitee-0028@invalid.example'), (stranger, 'stranger-0028@invalid.example'),
      (banned, 'banned-0028@invalid.example'), (veteran, 'veteran-0028@invalid.example'), (late, 'late-0028@invalid.example');
    INSERT INTO public.organizations (id, name, slug) VALUES (org, 'selfcheck-0028', 'selfcheck-0028-' || org);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, inviter, 'owner'), (org, veteran, 'admin');
    INSERT INTO public.org_member_bans (org_id, user_id) VALUES (org, banned);
    INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input) VALUES (org, 'invitee-0028@invalid.example', inviter, 'member', raw1) RETURNING id INTO inv1;
    INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input) VALUES (org, 'banned-0028@invalid.example', inviter, 'member', encode(sha256(convert_to('0028-b', 'UTF8')), 'hex')) RETURNING id INTO inv2;
    INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input, expires_at) VALUES (org, 'late-0028@invalid.example', inviter, 'member', encode(sha256(convert_to('0028-e', 'UTF8')), 'hex'), now() - interval '1 day') RETURNING id INTO inv3;
    INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input) VALUES (org, 'veteran-0028@invalid.example', inviter, 'member', encode(sha256(convert_to('0028-v', 'UTF8')), 'hex')) RETURNING id INTO inv4;
    INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input) VALUES (org, 'stranger-0028@invalid.example', inviter, 'viewer', raw2);

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN PERFORM public.accept_invitation_by_id(inv1); RAISE EXCEPTION '0028-invitation-by-id: accepted with no session';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.decline_invitation_by_id(inv1); RAISE EXCEPTION '0028-invitation-by-id: declined with no session';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

    PERFORM set_config('request.jwt.claim.sub', stranger::text, true);
    BEGIN PERFORM public.accept_invitation_by_id(inv1); RAISE EXCEPTION '0028-invitation-by-id: a stranger accepted someone else''s invitation';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.decline_invitation_by_id(inv1); RAISE EXCEPTION '0028-invitation-by-id: a stranger declined someone else''s invitation';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    RESET ROLE;
    IF (SELECT status FROM public.org_invitations WHERE id = inv1) <> 'pending' OR EXISTS (SELECT 1 FROM public.org_memberships WHERE org_id = org AND user_id = stranger) THEN
      RAISE EXCEPTION '0028-invitation-by-id: a refused stranger still changed state';
    END IF;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', late::text, true);
    BEGIN PERFORM public.accept_invitation_by_id(inv3); RAISE EXCEPTION '0028-invitation-by-id: an expired invitation was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.org_memberships WHERE org_id = org AND user_id = late) THEN RAISE EXCEPTION '0028-invitation-by-id: an expired invitation joined'; END IF;
    SET LOCAL ROLE authenticated;
    BEGIN PERFORM public.accept_invitation_by_id(gen_random_uuid()); RAISE EXCEPTION '0028-invitation-by-id: an unknown id was accepted';
    EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;

    PERFORM set_config('request.jwt.claim.sub', invitee::text, true);
    got := public.accept_invitation_by_id(inv1);
    IF got <> org THEN RAISE EXCEPTION '0028-invitation-by-id: accept returned %', got; END IF;
    RESET ROLE;
    IF (SELECT role FROM public.org_memberships WHERE org_id = org AND user_id = invitee) <> 'member' OR (SELECT status FROM public.org_invitations WHERE id = inv1) <> 'accepted' THEN
      RAISE EXCEPTION '0028-invitation-by-id: the accept did not join as the proposed role';
    END IF;
    SET LOCAL ROLE authenticated;
    BEGIN PERFORM public.accept_invitation_by_id(inv1); RAISE EXCEPTION '0028-invitation-by-id: an accepted invitation was accepted twice';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.decline_invitation_by_id(inv1); RAISE EXCEPTION '0028-invitation-by-id: an accepted invitation was declined';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

    PERFORM set_config('request.jwt.claim.sub', banned::text, true);
    BEGIN PERFORM public.accept_invitation_by_id(inv2); RAISE EXCEPTION '0028-invitation-by-id: a banned account joined';
    EXCEPTION WHEN SQLSTATE '42501' THEN
      IF SQLERRM <> 'This account is banned from the workspace' THEN RAISE EXCEPTION '0028-invitation-by-id: the ban was refused by the backstop trigger, not by the function: %', SQLERRM; END IF;
    END;

    PERFORM set_config('request.jwt.claim.sub', veteran::text, true);
    PERFORM public.accept_invitation_by_id(inv4);
    RESET ROLE;
    IF (SELECT role FROM public.org_memberships WHERE org_id = org AND user_id = veteran) <> 'admin' THEN RAISE EXCEPTION '0028-invitation-by-id: an admin was downgraded by an invitation'; END IF;

    -- the invitee's first invitation is accepted, so a second pending one is allowed
    INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input) VALUES (org, 'invitee-0028@invalid.example', inviter, 'admin', encode(sha256(convert_to('0028-d', 'UTF8')), 'hex')) RETURNING id INTO inv6;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', invitee::text, true);
    PERFORM public.decline_invitation_by_id(inv6);
    BEGIN PERFORM public.decline_invitation_by_id(inv6); RAISE EXCEPTION '0028-invitation-by-id: declined twice';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    RESET ROLE;
    SELECT status INTO r FROM public.org_invitations WHERE id = inv6;
    IF r <> 'declined' THEN RAISE EXCEPTION '0028-invitation-by-id: decline left status %', r; END IF;

    -- The token entry points still work, through the same rules.
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', stranger::text, true);
    got := public.accept_invitation(raw2);
    IF got <> org THEN RAISE EXCEPTION '0028-invitation-by-id: accept by the raw token returned %', got; END IF;
    BEGIN PERFORM public.accept_invitation(repeat('0', 64)); RAISE EXCEPTION '0028-invitation-by-id: a wrong token resolved';
    EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN PERFORM public.accept_invitation(raw1); RAISE EXCEPTION '0028-invitation-by-id: the token path accepted with no session';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0028-invitation-by-id OK';
END $$;

COMMIT;
