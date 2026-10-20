-- Down for 0101: the consent table goes last, after the two functions that write it return to their old bodies; the eight new functions go; revoke_invitation and create_org_for_self return to their schema.sql bodies and accept_invitation_by_id to its 0028 body; the tag-delete policy returns to its baseline.
DROP FUNCTION public.set_member_role(uuid, uuid, text, text);
DROP FUNCTION public.remove_member(uuid, uuid, text);
DROP FUNCTION public.ban_member(uuid, uuid, text);
DROP FUNCTION public.rename_org(uuid, text, text, text);
DROP FUNCTION public.invite_member(uuid, text, text, text);
DROP FUNCTION public.org_roster(uuid, integer);
DROP FUNCTION public.set_priority_override(uuid, uuid, text, text);
DROP FUNCTION public.restore_team_item(uuid, uuid, text);
CREATE OR REPLACE FUNCTION public.revoke_invitation(p_invitation_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_invitation public.org_invitations;
  v_caller_id  uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_invitation
  FROM public.org_invitations
  WHERE id = p_invitation_id
  FOR UPDATE;

  IF v_invitation IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;

  -- Caller must be admin/owner of the org.
  IF NOT EXISTS (
    SELECT 1 FROM public.org_memberships m
    WHERE m.org_id = v_invitation.org_id
      AND m.user_id = v_caller_id
      AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Not an admin of org %', v_invitation.org_id USING ERRCODE = '42501';
  END IF;

  IF v_invitation.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is %', v_invitation.status USING ERRCODE = '22023';
  END IF;

  UPDATE public.org_invitations
  SET status = 'revoked',
      revoked_at = now(),
      revoked_by_user_id = v_caller_id
  WHERE id = v_invitation.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_org_for_self(p_org_name text, p_org_slug text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_caller_id uuid;
  v_org_id    uuid;
  v_slug      text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_org_name IS NULL OR length(trim(p_org_name)) = 0 THEN
    RAISE EXCEPTION 'Org name is required' USING ERRCODE = '22023';
  END IF;
  IF length(p_org_name) > 200 THEN
    RAISE EXCEPTION 'Org name too long' USING ERRCODE = '22023';
  END IF;

  -- Slug: caller-provided or derived from the name. Lowercase, hyphenated,
  -- with a short random suffix to avoid collisions.
  v_slug := COALESCE(
    nullif(trim(p_org_slug), ''),
    regexp_replace(lower(trim(p_org_name)), '[^a-z0-9]+', '-', 'g')
  );
  v_slug := substring(v_slug from 1 for 40);
  v_slug := trim(both '-' from v_slug);
  IF v_slug IS NULL OR v_slug = '' THEN
    v_slug := 'org';
  END IF;
  -- Append 6 hex chars for uniqueness.
  v_slug := v_slug || '-' || encode(gen_random_bytes(3), 'hex');

  -- Insert org. The org_write_service RLS policy restricts public INSERT
  -- to service_role; this DEFINER fn bypasses that.
  INSERT INTO public.organizations (name, slug, plan)
  VALUES (trim(p_org_name), v_slug, 'free')
  RETURNING id INTO v_org_id;

  -- Owner membership.
  INSERT INTO public.org_memberships (org_id, user_id, role)
  VALUES (v_org_id, v_caller_id, 'owner');

  -- Seed default workspace_settings. (sector_profile defaults to {} per
  -- the column default; the user runs onboarding to populate it.)
  INSERT INTO public.workspace_settings (org_id)
  VALUES (v_org_id);

  RETURN v_org_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_invitation_by_id(p_invitation_id uuid) RETURNS uuid
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

DROP POLICY workspace_tags_org_delete ON public.workspace_tags;
CREATE POLICY workspace_tags_org_delete ON public.workspace_tags FOR DELETE TO authenticated, service_role USING ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
DROP TABLE public.membership_consents;
