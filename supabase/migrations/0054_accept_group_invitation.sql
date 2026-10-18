-- 0054 accept_group_invitation (P2-16, INV-240).
--
-- Accepting a group invitation was two writes on two clients (the status on the invitee's, the membership on the service role) with a compensating write nobody checked. The rpc is one transaction, the same shape as
-- accept_invitation_by_id for organisations:
--   accept_group_invitation(p_invitation_id) -> uuid (the group id)
-- Rules, in order: a session is required (42501); the invitation exists (P0002); the caller IS the invitee (42501, checked BEFORE the status is revealed, so a stranger learns nothing); it is pending (22023); the
-- caller is not banned from the group (42501); then the membership is inserted (a member already there is not an error) and the invitation is marked accepted. The ban guard trigger of 0050 is a second wall.
-- Executable by authenticated and service_role. Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.accept_group_invitation(uuid).

-- catalog: function

BEGIN;

CREATE FUNCTION public.accept_group_invitation(p_invitation_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_inv public.community_group_invitations;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_inv FROM public.community_group_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF v_inv.id IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_inv.invitee_user_id <> v_uid THEN
    RAISE EXCEPTION 'Only the invitee can accept this invitation' USING ERRCODE = '42501';
  END IF;
  IF v_inv.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is %', v_inv.status USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.community_group_bans b WHERE b.group_id = v_inv.group_id AND b.user_id = v_uid) THEN
    RAISE EXCEPTION 'This account is banned from the group' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (v_inv.group_id, v_uid, 'member') ON CONFLICT (group_id, user_id) DO NOTHING;
  UPDATE public.community_group_invitations SET status = 'accepted' WHERE id = v_inv.id;
  RETURN v_inv.group_id;
END;
$$;
REVOKE ALL ON FUNCTION public.accept_group_invitation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_group_invitation(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.accept_group_invitation(uuid) IS 'Accept a group invitation: invitee check, ban check, status flip and membership insert in one transaction (P2-16 migration 0054, INV-240).';

-- Self-check 0054-accept-invitation: anon cannot execute; no session is refused; a stranger is refused and the invitation stays pending with no membership; the invitee joins as a member and the invitation is accepted; a second
-- accept is refused; a banned invitee is refused and the invitation stays pending; an unknown id is not found; an invitee already in the group is not an error.
DO $$
DECLARE g uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); inv uuid := gen_random_uuid(); stranger uuid := gen_random_uuid(); bad uuid := gen_random_uuid(); there uuid := gen_random_uuid();
  i1 uuid; i2 uuid; i3 uuid; got uuid;
BEGIN
  IF has_function_privilege('anon', 'public.accept_group_invitation(uuid)', 'EXECUTE') THEN RAISE EXCEPTION '0054-accept-invitation: anon can execute it'; END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (adm, 'adm-0054@invalid.example'), (inv, 'inv-0054@invalid.example'), (stranger, 'str-0054@invalid.example'), (bad, 'bad-0054@invalid.example'), (there, 'there-0054@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (adm, 'adm-0054@invalid.example'), (inv, 'inv-0054@invalid.example'), (stranger, 'str-0054@invalid.example'), (bad, 'bad-0054@invalid.example'), (there, 'there-0054@invalid.example');
    INSERT INTO public.community_groups (id, name, slug, region, privacy, owner_user_id) VALUES (g, 'g', 'g-0054-' || g, 'GLOBAL', 'private', adm);
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g, adm, 'admin'), (g, there, 'member');
    INSERT INTO public.community_group_bans (group_id, user_id, banned_by) VALUES (g, bad, adm);
    INSERT INTO public.community_group_invitations (group_id, inviter_user_id, invitee_user_id) VALUES (g, adm, inv) RETURNING id INTO i1;
    INSERT INTO public.community_group_invitations (group_id, inviter_user_id, invitee_user_id) VALUES (g, adm, bad) RETURNING id INTO i2;
    INSERT INTO public.community_group_invitations (group_id, inviter_user_id, invitee_user_id) VALUES (g, adm, there) RETURNING id INTO i3;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN PERFORM public.accept_group_invitation(i1); RAISE EXCEPTION '0054-accept-invitation: accepted with no session';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', stranger::text, true);
    BEGIN PERFORM public.accept_group_invitation(i1); RAISE EXCEPTION '0054-accept-invitation: a stranger accepted';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    RESET ROLE;
    IF (SELECT status FROM public.community_group_invitations WHERE id = i1) <> 'pending' OR EXISTS (SELECT 1 FROM public.community_group_members WHERE group_id = g AND user_id = stranger) THEN
      RAISE EXCEPTION '0054-accept-invitation: a refused stranger still changed state';
    END IF;

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', inv::text, true);
    got := public.accept_group_invitation(i1);
    IF got <> g THEN RAISE EXCEPTION '0054-accept-invitation: returned %', got; END IF;
    BEGIN PERFORM public.accept_group_invitation(i1); RAISE EXCEPTION '0054-accept-invitation: accepted twice';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.accept_group_invitation(gen_random_uuid()); RAISE EXCEPTION '0054-accept-invitation: an unknown id was accepted';
    EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', bad::text, true);
    BEGIN PERFORM public.accept_group_invitation(i2); RAISE EXCEPTION '0054-accept-invitation: a banned user joined through an invitation';
    EXCEPTION WHEN SQLSTATE '42501' THEN IF SQLERRM <> 'This account is banned from the group' THEN RAISE EXCEPTION '0054-accept-invitation: the ban was refused for another reason: %', SQLERRM; END IF; END;
    PERFORM set_config('request.jwt.claim.sub', there::text, true);
    PERFORM public.accept_group_invitation(i3);
    RESET ROLE;
    IF (SELECT role FROM public.community_group_members WHERE group_id = g AND user_id = inv) <> 'member' OR (SELECT status FROM public.community_group_invitations WHERE id = i1) <> 'accepted' THEN
      RAISE EXCEPTION '0054-accept-invitation: the accept did not join as a member';
    END IF;
    IF (SELECT status FROM public.community_group_invitations WHERE id = i2) <> 'pending' OR EXISTS (SELECT 1 FROM public.community_group_members WHERE group_id = g AND user_id = bad) THEN
      RAISE EXCEPTION '0054-accept-invitation: a refused ban still changed state';
    END IF;
    IF (SELECT count(*) FROM public.community_group_members WHERE group_id = g AND user_id = there) <> 1 THEN RAISE EXCEPTION '0054-accept-invitation: an existing member got a second row'; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0054-accept-invitation OK';
END $$;

COMMIT;
