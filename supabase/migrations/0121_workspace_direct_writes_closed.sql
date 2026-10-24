-- 0121 the workspace tables are written by their functions only: memberships, overrides, invitations and organisations by RPC; leave_org; invite_member mints its token (security audit 2026-10-23: 2.2.1, 2.3.1 to 2.3.5, the P2 revokes).
--
-- Before: an owner of any organisation could INSERT an org_memberships row for ANY account (policy membership_write_admin, table grant to authenticated) and so read that person's e-mail and profile, with no consent row and no
-- event; a plain member could UPDATE workspace_item_overrides (team archive with a forged archived_by, a priority, an owner who is not a member); an admin could rewrite org_invitations in place (retarget, resurrect, extend,
-- forge an acceptance) and rename the organisation around rename_org; every signed-in account read every admin bulk import, raw_input included. 0101's header said the trigger refuses a direct write; its self-check never tried
-- one. After: no client role holds INSERT, UPDATE or DELETE on org_memberships and workspace_item_overrides, INSERT and UPDATE on org_invitations, UPDATE on organizations, INSERT on community_group_members; their write policies are gone (the
-- SELECT policies stay, and so does every write that is a SECURITY DEFINER function: accept_invitation_by_id, create_org_for_self, set_member_role, remove_member, ban_member, rename_org, revoke_invitation, archive_item_for_team,
-- assign_item, set_priority_override, restore_team_item, accept_group_invitation). The self-check below ATTACKS each path as the real `authenticated` role and requires 42501.
--   * leave_org(org): a member's own exit (there was no policy for it). The last owner cannot leave (22023, the rule org_membership_role_guard applies); one admin_events row 'leave_org'.
--   * invite_member(org, email, role) RETURNS text: the function generates the token (32 random bytes as 64 hex characters), stores it through token_input exactly as before (the trigger hashes it, 0018) and returns it once. The
--     four-argument form, which stored whatever token the caller chose (repeat('0', 64) was accepted), is dropped.
--   * set_item_dismissal(org, item, dismissed): the workspace dismissal (dismissed_at) was the one write a member legitimately made on workspace_item_overrides; with the table closed it has its own function (a member, admin or
--     owner; a viewer is refused). It touches dismissed_at only: a priority is set by set_priority_override (owner or admin, a reason, an event), never as a side effect of a dismissal.
--   * bulk_imports: readable by a platform admin only (the policy was `auth.role() = 'authenticated'`).
--   * The 15 RLS-on tables with no policy lose their dead grants to authenticated (a grant with no policy is one permissive policy away from open); authenticated loses UPDATE on every sequence (three held it);
--     the four membership oracles (user_is_group_member, user_is_group_admin, user_owns_group, user_belongs_to_org) are no longer executable by anon (the policies keep calling them as authenticated).
--   * schema net (pg_net): the revoke is issued; on Supabase the schema belongs to supabase_admin, `postgres` holds USAGE on it without grant option and anon/authenticated reach it through PUBLIC, so the statements change
--     nothing there. The block says so with a WARNING when it did not take effect, and the commands to run as supabase_admin are in the PR.
-- Not applied to production before the cutover window.
--
-- Reversal: down/0121.sql restores the grants, the nine policies and the four-argument invite_member, and drops leave_org, set_item_dismissal and the three-argument invite_member.

-- catalog: function, policy, acl

BEGIN;

-- 1. The direct write paths.
REVOKE INSERT, UPDATE, DELETE ON public.org_memberships, public.workspace_item_overrides FROM authenticated;
REVOKE INSERT, UPDATE ON public.org_invitations FROM authenticated;
REVOKE UPDATE ON public.organizations FROM authenticated;
REVOKE INSERT ON public.community_group_members FROM authenticated;
DROP POLICY IF EXISTS membership_write_admin ON public.org_memberships;
DROP POLICY IF EXISTS membership_update_admin ON public.org_memberships;
DROP POLICY IF EXISTS membership_delete_admin ON public.org_memberships;
DROP POLICY IF EXISTS overrides_insert_org ON public.workspace_item_overrides;
DROP POLICY IF EXISTS overrides_update_org ON public.workspace_item_overrides;
DROP POLICY IF EXISTS overrides_delete_org ON public.workspace_item_overrides;
DROP POLICY IF EXISTS org_invitations_admin_update ON public.org_invitations;
DROP POLICY IF EXISTS org_invitations_admin_insert ON public.org_invitations;
DROP POLICY IF EXISTS org_update_admin ON public.organizations;
DROP POLICY IF EXISTS community_group_members_insert_admin ON public.community_group_members;

-- 2. Admin bulk imports are the platform admin's.
ALTER POLICY bulk_imports_read_authenticated ON public.bulk_imports USING ((SELECT public.is_platform_admin()));

-- 3. Grants wider than policies.
REVOKE ALL ON public.brief_apply_runs, public.claim_versions, public.corpus_census, public.coverage_gap_candidates, public.disposition_ledger, public.funded_pass_runlock, public.gate_a_health_cache, public.institutions,
  public.mutation_leases, public.portal_link_candidates, public.propagation_events, public.research_assessments, public.source_reliability_ledger, public.system_state, public.system_state_flag_audit FROM authenticated;
REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA public FROM authenticated;

-- 4. Oracles and pg_net.
REVOKE EXECUTE ON FUNCTION public.user_is_group_member(uuid, uuid), public.user_is_group_admin(uuid, uuid), public.user_owns_group(uuid, uuid), public.user_belongs_to_org(uuid) FROM anon;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') THEN
    REVOKE USAGE ON SCHEMA net FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC, anon, authenticated;
    IF has_schema_privilege('anon', 'net', 'USAGE') OR has_schema_privilege('authenticated', 'net', 'USAGE') THEN
      RAISE WARNING '0121: schema net still grants USAGE to anon or authenticated (it belongs to % and this role holds no grant option on it). Run as supabase_admin: REVOKE USAGE ON SCHEMA net FROM PUBLIC, anon, authenticated; REVOKE ALL ON ALL FUNCTIONS IN SCHEMA net FROM PUBLIC, anon, authenticated;', (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'net');
    END IF;
  END IF;
END $$;

-- 5. A member leaves. The last owner never does; the act is recorded like every other membership act.
CREATE FUNCTION public.leave_org(p_org_id uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE uid uuid := auth.uid(); m public.org_memberships; others int;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to leave an organisation' USING ERRCODE = '42501'; END IF;
  SELECT * INTO m FROM public.org_memberships WHERE org_id = p_org_id AND user_id = uid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'you are not a member of this organisation' USING ERRCODE = 'P0002'; END IF;
  IF m.role = 'owner' THEN
    PERFORM 1 FROM public.org_memberships WHERE org_id = p_org_id AND role = 'owner' ORDER BY id FOR UPDATE;
    SELECT count(*) INTO others FROM public.org_memberships WHERE org_id = p_org_id AND role = 'owner' AND id <> m.id;
    IF others = 0 THEN RAISE EXCEPTION 'the last owner cannot leave; transfer ownership first' USING ERRCODE = '22023'; END IF;
  END IF;
  DELETE FROM public.org_memberships WHERE id = m.id;
  PERFORM public.record_admin_event(p_org_id, 'leave_org', 'membership', m.id::text, NULL, jsonb_build_object('role', m.role));
END;
$$;

-- 6. The function mints the invitation token.
DROP FUNCTION public.invite_member(uuid, text, text, text);
CREATE FUNCTION public.invite_member(p_org_id uuid, p_email text, p_role text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE uid uuid := auth.uid(); v_email text := lower(btrim(coalesce(p_email, ''))); i public.org_invitations; v_token text := encode(extensions.gen_random_bytes(32), 'hex');
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to invite a member' USING ERRCODE = '42501'; END IF;
  IF NOT public.org_can(p_org_id, 'invite_member') THEN RAISE EXCEPTION 'only org admins can invite members' USING ERRCODE = '42501'; END IF;
  IF p_role IS NULL OR p_role NOT IN ('admin', 'member', 'viewer') THEN RAISE EXCEPTION 'an invitation proposes admin, member or viewer' USING ERRCODE = '22023'; END IF;
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' OR length(v_email) > 254 THEN RAISE EXCEPTION 'enter a valid e-mail address' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input) VALUES (p_org_id, v_email, uid, p_role, v_token) RETURNING * INTO i;
  PERFORM public.record_admin_event(p_org_id, 'member_invited', 'invitation', i.id::text, NULL, jsonb_build_object('role', p_role));
  RETURN v_token;
END;
$$;

-- 7. A workspace dismissal, now that the table takes no client write.
CREATE FUNCTION public.set_item_dismissal(p_org_id uuid, p_item_id uuid, p_dismissed boolean) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE uid uuid := auth.uid(); o public.workspace_item_overrides;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to dismiss an item' USING ERRCODE = '42501'; END IF;
  IF p_dismissed IS NULL THEN RAISE EXCEPTION 'say whether the item is dismissed' USING ERRCODE = '22023'; END IF;
  IF NOT public.user_can_write_in_org(p_org_id) THEN RAISE EXCEPTION 'a viewer can read this workspace but cannot dismiss an item' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.intelligence_items i WHERE i.id = p_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such item' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.workspace_item_overrides (org_id, item_id, dismissed_at, updated_at) VALUES (p_org_id, p_item_id, CASE WHEN p_dismissed THEN now() END, now())
    ON CONFLICT (org_id, item_id) DO UPDATE SET dismissed_at = EXCLUDED.dismissed_at, updated_at = EXCLUDED.updated_at
    RETURNING * INTO o;
  RETURN to_jsonb(o);
END;
$$;

REVOKE ALL ON FUNCTION public.leave_org(uuid), public.invite_member(uuid, text, text), public.set_item_dismissal(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leave_org(uuid), public.invite_member(uuid, text, text), public.set_item_dismissal(uuid, uuid, boolean) TO authenticated;
COMMENT ON FUNCTION public.leave_org(uuid) IS 'Migration 0121. A member leaves their organisation: the last owner cannot (22023), one admin_events row leave_org in the same transaction.';
COMMENT ON FUNCTION public.invite_member(uuid, text, text) IS 'Migration 0121. Issue an invitation as an owner or admin and return its token once: 64 hex characters generated here (the caller no longer chooses it), hashed by the 0018 trigger; it never reads accounts: an e-mail with an account and one without answer identically.';
COMMENT ON FUNCTION public.set_item_dismissal(uuid, uuid, boolean) IS 'Migration 0121. Dismiss or restore an item for the workspace (dismissed_at only): a member, admin or owner; a viewer is refused.';

-- Self-check 0121: in a fixture that rolls back. ATTACKS as the real authenticated role, each of which MUST fail with 42501: an owner inserts a membership for an account that never accepted anything; a group admin adds a group member; a member sets a priority
-- directly; an admin rewrites an invitation's expiry and renames the organisation; and a signed-in non-admin reads zero bulk imports while the row exists (the platform admin reads it); each of the 15 policy-less tables is refused to
-- authenticated; anon cannot run the four membership oracles. CONTROLS that must still work: the SELECT policies of the four tables, the functions that write them (set_priority_override by an admin with a reason, refused to a member;
-- set_item_dismissal; invite_member; leave_org). invite_member returns 64 hex characters whose sha256 is the stored token_hash, a second call returns another, and the four-argument form is gone. leave_org: a non-last owner and a
-- member leave (row gone, exactly one event each), the last owner is refused (22023) with the row and the event count unchanged, a stranger and a signed-out caller are refused. No attack uses setval or nextval (a sequence change is not
-- rolled back), so the sequence revoke is asserted by privilege.
DO $$
DECLARE
  org uuid := gen_random_uuid(); uo uuid := gen_random_uuid(); uo2 uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); um uuid := gen_random_uuid(); ul uuid := gen_random_uuid(); uv uuid := gen_random_uuid();
  uw uuid := gen_random_uuid(); us uuid := gen_random_uuid(); up uuid := gen_random_uuid(); g uuid := gen_random_uuid(); it uuid; inv uuid; bi uuid; tok text; tok2 text; h text; n int; ev int; t text; f text; v_exp timestamptz;
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email) SELECT u, left(u::text, 8) || '-0121@invalid.example' FROM unnest(ARRAY[uo, uo2, ua, um, ul, uv, uw, us, up]) AS u;
    INSERT INTO public.profiles (id, email, full_name) SELECT u, left(u::text, 8) || '-0121@invalid.example', 'selfcheck 0121 ' || left(u::text, 4) FROM unnest(ARRAY[uo, uo2, ua, um, ul, uv, uw, us, up]) AS u;
    UPDATE public.profiles SET is_platform_admin = true WHERE id = up;
    INSERT INTO public.organizations (id, name, slug) VALUES (org, 'selfcheck-0121', 'selfcheck-0121-' || org);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, uo, 'owner'), (org, uo2, 'owner'), (org, ua, 'admin'), (org, um, 'member'), (org, ul, 'member'), (org, uw, 'viewer');
    INSERT INTO public.community_groups (id, name, slug, region, privacy, owner_user_id) VALUES (g, 'selfcheck-0121 group', 'selfcheck-0121-' || g, 'GLOBAL', 'private', uo);
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g, uo, 'admin');
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0121 one', 1, 'verified', false) RETURNING id INTO it;
    INSERT INTO public.workspace_item_overrides (org_id, item_id) VALUES (org, it);
    INSERT INTO public.bulk_imports (imported_by, format, total_rows, raw_input, preview_summary) VALUES (up, 'csv', 1, 'selfcheck-0121 raw input', '{}'::jsonb) RETURNING id INTO bi;

    -- The structure that made the attacks possible is gone: the old overload, the write policies.
    IF to_regprocedure('public.invite_member(uuid,text,text,text)') IS NOT NULL THEN RAISE EXCEPTION '0121-direct-writes: the four-argument invite_member (the caller chooses the token) still exists'; END IF;
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid IN ('public.org_memberships'::regclass, 'public.workspace_item_overrides'::regclass, 'public.org_invitations'::regclass, 'public.organizations'::regclass)
                 AND polcmd IN ('a', 'w', 'd') AND polname !~ '(service|write_service)') THEN
      RAISE EXCEPTION '0121-direct-writes: a client write policy remains on the four tables: %', (SELECT string_agg(polname, ', ') FROM pg_policy WHERE polrelid IN ('public.org_memberships'::regclass, 'public.workspace_item_overrides'::regclass, 'public.org_invitations'::regclass, 'public.organizations'::regclass) AND polcmd IN ('a', 'w', 'd') AND polname !~ '(service|write_service)');
    END IF;

    -- ATTACK 1 (the force-join): an owner of the organisation inserts a membership for an account that did not accept anything. The JWT carries role=authenticated, as PostgREST sets it (a policy on auth.role() sees it).
    PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', uo::text, true);
    BEGIN INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, uv, 'member'); RAISE EXCEPTION '0121 attack 1: an owner inserted a membership for another account';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN UPDATE public.org_memberships SET role = 'owner' WHERE org_id = org AND user_id = ua; RAISE EXCEPTION '0121 attack 1: an owner updated a membership directly';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN DELETE FROM public.org_memberships WHERE org_id = org AND user_id = um; RAISE EXCEPTION '0121 attack 1: an owner deleted a membership directly';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    -- ATTACK 1b: a group admin adds any account to their group (accept_group_invitation is the consented path).
    BEGIN INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g, uv, 'member'); RAISE EXCEPTION '0121 attack 1b: a group admin inserted a group member for another account';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    SELECT count(*) INTO n FROM public.community_group_members WHERE group_id = g;
    IF n <> 1 THEN RAISE EXCEPTION '0121 control: the group admin reads % of the 1 group memberships (the SELECT policy must stay)', n; END IF;
    -- control: the roster is still readable to a member of the organisation
    SELECT count(*) INTO n FROM public.org_memberships WHERE org_id = org;
    IF n <> 6 THEN RAISE EXCEPTION '0121 control: the owner reads % of the 6 memberships (the SELECT policy must stay)', n; END IF;

    -- ATTACK 2: a plain member sets a priority, archives for the team and names an owner who is not a member, directly on the overrides row.
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    BEGIN UPDATE public.workspace_item_overrides SET priority_override = 'LOW' WHERE org_id = org AND item_id = it; RAISE EXCEPTION '0121 attack 2: a member set a priority directly';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN UPDATE public.workspace_item_overrides SET is_archived = true, archived_by = uo WHERE org_id = org AND item_id = it; RAISE EXCEPTION '0121 attack 2: a member archived for the team with a forged archiver';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN UPDATE public.workspace_item_overrides SET owner_user_id = uv WHERE org_id = org AND item_id = it; RAISE EXCEPTION '0121 attack 2: a member made a non-member the owner of an item';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN INSERT INTO public.workspace_item_overrides (org_id, item_id, priority_override) VALUES (org, gen_random_uuid(), 'LOW'); RAISE EXCEPTION '0121 attack 2: a member inserted an override row';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN DELETE FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it; RAISE EXCEPTION '0121 attack 2: a member deleted an override row';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    SELECT count(*) INTO n FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it;
    IF n <> 1 THEN RAISE EXCEPTION '0121 control: a member reads % of the 1 override rows (the SELECT policy must stay)', n; END IF;
    -- the function path: refused to a member, allowed to an admin with a reason, refused without one
    BEGIN PERFORM public.set_priority_override(org, it, 'LOW', 'because'); RAISE EXCEPTION '0121 attack 2: a member set a priority through set_priority_override';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

    -- ATTACK 3: an admin rewrites an invitation in place and renames the organisation around rename_org.
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', uo::text, true);
    SET LOCAL ROLE authenticated;
    tok := public.invite_member(org, 'selfcheck-0121-a@invalid.example', 'member');
    RESET ROLE;
    SELECT id, expires_at, token_hash INTO inv, v_exp, h FROM public.org_invitations WHERE org_id = org AND invited_email = 'selfcheck-0121-a@invalid.example';
    IF tok !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION '0121-direct-writes: invite_member returned a token that is not 64 hex characters'; END IF;
    IF h IS DISTINCT FROM encode(sha256(convert_to(tok, 'UTF8')), 'hex') THEN RAISE EXCEPTION '0121-direct-writes: the stored token_hash is not the sha256 of the returned token'; END IF;
    IF (SELECT token_last4 FROM public.org_invitations WHERE id = inv) IS DISTINCT FROM right(tok, 4) THEN RAISE EXCEPTION '0121-direct-writes: token_last4 is not the end of the returned token'; END IF;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    BEGIN UPDATE public.org_invitations SET expires_at = now() + interval '10 years' WHERE id = inv; RAISE EXCEPTION '0121 attack 3: an admin extended an invitation';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN UPDATE public.org_invitations SET status = 'accepted', accepted_by_user_id = ua WHERE id = inv; RAISE EXCEPTION '0121 attack 3: an admin forged an acceptance';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input) VALUES (org, 'selfcheck-0121-z@invalid.example', ua, 'admin', repeat('0', 64)); RAISE EXCEPTION '0121 attack 3: an admin inserted an invitation around invite_member';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN UPDATE public.organizations SET name = 'x' WHERE id = org; RAISE EXCEPTION '0121 attack 3: an admin renamed the organisation directly';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN UPDATE public.organizations SET slug = 'x-0121' WHERE id = org; RAISE EXCEPTION '0121 attack 3: an admin re-slugged the organisation directly';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    SELECT count(*) INTO n FROM public.org_invitations WHERE org_id = org;
    IF n <> 1 THEN RAISE EXCEPTION '0121 control: the admin reads % of the 1 invitations (the SELECT policy must stay)', n; END IF;
    SELECT count(*) INTO n FROM public.organizations WHERE id = org;
    IF n <> 1 THEN RAISE EXCEPTION '0121 control: a member reads % of the 1 organisations (the SELECT policy must stay)', n; END IF;
    BEGIN PERFORM public.rename_org(org, 'renamed by an admin', NULL, NULL); RAISE EXCEPTION '0121 attack 3: an admin renamed through rename_org (owner only)';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    -- control: the admin's priority through the function, with a reason
    PERFORM public.set_priority_override(org, it, 'LOW', 'selfcheck 0121');
    BEGIN PERFORM public.set_priority_override(org, it, 'HIGH', '  '); RAISE EXCEPTION '0121 control: a priority was set with a blank reason';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    RESET ROLE;
    IF (SELECT priority_override FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it) IS DISTINCT FROM 'LOW' THEN RAISE EXCEPTION '0121 control: set_priority_override did not set the priority'; END IF;
    SELECT count(*) INTO n FROM public.admin_events WHERE org_id = org AND action = 'priority_override_set';
    IF n <> 1 THEN RAISE EXCEPTION '0121 control: set_priority_override wrote % events, not 1', n; END IF;
    IF (SELECT name FROM public.organizations WHERE id = org) <> 'selfcheck-0121' OR (SELECT expires_at FROM public.org_invitations WHERE id = inv) IS DISTINCT FROM v_exp THEN RAISE EXCEPTION '0121 attack 3: a refused write changed a row'; END IF;
    IF EXISTS (SELECT 1 FROM public.org_memberships WHERE org_id = org AND user_id = uv) OR (SELECT count(*) FROM public.org_memberships WHERE org_id = org) <> 6 THEN RAISE EXCEPTION '0121 attack 1: a refused write changed a membership'; END IF;

    -- invite_member: another call, another token; a member and a viewer are refused; a bad role is refused.
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    tok2 := public.invite_member(org, 'selfcheck-0121-b@invalid.example', 'viewer');
    IF tok2 !~ '^[0-9a-f]{64}$' OR tok2 = tok THEN RAISE EXCEPTION '0121-direct-writes: the second invitation token repeats or is malformed'; END IF;
    BEGIN PERFORM public.invite_member(org, 'selfcheck-0121-c@invalid.example', 'owner'); RAISE EXCEPTION '0121-direct-writes: an invitation proposed the owner role';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    BEGIN PERFORM public.invite_member(org, 'selfcheck-0121-d@invalid.example', 'member'); RAISE EXCEPTION '0121-direct-writes: a member invited';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;

    -- set_item_dismissal: a member dismisses and restores; a viewer and a stranger are refused; the priority is untouched.
    PERFORM public.set_item_dismissal(org, it, true);
    RESET ROLE;
    IF (SELECT dismissed_at FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it) IS NULL OR (SELECT priority_override FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it) IS DISTINCT FROM 'LOW' THEN
      RAISE EXCEPTION '0121-direct-writes: set_item_dismissal did not dismiss, or it changed the priority';
    END IF;
    SET LOCAL ROLE authenticated;
    PERFORM public.set_item_dismissal(org, it, false);
    PERFORM set_config('request.jwt.claim.sub', uw::text, true);
    BEGIN PERFORM public.set_item_dismissal(org, it, true); RAISE EXCEPTION '0121-direct-writes: a viewer dismissed an item'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', us::text, true);
    BEGIN PERFORM public.set_item_dismissal(org, it, true); RAISE EXCEPTION '0121-direct-writes: a stranger dismissed an item'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    RESET ROLE;
    IF (SELECT dismissed_at FROM public.workspace_item_overrides WHERE org_id = org AND item_id = it) IS NOT NULL THEN RAISE EXCEPTION '0121-direct-writes: a refused or restoring set_item_dismissal left the item dismissed'; END IF;

    -- ATTACK 4: a signed-in non-admin reads the admin bulk imports (the row exists); the platform admin reads it.
    SELECT count(*) INTO n FROM public.bulk_imports WHERE id = bi;
    IF n <> 1 THEN RAISE EXCEPTION '0121 attack 4: the fixture bulk import is missing'; END IF;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    SELECT count(*) INTO n FROM public.bulk_imports WHERE id = bi;
    IF n <> 0 THEN RAISE EXCEPTION '0121 attack 4: a member read % bulk imports', n; END IF;
    PERFORM set_config('request.jwt.claim.sub', up::text, true);
    SELECT count(*) INTO n FROM public.bulk_imports WHERE id = bi;
    IF n <> 1 THEN RAISE EXCEPTION '0121 control: the platform admin reads % of the 1 bulk imports', n; END IF;

    -- ATTACK 5: authenticated reads each of the 15 policy-less tables; anon runs the four oracles.
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    FOREACH t IN ARRAY ARRAY['brief_apply_runs', 'claim_versions', 'corpus_census', 'coverage_gap_candidates', 'disposition_ledger', 'funded_pass_runlock', 'gate_a_health_cache', 'institutions', 'mutation_leases',
                             'portal_link_candidates', 'propagation_events', 'research_assessments', 'source_reliability_ledger', 'system_state', 'system_state_flag_audit'] LOOP
      BEGIN EXECUTE format('SELECT count(*) FROM public.%I', t); RAISE EXCEPTION '0121 attack 5: authenticated read public.%', t;
      EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    END LOOP;
    RESET ROLE;
    SET LOCAL ROLE anon;
    BEGIN PERFORM public.user_belongs_to_org(org); RAISE EXCEPTION '0121 attack 5: anon ran user_belongs_to_org'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.user_is_group_member(org, uv); RAISE EXCEPTION '0121 attack 5: anon ran user_is_group_member'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.user_is_group_admin(org, uv); RAISE EXCEPTION '0121 attack 5: anon ran user_is_group_admin'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.user_owns_group(org, uv); RAISE EXCEPTION '0121 attack 5: anon ran user_owns_group'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    RESET ROLE;
    FOREACH f IN ARRAY ARRAY['public.user_is_group_member(uuid,uuid)', 'public.user_is_group_admin(uuid,uuid)', 'public.user_owns_group(uuid,uuid)', 'public.user_belongs_to_org(uuid)'] LOOP
      IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN RAISE EXCEPTION '0121 control: authenticated lost % (the policies call it)', f; END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND CASE WHEN c.relkind = 'S' THEN has_sequence_privilege('authenticated', c.oid, 'UPDATE') ELSE false END) THEN RAISE EXCEPTION '0121 attack 5: authenticated holds UPDATE on a public sequence'; END IF;

    -- leave_org: signed out and a stranger are refused; a member leaves (row gone, one event); a second owner leaves; the last owner is refused with nothing changed.
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN PERFORM public.leave_org(org); RAISE EXCEPTION '0121-direct-writes: leave_org ran with no session'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', us::text, true);
    BEGIN PERFORM public.leave_org(org); RAISE EXCEPTION '0121-direct-writes: a stranger left an organisation they are not in'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', ul::text, true);
    PERFORM public.leave_org(org);
    RESET ROLE;
    SELECT count(*) INTO n FROM public.org_memberships WHERE org_id = org AND user_id = ul;
    SELECT count(*) INTO ev FROM public.admin_events WHERE org_id = org AND action = 'leave_org' AND actor_id = ul;
    IF n <> 0 OR ev <> 1 THEN RAISE EXCEPTION '0121-direct-writes: a member left but the row count is % (want 0) and the events % (want 1)', n, ev; END IF;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', uo2::text, true);
    PERFORM public.leave_org(org);
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM public.org_memberships WHERE org_id = org AND user_id = uo2) OR (SELECT count(*) FROM public.admin_events WHERE org_id = org AND action = 'leave_org') <> 2 THEN
      RAISE EXCEPTION '0121-direct-writes: a second owner could not leave, or the event is missing';
    END IF;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', uo::text, true);
    BEGIN PERFORM public.leave_org(org); RAISE EXCEPTION '0121-direct-writes: the last owner left'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM public.org_memberships WHERE org_id = org AND user_id = uo AND role = 'owner') OR (SELECT count(*) FROM public.admin_events WHERE org_id = org AND action = 'leave_org') <> 2 THEN
      RAISE EXCEPTION '0121-direct-writes: the refused last owner changed the membership or wrote an event';
    END IF;

    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0121 OK';
END $$;

COMMIT;
