-- 0096 get_research_items(org) and get_operations_items(org): the workspace's Research and Operations lists (R2d, MASTER I13, register surfaces:28).
--
-- Market had a workspace version of its category list (get_market_intel_items(org): the workspace's priority override and archive applied) and Research and Operations had only the public one, so a member who archived
-- an item or changed its priority saw the platform's value on those two pages while Regulations and Market showed theirs. These are the same two functions with the same overlay Market's uses (the override joined on
-- the org, the membership asserted), and the admissible-item rule (item_is_admissible, 0092: verified, not archived by the platform or the workspace, not replaced) as the gate. The public functions stay for the
-- readers with no workspace.
-- Reversal: DROP FUNCTION public.get_research_items(uuid), public.get_operations_items(uuid).
-- Not applied to production before the cutover window.

-- catalog: function

BEGIN;

CREATE FUNCTION public.get_research_items(p_org_id uuid) RETURNS TABLE(id uuid, legacy_id text, title text, summary text, what_is_it text, why_matters text, key_data text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, what_it_changes text, does_not_resolve text, effective_priority text, effective_archived boolean, jurisdiction_iso text[], item_grade text, cost_mechanism text, penalty_range text, enforcement_body text, requirement_trajectory jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.summary, ii.what_is_it, ii.why_matters,
    ii.key_data, ii.tags, ii.domain, ii.category, ii.item_type,
    ii.source_id, ii.source_url, ii.jurisdictions, ii.transport_modes,
    ii.verticals, ii.status, ii.severity, ii.confidence, ii.priority,
    ii.entry_into_force, ii.compliance_deadline, ii.next_review_date,
    ii.added_date, ii.last_verified, ii.is_archived,
    ii.what_it_changes, ii.does_not_resolve,
    COALESCE(wo.priority_override, ii.priority)::text AS effective_priority,
    COALESCE(wo.is_archived, ii.is_archived)          AS effective_archived,
    ii.jurisdiction_iso,
    ii.item_grade,
    ii.cost_mechanism, ii.penalty_range, ii.enforcement_body, ii.requirement_trajectory
  FROM public.intelligence_items ii
  JOIN public.sources s ON s.id = ii.source_id
  LEFT JOIN public.workspace_item_overrides wo ON wo.item_id = ii.id AND wo.org_id = p_org_id
  WHERE public.item_is_admissible(ii.provenance_status, COALESCE(wo.is_archived, ii.is_archived), ii.replaced_by)
    AND public.surface_of(ii.item_type, ii.domain) = 'research'
  ORDER BY
    CASE COALESCE(wo.priority_override, ii.priority)
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC, ii.id ASC;
END;
$$;

CREATE FUNCTION public.get_operations_items(p_org_id uuid) RETURNS TABLE(id uuid, legacy_id text, title text, summary text, what_is_it text, why_matters text, key_data text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, effective_priority text, effective_archived boolean, jurisdiction_iso text[], item_grade text, cost_mechanism text, penalty_range text, enforcement_body text, requirement_trajectory jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.summary, ii.what_is_it, ii.why_matters,
    ii.key_data, ii.tags, ii.domain, ii.category, ii.item_type,
    ii.source_id, ii.source_url, ii.jurisdictions, ii.transport_modes,
    ii.verticals, ii.status, ii.severity, ii.confidence, ii.priority,
    ii.entry_into_force, ii.compliance_deadline, ii.next_review_date,
    ii.added_date, ii.last_verified, ii.is_archived,
    COALESCE(wo.priority_override, ii.priority)::text AS effective_priority,
    COALESCE(wo.is_archived, ii.is_archived)          AS effective_archived,
    ii.jurisdiction_iso,
    ii.item_grade,
    ii.cost_mechanism, ii.penalty_range, ii.enforcement_body, ii.requirement_trajectory
  FROM public.intelligence_items ii
  JOIN public.sources s ON s.id = ii.source_id
  LEFT JOIN public.workspace_item_overrides wo ON wo.item_id = ii.id AND wo.org_id = p_org_id
  WHERE public.item_is_admissible(ii.provenance_status, COALESCE(wo.is_archived, ii.is_archived), ii.replaced_by)
    AND public.surface_of(ii.item_type, ii.domain) = 'operations'
  ORDER BY
    CASE COALESCE(wo.priority_override, ii.priority)
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC, ii.id ASC;
END;
$$;

COMMENT ON FUNCTION public.get_research_items(uuid) IS 'The workspace Research list (R2d migration 0096): admissible items with the workspace priority override and archive applied; membership asserted.';
COMMENT ON FUNCTION public.get_operations_items(uuid) IS 'The workspace Operations list (R2d migration 0096): admissible items with the workspace priority override and archive applied; membership asserted.';
REVOKE ALL ON FUNCTION public.get_research_items(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_operations_items(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_research_items(uuid), public.get_operations_items(uuid) TO authenticated, service_role;

-- Self-check 0096-workspace-category-lists: a member's Research and Operations lists carry the workspace priority and drop the item the workspace archived; the public list still carries the platform's priority and the item;
-- a replaced item and an unverified one are in neither; a user who is not a member is refused; anon holds no execute right on the new functions.
DO $$
DECLARE
  tag text := 'selfcheck-0096'; org uuid := gen_random_uuid(); usr uuid := gen_random_uuid(); stranger uuid := gen_random_uuid(); src uuid := gen_random_uuid();
  r_live uuid; r_arch uuid; r_moved uuid; o_live uuid; o_raw uuid; n int; p text; refused boolean := false;
BEGIN
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id, email) VALUES (usr, tag || '-a@invalid.example'), (stranger, tag || '-b@invalid.example');
    INSERT INTO public.profiles (id, email, display_name) VALUES (usr, tag || '-a@invalid.example', 'a'), (stranger, tag || '-b@invalid.example', 'b');
    INSERT INTO public.organizations (id, name, slug) VALUES (org, tag, tag || '-' || org);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, usr, 'member');
    INSERT INTO public.sources (id, name, url, tier, base_tier, tier_at_creation) VALUES (src, tag || ' source', 'https://selfcheck.invalid/0096', 3, 3, 3);
    INSERT INTO public.intelligence_items (title, domain, item_type, provenance_status, is_archived, priority, source_id) VALUES (tag || ' research live', 7, 'research_finding', 'verified', false, 'LOW', src) RETURNING id INTO r_live;
    INSERT INTO public.intelligence_items (title, domain, item_type, provenance_status, is_archived, priority, source_id) VALUES (tag || ' research archived', 7, 'research_finding', 'verified', false, 'LOW', src) RETURNING id INTO r_arch;
    INSERT INTO public.intelligence_items (title, domain, item_type, provenance_status, is_archived, priority, source_id, replaced_by) VALUES (tag || ' research replaced', 7, 'research_finding', 'verified', false, 'LOW', src, r_live) RETURNING id INTO r_moved;
    INSERT INTO public.intelligence_items (title, domain, item_type, provenance_status, is_archived, priority, source_id) VALUES (tag || ' operations live', 3, 'regional_data', 'verified', false, 'LOW', src) RETURNING id INTO o_live;
    INSERT INTO public.intelligence_items (title, domain, item_type, provenance_status, is_archived, priority, source_id) VALUES (tag || ' operations unverified', 3, 'regional_data', 'unverified', false, 'LOW', src) RETURNING id INTO o_raw;
    INSERT INTO public.workspace_item_overrides (org_id, item_id, priority_override) VALUES (org, r_live, 'CRITICAL'), (org, o_live, 'HIGH');
    INSERT INTO public.workspace_item_overrides (org_id, item_id, is_archived) VALUES (org, r_arch, true);
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', usr::text, true);
    SELECT count(*), max(effective_priority) INTO n, p FROM public.get_research_items(org) WHERE id IN (r_live, r_arch, r_moved);
    IF n <> 1 OR p <> 'CRITICAL' THEN RAISE EXCEPTION '0096-workspace-category-lists: the member Research list holds % of the 3 fixture items (priority %), expected only the live one at CRITICAL', n, p; END IF;
    SELECT count(*), max(effective_priority) INTO n, p FROM public.get_operations_items(org) WHERE id IN (o_live, o_raw);
    IF n <> 1 OR p <> 'HIGH' THEN RAISE EXCEPTION '0096-workspace-category-lists: the member Operations list holds % of the 2 fixture items (priority %), expected only the live one at HIGH', n, p; END IF;
    SELECT count(*), max(effective_priority) INTO n, p FROM public.get_research_items_public() WHERE id IN (r_live, r_arch);
    IF n <> 2 OR p <> 'LOW' THEN RAISE EXCEPTION '0096-workspace-category-lists: the public Research list holds % of the 2 fixture items at %, expected both at the platform LOW', n, p; END IF;
    PERFORM set_config('request.jwt.claim.sub', stranger::text, true);
    BEGIN
      PERFORM 1 FROM public.get_research_items(org) WHERE id = r_live;
    EXCEPTION WHEN SQLSTATE '42501' THEN refused := true;
    END;
    IF NOT refused THEN RAISE EXCEPTION '0096-workspace-category-lists: a user who is not a member of the org read its Research list'; END IF;
    RESET ROLE;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_function_privilege('anon', 'public.get_research_items(uuid)', 'EXECUTE') OR has_function_privilege('anon', 'public.get_operations_items(uuid)', 'EXECUTE') THEN RAISE EXCEPTION '0096-workspace-category-lists: anon can execute the workspace lists'; END IF;
  RAISE NOTICE '0096-workspace-category-lists OK';
END $$;

COMMIT;
