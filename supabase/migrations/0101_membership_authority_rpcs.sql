-- 0101 membership and workspace authority in one transaction each (R2e M1; register rows W:1-4, W:6, W:22, W:24, W:25, W:86; INV-R2e-1, INV-R2e-2).
--
-- A role change, a ban, a removal, a rename and an invitation were statements on the service client (around the SEC-3b guard, which exempts it), the ban was two statements, nothing recorded who did it, the roster read every
-- member's e-mail for any member, and a registered-e-mail oracle added a stranger's account to an organisation without its consent. Each act is now ONE SECURITY DEFINER function that takes the actor from auth.uid(), decides
-- through org_can (0100), applies the rules of the SEC-3b guard itself (the trigger still refuses a direct table write by a client role), and writes its admin_events row in the same transaction:
--   set_member_role(org, membership, role, reason)   remove_member(org, membership, reason)   ban_member(org, membership, reason)   rename_org(org, name, slug, reason)
--   invite_member(org, email, role, token)           revoke_invitation(invitation)             accept_invitation_by_id(invitation)  (the token entry point delegates, 0028)   create_org_for_self(name, slug)
--   org_roster(org, limit): the members of an organisation; the e-mail column is filled only for a caller who org_can read_roster_emails (an owner or admin of that organisation), and the name never falls back to an address.
--   set_priority_override(org, item, priority, reason) and restore_team_item(org, item, reason): a workspace-wide change of every member's urgency or visibility is an owner or admin act with a stated reason and an event.
-- Rules kept from the guard: only an owner grants or removes the owner role; nobody changes or removes themselves; the last owner is never demoted, removed or banned (22023, a 409 to the caller); a member is looked up INSIDE the
-- organisation named, so another organisation's membership id is not found (P0002). invite_member never looks at accounts: an e-mail with an account and one without answer identically (the oracle is gone), and a registered
-- invitee is added only by accept_invitation_by_id, which also refuses a second organisation (22023) and records the join. Tag delete (workspace_tags_org_delete) now needs the tag's creator or an owner or admin.
-- Not applied to production before the cutover window.
--
-- Reversal: restore accept_invitation_by_id, revoke_invitation and create_org_for_self from 0028 and schema.sql; restore policy workspace_tags_org_delete from schema.sql; DROP the nine new functions.

-- catalog: function, policy

BEGIN;

CREATE FUNCTION public.set_member_role(p_org_id uuid, p_membership_id uuid, p_role text, p_reason text DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE uid uuid := auth.uid(); m public.org_memberships; before_role text; others int;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to change a role' USING ERRCODE = '42501'; END IF;
  IF p_role IS NULL OR p_role NOT IN ('owner', 'admin', 'member', 'viewer') THEN RAISE EXCEPTION 'the role is owner, admin, member or viewer' USING ERRCODE = '22023'; END IF;
  IF NOT public.org_can(p_org_id, 'change_role') THEN RAISE EXCEPTION 'you cannot change roles in this organisation' USING ERRCODE = '42501'; END IF;
  SELECT * INTO m FROM public.org_memberships WHERE id = p_membership_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'membership not found in this organisation' USING ERRCODE = 'P0002'; END IF;
  IF m.user_id = uid THEN RAISE EXCEPTION 'nobody changes their own role' USING ERRCODE = '42501'; END IF;
  IF p_role = 'owner' AND m.role <> 'owner' AND NOT public.org_can(p_org_id, 'grant_owner') THEN RAISE EXCEPTION 'only an owner may grant the owner role' USING ERRCODE = '42501'; END IF;
  IF m.role = 'owner' AND p_role <> 'owner' AND NOT public.org_can(p_org_id, 'remove_owner') THEN RAISE EXCEPTION 'only an owner may change an owner''s role' USING ERRCODE = '42501'; END IF;
  before_role := m.role;
  IF before_role = p_role THEN RETURN jsonb_build_object('id', m.id, 'role', m.role); END IF;
  IF before_role = 'owner' THEN
    PERFORM 1 FROM public.org_memberships WHERE org_id = p_org_id AND role = 'owner' ORDER BY id FOR UPDATE;
    SELECT count(*) INTO others FROM public.org_memberships WHERE org_id = p_org_id AND role = 'owner' AND id <> m.id;
    IF others = 0 THEN RAISE EXCEPTION 'Cannot demote the only owner. Promote another member to owner first.' USING ERRCODE = '22023'; END IF;
  END IF;
  UPDATE public.org_memberships SET role = p_role WHERE id = m.id RETURNING * INTO m;
  PERFORM public.record_admin_event(p_org_id, 'member_role_changed', 'membership', m.id::text, p_reason, jsonb_build_object('from', before_role, 'to', p_role));
  RETURN jsonb_build_object('id', m.id, 'role', m.role);
END;
$$;

CREATE FUNCTION public.remove_member(p_org_id uuid, p_membership_id uuid, p_reason text DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE uid uuid := auth.uid(); m public.org_memberships; others int;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to remove a member' USING ERRCODE = '42501'; END IF;
  IF NOT public.org_can(p_org_id, 'remove_member') THEN RAISE EXCEPTION 'you cannot remove members from this organisation' USING ERRCODE = '42501'; END IF;
  SELECT * INTO m FROM public.org_memberships WHERE id = p_membership_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'membership not found in this organisation' USING ERRCODE = 'P0002'; END IF;
  IF m.user_id = uid THEN RAISE EXCEPTION 'you cannot remove yourself' USING ERRCODE = '42501'; END IF;
  IF m.role = 'owner' THEN
    IF NOT public.org_can(p_org_id, 'remove_owner') THEN RAISE EXCEPTION 'only an owner may remove an owner' USING ERRCODE = '42501'; END IF;
    PERFORM 1 FROM public.org_memberships WHERE org_id = p_org_id AND role = 'owner' ORDER BY id FOR UPDATE;
    SELECT count(*) INTO others FROM public.org_memberships WHERE org_id = p_org_id AND role = 'owner' AND id <> m.id;
    IF others = 0 THEN RAISE EXCEPTION 'Cannot remove the only owner. Promote another member to owner first.' USING ERRCODE = '22023'; END IF;
  END IF;
  DELETE FROM public.org_memberships WHERE id = m.id;
  PERFORM public.record_admin_event(p_org_id, 'member_removed', 'membership', m.id::text, p_reason, jsonb_build_object('role', m.role));
  RETURN jsonb_build_object('id', m.id);
END;
$$;

CREATE FUNCTION public.ban_member(p_org_id uuid, p_membership_id uuid, p_reason text DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE uid uuid := auth.uid(); m public.org_memberships; others int;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to ban a member' USING ERRCODE = '42501'; END IF;
  IF NOT public.org_can(p_org_id, 'ban_member') THEN RAISE EXCEPTION 'you cannot ban members of this organisation' USING ERRCODE = '42501'; END IF;
  SELECT * INTO m FROM public.org_memberships WHERE id = p_membership_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'membership not found in this organisation' USING ERRCODE = 'P0002'; END IF;
  IF m.user_id = uid THEN RAISE EXCEPTION 'you cannot ban yourself' USING ERRCODE = '42501'; END IF;
  IF m.role = 'owner' THEN
    IF NOT public.org_can(p_org_id, 'remove_owner') THEN RAISE EXCEPTION 'only an owner may ban an owner' USING ERRCODE = '42501'; END IF;
    PERFORM 1 FROM public.org_memberships WHERE org_id = p_org_id AND role = 'owner' ORDER BY id FOR UPDATE;
    SELECT count(*) INTO others FROM public.org_memberships WHERE org_id = p_org_id AND role = 'owner' AND id <> m.id;
    IF others = 0 THEN RAISE EXCEPTION 'Cannot ban the only owner. Promote another member to owner first.' USING ERRCODE = '22023'; END IF;
  END IF;
  INSERT INTO public.org_member_bans (org_id, user_id, banned_by, reason) VALUES (p_org_id, m.user_id, uid, nullif(btrim(coalesce(p_reason, '')), ''))
    ON CONFLICT (org_id, user_id) DO UPDATE SET banned_by = EXCLUDED.banned_by, reason = EXCLUDED.reason, banned_at = now();
  DELETE FROM public.org_memberships WHERE id = m.id;
  PERFORM public.record_admin_event(p_org_id, 'member_banned', 'membership', m.id::text, p_reason, jsonb_build_object('role', m.role));
  RETURN jsonb_build_object('id', m.id);
END;
$$;

CREATE FUNCTION public.rename_org(p_org_id uuid, p_name text, p_slug text, p_reason text DEFAULT NULL) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE uid uuid := auth.uid(); o public.organizations; old_name text; old_slug text; v_name text := nullif(btrim(coalesce(p_name, '')), ''); v_slug text := nullif(lower(btrim(coalesce(p_slug, ''))), '');
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to rename an organisation' USING ERRCODE = '42501'; END IF;
  IF v_name IS NULL AND v_slug IS NULL THEN RAISE EXCEPTION 'provide a name or a slug' USING ERRCODE = '22023'; END IF;
  IF v_name IS NOT NULL AND length(v_name) > 200 THEN RAISE EXCEPTION 'the name is at most 200 characters' USING ERRCODE = '22023'; END IF;
  IF v_slug IS NOT NULL AND (length(v_slug) NOT BETWEEN 2 AND 60 OR v_slug !~ '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$') THEN RAISE EXCEPTION 'the slug is 2 to 60 lowercase letters, digits or hyphens, not starting or ending with a hyphen' USING ERRCODE = '22023'; END IF;
  SELECT * INTO o FROM public.organizations WHERE id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organisation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.org_can(p_org_id, 'rename_org') THEN RAISE EXCEPTION 'only an owner may rename the organisation' USING ERRCODE = '42501'; END IF;
  old_name := o.name; old_slug := o.slug;
  UPDATE public.organizations SET name = coalesce(v_name, name), slug = coalesce(v_slug, slug), updated_at = now() WHERE id = p_org_id RETURNING * INTO o;
  PERFORM public.record_admin_event(p_org_id, 'org_renamed', 'organization', p_org_id::text, p_reason, jsonb_build_object('name_from', old_name, 'name_to', o.name, 'slug_from', old_slug, 'slug_to', o.slug));
  RETURN jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'plan', o.plan, 'created_at', o.created_at, 'updated_at', o.updated_at);
END;
$$;

CREATE FUNCTION public.invite_member(p_org_id uuid, p_email text, p_role text, p_token text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE uid uuid := auth.uid(); v_email text := lower(btrim(coalesce(p_email, ''))); i public.org_invitations;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to invite a member' USING ERRCODE = '42501'; END IF;
  IF NOT public.org_can(p_org_id, 'invite_member') THEN RAISE EXCEPTION 'only org admins can invite members' USING ERRCODE = '42501'; END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin', 'member', 'viewer') THEN RAISE EXCEPTION 'an invitation proposes admin, member or viewer' USING ERRCODE = '22023'; END IF;
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' OR length(v_email) > 254 THEN RAISE EXCEPTION 'enter a valid e-mail address' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input) VALUES (p_org_id, v_email, uid, p_role, p_token) RETURNING * INTO i;
  PERFORM public.record_admin_event(p_org_id, 'member_invited', 'invitation', i.id::text, NULL, jsonb_build_object('role', p_role));
  RETURN jsonb_build_object('id', i.id, 'token_last4', i.token_last4, 'invited_email', i.invited_email, 'proposed_role', i.proposed_role, 'expires_at', i.expires_at, 'status', i.status, 'created_at', i.created_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.revoke_invitation(p_invitation_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
  AS $$
DECLARE v_invitation public.org_invitations; v_caller_id uuid := auth.uid();
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_invitation FROM public.org_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF v_invitation IS NULL THEN RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002'; END IF;
  IF NOT public.org_can(v_invitation.org_id, 'revoke_invitation') THEN RAISE EXCEPTION 'Not an admin of this organisation' USING ERRCODE = '42501'; END IF;
  IF v_invitation.status <> 'pending' THEN RAISE EXCEPTION 'Invitation is %', v_invitation.status USING ERRCODE = '22023'; END IF;
  UPDATE public.org_invitations SET status = 'revoked', revoked_at = now(), revoked_by_user_id = v_caller_id WHERE id = v_invitation.id;
  PERFORM public.record_admin_event(v_invitation.org_id, 'invitation_revoked', 'invitation', v_invitation.id::text, NULL, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_invitation_by_id(p_invitation_id uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
  AS $$
DECLARE v_invitation public.org_invitations; v_caller_id uuid := auth.uid(); v_caller_email text; v_membership uuid;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT lower(u.email) INTO v_caller_email FROM auth.users u WHERE u.id = v_caller_id;
  IF v_caller_email IS NULL THEN RAISE EXCEPTION 'Caller email not found' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_invitation FROM public.org_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF v_invitation IS NULL THEN RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002'; END IF;
  IF v_invitation.invited_email <> v_caller_email THEN RAISE EXCEPTION 'Invitation is for a different email' USING ERRCODE = '42501'; END IF;
  IF v_invitation.status <> 'pending' THEN RAISE EXCEPTION 'Invitation is %', v_invitation.status USING ERRCODE = '22023'; END IF;
  IF v_invitation.expires_at <= now() THEN
    UPDATE public.org_invitations SET status = 'expired' WHERE id = v_invitation.id;
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.org_member_bans b WHERE b.org_id = v_invitation.org_id AND b.user_id = v_caller_id) THEN RAISE EXCEPTION 'This account is banned from the workspace' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.org_memberships m WHERE m.user_id = v_caller_id AND m.org_id <> v_invitation.org_id) THEN
    RAISE EXCEPTION 'You already belong to a workspace. Leave it before accepting an invitation to another.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (v_invitation.org_id, v_caller_id, v_invitation.proposed_role)
  ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role
    WHERE (org_memberships.role = 'viewer' AND EXCLUDED.role IN ('member', 'admin')) OR (org_memberships.role = 'member' AND EXCLUDED.role = 'admin')
  RETURNING id INTO v_membership;
  UPDATE public.org_invitations SET status = 'accepted', accepted_at = now(), accepted_by_user_id = v_caller_id WHERE id = v_invitation.id;
  PERFORM public.record_admin_event(v_invitation.org_id, 'invitation_accepted', 'invitation', v_invitation.id::text, NULL, jsonb_build_object('role', v_invitation.proposed_role, 'membership_written', v_membership IS NOT NULL));
  RETURN v_invitation.org_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_org_for_self(p_org_name text, p_org_slug text DEFAULT NULL::text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions', 'pg_temp'
  AS $$
DECLARE v_caller_id uuid := auth.uid(); v_org_id uuid; v_slug text;
BEGIN
  IF v_caller_id IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_org_name IS NULL OR length(trim(p_org_name)) = 0 THEN RAISE EXCEPTION 'Org name is required' USING ERRCODE = '22023'; END IF;
  IF length(p_org_name) > 200 THEN RAISE EXCEPTION 'Org name too long' USING ERRCODE = '22023'; END IF;
  v_slug := COALESCE(nullif(trim(p_org_slug), ''), regexp_replace(lower(trim(p_org_name)), '[^a-z0-9]+', '-', 'g'));
  v_slug := trim(both '-' from substring(v_slug from 1 for 40));
  IF v_slug IS NULL OR v_slug = '' THEN v_slug := 'org'; END IF;
  v_slug := v_slug || '-' || encode(gen_random_bytes(3), 'hex');
  INSERT INTO public.organizations (name, slug, plan) VALUES (trim(p_org_name), v_slug, 'free') RETURNING id INTO v_org_id;
  INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (v_org_id, v_caller_id, 'owner');
  INSERT INTO public.workspace_settings (org_id) VALUES (v_org_id);
  PERFORM public.record_admin_event(v_org_id, 'org_created', 'organization', v_org_id::text, NULL, '{}'::jsonb);
  RETURN v_org_id;
END;
$$;

CREATE FUNCTION public.org_roster(p_org_id uuid, p_limit integer DEFAULT 200) RETURNS TABLE(id uuid, user_id uuid, role text, joined_at timestamptz, display_name text, avatar_url text, email text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE show_email boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.org_can(p_org_id, 'read_roster') THEN RAISE EXCEPTION 'you are not a member of this organisation' USING ERRCODE = '42501'; END IF;
  show_email := public.org_can(p_org_id, 'read_roster_emails');
  RETURN QUERY
    SELECT m.id, m.user_id, m.role, m.created_at, nullif(btrim(coalesce(nullif(btrim(p.full_name), ''), p.display_name)), '')::text, p.avatar_url::text, (CASE WHEN show_email THEN p.email END)::text
      FROM public.org_memberships m LEFT JOIN public.profiles p ON p.id = m.user_id
     WHERE m.org_id = p_org_id
     ORDER BY m.created_at, m.id
     LIMIT greatest(1, least(coalesce(p_limit, 200), 500)) + 1;
END;
$$;

CREATE FUNCTION public.set_priority_override(p_org_id uuid, p_item_id uuid, p_priority text, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE uid uuid := auth.uid(); o public.workspace_item_overrides; before_priority text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to set a priority' USING ERRCODE = '42501'; END IF;
  IF NOT public.org_can(p_org_id, 'set_priority_override') THEN RAISE EXCEPTION 'a workspace-wide priority needs the admin or owner role' USING ERRCODE = '42501'; END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN RAISE EXCEPTION 'a reason is required to change the priority for the workspace' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM public.intelligence_items i WHERE i.id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such item' USING ERRCODE = 'P0002'; END IF;
  SELECT priority_override INTO before_priority FROM public.workspace_item_overrides WHERE org_id = p_org_id AND item_id = p_item_id;
  INSERT INTO public.workspace_item_overrides (org_id, item_id, priority_override, updated_at) VALUES (p_org_id, p_item_id, p_priority, now())
    ON CONFLICT (org_id, item_id) DO UPDATE SET priority_override = EXCLUDED.priority_override, updated_at = EXCLUDED.updated_at
    RETURNING * INTO o;
  PERFORM public.record_admin_event(p_org_id, 'priority_override_set', 'workspace_item', p_item_id::text, p_reason, jsonb_build_object('from', before_priority, 'to', p_priority));
  RETURN to_jsonb(o);
END;
$$;

CREATE FUNCTION public.restore_team_item(p_org_id uuid, p_item_id uuid, p_reason text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE uid uuid := auth.uid(); o public.workspace_item_overrides;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to restore an item' USING ERRCODE = '42501'; END IF;
  IF NOT public.org_can(p_org_id, 'restore_team_item') THEN RAISE EXCEPTION 'restoring a workspace archive needs the admin or owner role' USING ERRCODE = '42501'; END IF;
  IF btrim(coalesce(p_reason, '')) = '' THEN RAISE EXCEPTION 'a reason is required to restore an item for the workspace' USING ERRCODE = '22023'; END IF;
  UPDATE public.workspace_item_overrides SET is_archived = false, archived_at = NULL, archived_by = NULL, archive_reason = NULL, archive_note = NULL, updated_at = now()
   WHERE org_id = p_org_id AND item_id = p_item_id AND is_archived RETURNING * INTO o;
  IF NOT FOUND THEN RAISE EXCEPTION 'that item is not archived for the workspace' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.record_admin_event(p_org_id, 'team_item_restored', 'workspace_item', p_item_id::text, p_reason, '{}'::jsonb);
  RETURN to_jsonb(o);
END;
$$;

DROP POLICY workspace_tags_org_delete ON public.workspace_tags;
CREATE POLICY workspace_tags_org_delete ON public.workspace_tags FOR DELETE TO authenticated, service_role
  USING ((public.user_can_write_in_org(org_id) AND (created_by = (SELECT auth.uid()) OR public.org_can(org_id, 'delete_any_tag'))) OR ((SELECT auth.role()) = 'service_role'::text));

REVOKE ALL ON FUNCTION public.set_member_role(uuid, uuid, text, text), public.remove_member(uuid, uuid, text), public.ban_member(uuid, uuid, text), public.rename_org(uuid, text, text, text),
  public.invite_member(uuid, text, text, text), public.org_roster(uuid, integer), public.set_priority_override(uuid, uuid, text, text), public.restore_team_item(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_member_role(uuid, uuid, text, text), public.remove_member(uuid, uuid, text), public.ban_member(uuid, uuid, text), public.rename_org(uuid, text, text, text),
  public.invite_member(uuid, text, text, text), public.org_roster(uuid, integer), public.set_priority_override(uuid, uuid, text, text), public.restore_team_item(uuid, uuid, text) TO authenticated;
COMMENT ON FUNCTION public.set_member_role(uuid, uuid, text, text) IS 'R2e migration 0101. Change a member''s role: org_can change_role, the guard rules of SEC-3b, the last owner kept, one admin_events row in the same transaction.';
COMMENT ON FUNCTION public.remove_member(uuid, uuid, text) IS 'R2e migration 0101. Remove a member: org_can remove_member, nobody removes themselves, the last owner kept, one admin_events row.';
COMMENT ON FUNCTION public.ban_member(uuid, uuid, text) IS 'R2e migration 0101. Ban a member from the organisation: the ban row and the membership delete in one transaction with one admin_events row.';
COMMENT ON FUNCTION public.rename_org(uuid, text, text, text) IS 'R2e migration 0101. Rename or re-slug an organisation: org_can rename_org, one admin_events row carrying both names.';
COMMENT ON FUNCTION public.invite_member(uuid, text, text, text) IS 'R2e migration 0101. Issue an invitation as an owner or admin. It never reads accounts: an e-mail with an account and one without answer identically.';
COMMENT ON FUNCTION public.org_roster(uuid, integer) IS 'R2e migration 0101. The members of an organisation for a member; the e-mail column only for an owner or admin of that organisation; the name never falls back to an address.';
COMMENT ON FUNCTION public.set_priority_override(uuid, uuid, text, text) IS 'R2e migration 0101. A workspace-wide priority: owner or admin, a reason, one admin_events row.';
COMMENT ON FUNCTION public.restore_team_item(uuid, uuid, text) IS 'R2e migration 0101. Restore a workspace archive: owner or admin, a reason, one admin_events row.';

-- Self-check 0101-membership-rpcs, in a fixture that rolls back. REFUSED with nothing written and no event: a viewer, a member and a stranger on every act; a change of one''s own role; an admin granting or demoting an owner; a membership of
-- another organisation; the last owner demoted, removed or banned. ALLOWED, each with exactly one event carrying the actor and the reason: role change, removal, ban (membership gone, ban recorded, a re-accept refused), rename (a taken slug is a
-- 23505 and writes nothing), invitation, acceptance (one membership; a second organisation refused), the platform admin's rename. THE ATTACK (INV-R2e-2): a CHECK planted on admin_events that refuses one action makes that act fail
-- and leave no change behind, for each of the nine acts. INV-R2e-1: invite_member answers identically for an e-mail with an account and one without. The roster gives the e-mail to an owner and an admin and to nobody else.
DO $$
DECLARE
  org uuid := gen_random_uuid(); orgb uuid := gen_random_uuid(); uo uuid := gen_random_uuid(); uo2 uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); um uuid := gen_random_uuid(); um2 uuid := gen_random_uuid(); uv uuid := gen_random_uuid();
  ub uuid := gen_random_uuid(); up uuid := gen_random_uuid(); ux uuid := gen_random_uuid();
  mo uuid; mo2 uuid; ma uuid; mm uuid; mm2 uuid; mv uuid; mb uuid; res jsonb; res2 jsonb; n int; inv uuid; inv2 uuid; tok text := repeat('a', 64); tok2 text := repeat('b', 64); tok3 text := repeat('c', 64); tg uuid; tg2 uuid; it uuid;
  ev_before int;
BEGIN
  IF has_function_privilege('anon', 'public.set_member_role(uuid, uuid, text, text)', 'EXECUTE') OR has_function_privilege('anon', 'public.invite_member(uuid, text, text, text)', 'EXECUTE') OR has_function_privilege('anon', 'public.org_roster(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION '0101-membership-rpcs: anon can execute a function it must not';
  END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (uo, 'o-0101@invalid.example'), (uo2, 'o2-0101@invalid.example'), (ua, 'a-0101@invalid.example'), (um, 'm-0101@invalid.example'), (um2, 'm2-0101@invalid.example'), (uv, 'v-0101@invalid.example'), (ub, 'b-0101@invalid.example'),
      (up, 'p-0101@invalid.example'), (ux, 'x-0101@invalid.example');
    INSERT INTO public.profiles (id, email, full_name) VALUES (uo, 'o-0101@invalid.example', 'Olive Owner'), (uo2, 'o2-0101@invalid.example', 'Otto Owner'), (ua, 'a-0101@invalid.example', 'Ada Admin'), (um, 'm-0101@invalid.example', 'Mia Member'),
      (um2, 'm2-0101@invalid.example', NULL), (uv, 'v-0101@invalid.example', 'Vic Viewer'), (ub, 'b-0101@invalid.example', 'Bo Other'), (up, 'p-0101@invalid.example', 'Pat Platform'), (ux, 'x-0101@invalid.example', 'Xi Joiner');
    UPDATE public.profiles SET is_platform_admin = true WHERE id = up;
    INSERT INTO public.organizations (id, name, slug) VALUES (org, 'selfcheck-0101', 'selfcheck-0101-' || org), (orgb, 'selfcheck-0101-b', 'selfcheck-0101-b-' || orgb);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, uo, 'owner'), (org, ua, 'admin'), (org, um, 'member'), (org, um2, 'member'), (org, uv, 'viewer'), (orgb, ub, 'owner');
    SELECT id INTO mo FROM public.org_memberships WHERE org_id = org AND user_id = uo;
    SELECT id INTO ma FROM public.org_memberships WHERE org_id = org AND user_id = ua;
    SELECT id INTO mm FROM public.org_memberships WHERE org_id = org AND user_id = um;
    SELECT id INTO mm2 FROM public.org_memberships WHERE org_id = org AND user_id = um2;
    SELECT id INTO mv FROM public.org_memberships WHERE org_id = org AND user_id = uv;
    SELECT id INTO mb FROM public.org_memberships WHERE org_id = orgb AND user_id = ub;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0101 one', 1, 'verified', false) RETURNING id INTO it;

    SET LOCAL ROLE authenticated;
    -- REFUSED: no session, viewer, member, stranger; nothing written, no event.
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN PERFORM public.set_member_role(org, mm, 'admin', NULL); RAISE EXCEPTION '0101-membership-rpcs: a role changed with no session'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', uv::text, true);
    BEGIN PERFORM public.set_member_role(org, mm, 'admin', NULL); RAISE EXCEPTION '0101-membership-rpcs: a viewer changed a role'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.invite_member(org, 'z@invalid.example', 'member', tok); RAISE EXCEPTION '0101-membership-rpcs: a viewer invited'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.rename_org(org, 'x', NULL, NULL); RAISE EXCEPTION '0101-membership-rpcs: a viewer renamed'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    BEGIN PERFORM public.remove_member(org, mm2, NULL); RAISE EXCEPTION '0101-membership-rpcs: a member removed a member'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.ban_member(org, mm2, 'x'); RAISE EXCEPTION '0101-membership-rpcs: a member banned a member'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.set_priority_override(org, it, 'HIGH', 'why'); RAISE EXCEPTION '0101-membership-rpcs: a member set a workspace priority'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', ub::text, true);
    BEGIN PERFORM public.set_member_role(org, mm, 'admin', NULL); RAISE EXCEPTION '0101-membership-rpcs: a stranger changed a role'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.org_roster(org, 10); RAISE EXCEPTION '0101-membership-rpcs: a stranger read the roster'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.set_member_role(org, mb, 'viewer', NULL); RAISE EXCEPTION '0101-membership-rpcs: a stranger reached a membership'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    -- the owner of another organisation names this organisation''s membership under THEIR organisation: not found
    BEGIN PERFORM public.set_member_role(orgb, mm, 'viewer', NULL); RAISE EXCEPTION '0101-membership-rpcs: a foreign membership was reachable under the caller''s own organisation'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
    -- the admin: own role, owner grant, owner demotion
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    BEGIN PERFORM public.set_member_role(org, ma, 'owner', NULL); RAISE EXCEPTION '0101-membership-rpcs: an admin changed their own role'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.set_member_role(org, mm, 'owner', NULL); RAISE EXCEPTION '0101-membership-rpcs: an admin granted the owner role'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.set_member_role(org, mo, 'member', NULL); RAISE EXCEPTION '0101-membership-rpcs: an admin demoted the owner'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.remove_member(org, mo, NULL); RAISE EXCEPTION '0101-membership-rpcs: an admin removed the owner'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.ban_member(org, mo, NULL); RAISE EXCEPTION '0101-membership-rpcs: an admin banned the owner'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.rename_org(org, 'x', NULL, NULL); RAISE EXCEPTION '0101-membership-rpcs: an admin renamed the organisation'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.remove_member(org, ma, NULL); RAISE EXCEPTION '0101-membership-rpcs: an admin removed themselves'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    -- the last owner
    PERFORM set_config('request.jwt.claim.sub', up::text, true);
    BEGIN PERFORM public.set_member_role(org, mo, 'member', NULL); RAISE EXCEPTION '0101-membership-rpcs: the last owner was demoted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.remove_member(org, mo, NULL); RAISE EXCEPTION '0101-membership-rpcs: the last owner was removed'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.ban_member(org, mo, NULL); RAISE EXCEPTION '0101-membership-rpcs: the last owner was banned'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    RESET ROLE;
    IF (SELECT role FROM public.org_memberships WHERE id = mo) <> 'owner' OR (SELECT role FROM public.org_memberships WHERE id = mm) <> 'member' OR (SELECT count(*) FROM public.org_memberships WHERE org_id = org) <> 5
       OR EXISTS (SELECT 1 FROM public.admin_events WHERE org_id IN (org, orgb)) OR EXISTS (SELECT 1 FROM public.org_member_bans WHERE org_id = org) OR (SELECT name FROM public.organizations WHERE id = org) <> 'selfcheck-0101' THEN
      RAISE EXCEPTION '0101-membership-rpcs: a refused call changed state or wrote an event';
    END IF;

    -- ALLOWED: the admin changes a member, the roster shows e-mail to owner and admin only.
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    res := public.set_member_role(org, mm, 'viewer', 'read only for the audit');
    IF res ->> 'role' <> 'viewer' THEN RAISE EXCEPTION '0101-membership-rpcs: the role did not change: %', res; END IF;
    RESET ROLE;
    SELECT count(*) INTO n FROM public.admin_events WHERE org_id = org AND action = 'member_role_changed' AND actor_id = ua AND reason = 'read only for the audit' AND target_id = mm::text AND detail ->> 'from' = 'member' AND detail ->> 'to' = 'viewer';
    IF n <> 1 THEN RAISE EXCEPTION '0101-membership-rpcs: the role change wrote % matching events, expected 1', n; END IF;
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO n FROM public.org_roster(org, 50) r WHERE r.email IS NOT NULL;
    IF n <> 5 THEN RAISE EXCEPTION '0101-membership-rpcs: the admin''s roster has % e-mails, expected 5', n; END IF;
    PERFORM set_config('request.jwt.claim.sub', uv::text, true);
    SELECT count(*) INTO n FROM public.org_roster(org, 50) r WHERE r.email IS NOT NULL;
    IF n <> 0 THEN RAISE EXCEPTION '0101-membership-rpcs: a viewer''s roster carries % e-mails', n; END IF;
    SELECT count(*) INTO n FROM public.org_roster(org, 50) r;
    IF n <> 5 THEN RAISE EXCEPTION '0101-membership-rpcs: the roster has % rows, expected 5', n; END IF;
    IF (SELECT r.display_name FROM public.org_roster(org, 50) r WHERE r.user_id = um2) IS NOT NULL THEN RAISE EXCEPTION '0101-membership-rpcs: a member with no name was shown under an address'; END IF;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    SELECT count(*) INTO n FROM public.org_roster(org, 2) r;
    IF n <> 3 THEN RAISE EXCEPTION '0101-membership-rpcs: a limit of 2 returned % rows, expected 3 (one past the bound)', n; END IF;

    -- owner: promotes the admin to owner (now two owners), then the first owner can be demoted by the second; a platform admin renames; a taken slug writes nothing
    PERFORM set_config('request.jwt.claim.sub', uo::text, true);
    PERFORM public.set_member_role(org, ma, 'owner', NULL);
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    PERFORM public.set_member_role(org, mo, 'admin', 'handover');
    PERFORM public.set_member_role(org, mo, 'owner', NULL);
    PERFORM set_config('request.jwt.claim.sub', uo::text, true);
    res := public.rename_org(org, 'Selfcheck Renamed', 'selfcheck-0101-renamed', 'rebrand');
    IF res ->> 'name' <> 'Selfcheck Renamed' OR res ->> 'slug' <> 'selfcheck-0101-renamed' THEN RAISE EXCEPTION '0101-membership-rpcs: rename answered %', res; END IF;
    BEGIN PERFORM public.rename_org(org, NULL, 'selfcheck-0101-b-' || orgb, NULL); RAISE EXCEPTION '0101-membership-rpcs: a taken slug was accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
    BEGIN PERFORM public.rename_org(org, NULL, 'Bad Slug!', NULL); RAISE EXCEPTION '0101-membership-rpcs: a malformed slug was accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', up::text, true);
    PERFORM public.rename_org(org, 'Platform Renamed', NULL, 'support request');
    RESET ROLE;
    IF (SELECT slug FROM public.organizations WHERE id = org) <> 'selfcheck-0101-renamed' OR (SELECT count(*) FROM public.admin_events WHERE org_id = org AND action = 'org_renamed') <> 2 THEN RAISE EXCEPTION '0101-membership-rpcs: rename state or events are wrong'; END IF;

    -- invitation: INV-R2e-1, an e-mail with an account and one without answer identically; a duplicate pending is a 23505; an owner role cannot be proposed; acceptance writes one membership and one event
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    res := public.invite_member(org, 'X-0101@invalid.example', 'member', tok);
    res2 := public.invite_member(org, 'nobody-0101@invalid.example', 'member', tok2);
    IF (res - 'id' - 'token_last4' - 'invited_email' - 'created_at' - 'expires_at') IS DISTINCT FROM (res2 - 'id' - 'token_last4' - 'invited_email' - 'created_at' - 'expires_at') OR (SELECT count(*) FROM jsonb_object_keys(res)) <> (SELECT count(*) FROM jsonb_object_keys(res2)) THEN
      RAISE EXCEPTION '0101-membership-rpcs: the invitation answers differ between an account and no account';
    END IF;
    inv := (res ->> 'id')::uuid; inv2 := (res2 ->> 'id')::uuid;
    BEGIN PERFORM public.invite_member(org, 'x-0101@invalid.example', 'member', tok3); RAISE EXCEPTION '0101-membership-rpcs: a duplicate pending invitation was accepted'; EXCEPTION WHEN unique_violation THEN NULL; END;
    BEGIN PERFORM public.invite_member(org, 'y-0101@invalid.example', 'owner', tok3); RAISE EXCEPTION '0101-membership-rpcs: an owner invitation was accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN PERFORM public.invite_member(org, 'not-an-address', 'member', tok3); RAISE EXCEPTION '0101-membership-rpcs: a malformed address was accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.org_memberships WHERE org_id = org AND user_id = ux) THEN RAISE EXCEPTION '0101-membership-rpcs: an invitation joined the account without consent'; END IF;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ub::text, true);
    BEGIN PERFORM public.accept_invitation_by_id(inv); RAISE EXCEPTION '0101-membership-rpcs: someone else accepted the invitation'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', ux::text, true);
    IF public.accept_invitation_by_id(inv) <> org THEN RAISE EXCEPTION '0101-membership-rpcs: accept returned the wrong organisation'; END IF;
    RESET ROLE;
    IF (SELECT count(*) FROM public.org_memberships WHERE user_id = ux) <> 1 OR (SELECT count(*) FROM public.admin_events WHERE action = 'invitation_accepted' AND actor_id = ux AND target_id = inv::text) <> 1 THEN
      RAISE EXCEPTION '0101-membership-rpcs: acceptance did not write exactly one membership and one event';
    END IF;
    -- a second organisation is refused for an account that already belongs to one
    INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input) VALUES (orgb, 'x-0101@invalid.example', ub, 'member', repeat('d', 64)) RETURNING id INTO inv;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ux::text, true);
    BEGIN PERFORM public.accept_invitation_by_id(inv); RAISE EXCEPTION '0101-membership-rpcs: a second organisation was accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    -- revoke records an event; a member cannot revoke
    BEGIN PERFORM public.revoke_invitation(inv2); RAISE EXCEPTION '0101-membership-rpcs: a member revoked an invitation'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    PERFORM public.revoke_invitation(inv2);
    RESET ROLE;
    IF (SELECT count(*) FROM public.admin_events WHERE action = 'invitation_revoked' AND target_id = inv2::text) <> 1 THEN RAISE EXCEPTION '0101-membership-rpcs: the revoke wrote no event'; END IF;

    -- removal and ban: the ban row, the membership gone, one event each; the banned account cannot accept an invitation back
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    PERFORM public.remove_member(org, mv, 'left the company');
    PERFORM public.ban_member(org, mm2, 'abuse');
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.org_memberships WHERE id IN (mv, mm2)) OR NOT EXISTS (SELECT 1 FROM public.org_member_bans WHERE org_id = org AND user_id = um2 AND banned_by = ua AND reason = 'abuse')
       OR (SELECT count(*) FROM public.admin_events WHERE org_id = org AND action IN ('member_removed', 'member_banned') AND actor_id = ua) <> 2 THEN
      RAISE EXCEPTION '0101-membership-rpcs: removal or ban state or events are wrong';
    END IF;
    INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input) VALUES (org, 'm2-0101@invalid.example', ua, 'member', repeat('e', 64)) RETURNING id INTO inv;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', um2::text, true);
    BEGIN PERFORM public.accept_invitation_by_id(inv); RAISE EXCEPTION '0101-membership-rpcs: a banned account accepted'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    RESET ROLE;

    -- workspace priority and restore: owner or admin with a reason, one event each; a member refused above
    INSERT INTO public.workspace_item_overrides (org_id, item_id, is_archived, archive_reason, archived_at, archived_by) VALUES (org, it, true, 'old', now(), uo);
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    BEGIN PERFORM public.set_priority_override(org, it, 'HIGH', '  '); RAISE EXCEPTION '0101-membership-rpcs: a priority without a reason was accepted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    PERFORM public.set_priority_override(org, it, 'HIGH', 'regulator deadline moved');
    PERFORM public.restore_team_item(org, it, 'archived by mistake');
    BEGIN PERFORM public.restore_team_item(org, it, 'again'); RAISE EXCEPTION '0101-membership-rpcs: an item that is not archived was restored'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
    RESET ROLE;
    IF (SELECT priority_override FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it) <> 'HIGH' OR (SELECT is_archived FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it)
       OR (SELECT count(*) FROM public.admin_events WHERE org_id = org AND action IN ('priority_override_set', 'team_item_restored')) <> 2 THEN RAISE EXCEPTION '0101-membership-rpcs: priority or restore state or events are wrong'; END IF;

    -- tag delete: a member deletes their own tag, not another member''s; an admin deletes any
    INSERT INTO public.workspace_tags (org_id, name, created_by) VALUES (org, 'selfcheck-tag-a', ua) RETURNING id INTO tg;
    INSERT INTO public.workspace_tags (org_id, name, created_by) VALUES (org, 'selfcheck-tag-x', ux) RETURNING id INTO tg2;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ux::text, true);
    DELETE FROM public.workspace_tags WHERE id = tg;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION '0101-membership-rpcs: a member deleted another member''s tag'; END IF;
    DELETE FROM public.workspace_tags WHERE id = tg2;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION '0101-membership-rpcs: a member could not delete their own tag'; END IF;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    DELETE FROM public.workspace_tags WHERE id = tg;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION '0101-membership-rpcs: an admin could not delete a member''s tag'; END IF;
    RESET ROLE;

    -- THE ATTACK (INV-R2e-2): a CHECK on admin_events refuses one action at a time; each act must fail whole and leave its change undone.
    DELETE FROM public.org_member_bans WHERE org_id = org AND user_id = um2;
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, um2, 'member');
    SELECT id INTO mm2 FROM public.org_memberships WHERE org_id = org AND user_id = um2;
    ALTER TABLE public.admin_events ADD CONSTRAINT planted_refuse_event CHECK (action NOT IN ('member_role_changed', 'member_removed', 'member_banned', 'org_renamed', 'member_invited', 'invitation_revoked', 'priority_override_set', 'team_item_restored', 'invitation_accepted')) NOT VALID;
    SELECT count(*) INTO ev_before FROM public.admin_events;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    BEGIN PERFORM public.set_member_role(org, mm2, 'viewer', NULL); RAISE EXCEPTION '0101-membership-rpcs: set_member_role survived a refused event'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.remove_member(org, mm2, NULL); RAISE EXCEPTION '0101-membership-rpcs: remove_member survived a refused event'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.ban_member(org, mm2, 'x'); RAISE EXCEPTION '0101-membership-rpcs: ban_member survived a refused event'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.invite_member(org, 'attack-0101@invalid.example', 'member', repeat('f', 64)); RAISE EXCEPTION '0101-membership-rpcs: invite_member survived a refused event'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.set_priority_override(org, it, 'LOW', 'x'); RAISE EXCEPTION '0101-membership-rpcs: set_priority_override survived a refused event'; EXCEPTION WHEN check_violation THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', uo::text, true);
    BEGIN PERFORM public.rename_org(org, 'Attack Rename', NULL, NULL); RAISE EXCEPTION '0101-membership-rpcs: rename_org survived a refused event'; EXCEPTION WHEN check_violation THEN NULL; END;
    RESET ROLE;
    IF (SELECT role FROM public.org_memberships WHERE id = mm2) <> 'member' OR NOT EXISTS (SELECT 1 FROM public.org_memberships WHERE id = mm2) OR EXISTS (SELECT 1 FROM public.org_member_bans WHERE org_id = org AND user_id = um2)
       OR EXISTS (SELECT 1 FROM public.org_invitations WHERE invited_email = 'attack-0101@invalid.example') OR (SELECT priority_override FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it) <> 'HIGH'
       OR (SELECT name FROM public.organizations WHERE id = org) = 'Attack Rename' OR (SELECT count(*) FROM public.admin_events) <> ev_before THEN
      RAISE EXCEPTION '0101-membership-rpcs: a change survived its refused event';
    END IF;
    ALTER TABLE public.admin_events DROP CONSTRAINT planted_refuse_event;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0101-membership-rpcs OK';
END $$;

COMMIT;
