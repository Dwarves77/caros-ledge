-- Down for 0028_invitation_actions_by_id: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.accept_invitation_by_id(uuid);
DROP FUNCTION public.decline_invitation_by_id(uuid);
CREATE OR REPLACE FUNCTION public.accept_invitation(p_token text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_invitation public.org_invitations;
  v_caller_id  uuid;
  v_caller_email text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT lower(u.email) INTO v_caller_email
  FROM auth.users u WHERE u.id = v_caller_id;
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'Caller email not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_invitation
  FROM public.org_invitations
  WHERE token_hash = public.invitation_token_hash(p_token)
  FOR UPDATE;

  IF v_invitation IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is %', v_invitation.status USING ERRCODE = '22023';
  END IF;
  IF v_invitation.expires_at <= now() THEN
    UPDATE public.org_invitations SET status = 'expired' WHERE id = v_invitation.id;
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;
  IF v_invitation.invited_email <> v_caller_email THEN
    RAISE EXCEPTION 'Invitation is for a different email' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.org_member_bans b
    WHERE b.org_id = v_invitation.org_id
      AND b.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'This account is banned from the workspace' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.org_memberships (org_id, user_id, role)
  VALUES (v_invitation.org_id, v_caller_id, v_invitation.proposed_role)
  ON CONFLICT (org_id, user_id) DO UPDATE
    SET role = EXCLUDED.role
    WHERE (org_memberships.role = 'viewer' AND EXCLUDED.role IN ('member', 'admin'))
       OR (org_memberships.role = 'member' AND EXCLUDED.role = 'admin');

  UPDATE public.org_invitations
  SET status = 'accepted',
      accepted_at = now(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_invitation.id;

  RETURN v_invitation.org_id;
END;
$function$
;
REVOKE ALL ON FUNCTION public.accept_invitation(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.accept_invitation(text) TO "service_role";
CREATE OR REPLACE FUNCTION public.decline_invitation(p_token text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_invitation public.org_invitations;
  v_caller_id  uuid;
  v_caller_email text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT lower(u.email) INTO v_caller_email
  FROM auth.users u WHERE u.id = v_caller_id;

  SELECT * INTO v_invitation
  FROM public.org_invitations
  WHERE token_hash = public.invitation_token_hash(p_token)
  FOR UPDATE;

  IF v_invitation IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is %', v_invitation.status USING ERRCODE = '22023';
  END IF;
  IF v_invitation.invited_email <> COALESCE(v_caller_email, '') THEN
    RAISE EXCEPTION 'Invitation is for a different email' USING ERRCODE = '42501';
  END IF;

  UPDATE public.org_invitations
  SET status = 'declined',
      declined_at = now()
  WHERE id = v_invitation.id;
END;
$function$
;
REVOKE ALL ON FUNCTION public.decline_invitation(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decline_invitation(text) TO "authenticated";
GRANT EXECUTE ON FUNCTION public.decline_invitation(text) TO "service_role";
