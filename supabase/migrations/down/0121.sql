-- Down for 0121: the client write grants and their policies return; the three new functions go and the four-argument invite_member returns to its 0101 body.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_memberships, public.workspace_item_overrides TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_invitations TO authenticated;
GRANT UPDATE (id, name, slug, settings, created_at, updated_at) ON public.organizations TO authenticated;
GRANT INSERT ON public.community_group_members TO authenticated;
CREATE POLICY membership_write_admin ON public.org_memberships FOR INSERT TO authenticated, service_role
  WITH CHECK (((public.user_org_role(org_id) = ANY (ARRAY['owner'::text, 'admin'::text])) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
CREATE POLICY membership_update_admin ON public.org_memberships FOR UPDATE TO authenticated, service_role
  USING (((public.user_org_role(org_id) = ANY (ARRAY['owner'::text, 'admin'::text])) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
CREATE POLICY membership_delete_admin ON public.org_memberships FOR DELETE TO authenticated, service_role
  USING (((public.user_org_role(org_id) = ANY (ARRAY['owner'::text, 'admin'::text])) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
CREATE POLICY overrides_insert_org ON public.workspace_item_overrides FOR INSERT TO authenticated, service_role
  WITH CHECK ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
CREATE POLICY overrides_update_org ON public.workspace_item_overrides FOR UPDATE TO authenticated, service_role
  USING ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
CREATE POLICY overrides_delete_org ON public.workspace_item_overrides FOR DELETE TO authenticated, service_role
  USING ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
CREATE POLICY org_invitations_admin_update ON public.org_invitations FOR UPDATE TO authenticated, service_role
  USING ((EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.org_id = org_invitations.org_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));
CREATE POLICY org_invitations_admin_insert ON public.org_invitations FOR INSERT TO authenticated, service_role
  WITH CHECK (((EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.org_id = org_invitations.org_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) AND (proposed_role = ANY (ARRAY['admin'::text, 'member'::text, 'viewer'::text])) AND (invited_by_user_id = ( SELECT auth.uid() AS uid))));
COMMENT ON POLICY org_invitations_admin_insert ON public.org_invitations IS 'Org admins can create new invitations. proposed_role limited to admin/member/viewer (owner reserved for org creator).';
CREATE POLICY org_update_admin ON public.organizations FOR UPDATE TO authenticated, service_role
  USING (((EXISTS ( SELECT 1
   FROM public.org_memberships
  WHERE ((org_memberships.org_id = organizations.id) AND (org_memberships.user_id = ( SELECT auth.uid() AS uid)) AND (org_memberships.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
CREATE POLICY community_group_members_insert_admin ON public.community_group_members FOR INSERT TO authenticated, service_role
  WITH CHECK ((public.user_group_role(group_id) = 'admin'::text));
ALTER POLICY bulk_imports_read_authenticated ON public.bulk_imports USING ((( SELECT auth.role() AS role) = 'authenticated'::text));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.brief_apply_runs, public.claim_versions, public.corpus_census, public.coverage_gap_candidates, public.disposition_ledger, public.funded_pass_runlock, public.gate_a_health_cache,
  public.institutions, public.mutation_leases, public.portal_link_candidates, public.propagation_events, public.research_assessments, public.source_reliability_ledger, public.system_state, public.system_state_flag_audit TO authenticated;
GRANT UPDATE ON SEQUENCE public.propagation_events_event_id_seq, public.source_reliability_ledger_id_seq, public.system_state_flag_audit_id_seq TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_is_group_member(uuid, uuid), public.user_is_group_admin(uuid, uuid), public.user_owns_group(uuid, uuid), public.user_belongs_to_org(uuid) TO anon;
DROP FUNCTION public.leave_org(uuid);
DROP FUNCTION public.set_item_dismissal(uuid, uuid, boolean);
DROP FUNCTION public.invite_member(uuid, text, text);
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
REVOKE ALL ON FUNCTION public.invite_member(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.invite_member(uuid, text, text, text) TO authenticated;
COMMENT ON FUNCTION public.invite_member(uuid, text, text, text) IS 'R2e migration 0101. Issue an invitation as an owner or admin. It never reads accounts: an e-mail with an account and one without answer identically.';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'net') THEN
    GRANT USAGE ON SCHEMA net TO PUBLIC, anon, authenticated;
    GRANT ALL ON ALL FUNCTIONS IN SCHEMA net TO PUBLIC, anon, authenticated;
  END IF;
END $$;
