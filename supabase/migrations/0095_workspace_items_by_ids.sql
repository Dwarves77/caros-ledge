-- 0095 get_workspace_items_by_ids: the workspace's view of named items, in one database call (R2d, MASTER I13, register surfaces:80).
--
-- The portfolio's held read and the dashboard's by-id backfill read the item rows directly and merged the workspace overrides by hand (priority_override and the workspace archive), so a third reader applied
-- the rule the list RPCs apply in SQL. This function is the same rule from the same source: it reads _workspace_active_items(org) (verified, not archived by the platform or by the workspace, the workspace's
-- priority as effective_priority) and keeps the named ids that are admissible items (item_is_admissible, 0092: also not replaced). Output: one jsonb object per item with the columns a list row draws.
-- Membership is asserted by _workspace_active_items (a non-member raises 42501; the service role bypasses). Execute: authenticated and service_role.
-- Reversal: DROP FUNCTION public.get_workspace_items_by_ids(uuid, uuid[]).
-- Not applied to production before the cutover window.

-- catalog: function

BEGIN;

CREATE FUNCTION public.get_workspace_items_by_ids(p_org_id uuid, p_ids uuid[]) RETURNS SETOF jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp
  AS $$
  SELECT jsonb_build_object(
      'id', a.id, 'legacy_id', a.legacy_id, 'title', a.title, 'summary', a.summary, 'tags', a.tags, 'domain', a.domain, 'category', a.category, 'item_type', a.item_type,
      'source_id', a.source_id, 'source_url', a.source_url, 'jurisdictions', a.jurisdictions, 'transport_modes', a.transport_modes, 'verticals', a.verticals,
      'priority', a.priority, 'effective_priority', a.effective_priority, 'effective_archived', a.effective_archived, 'compliance_deadline', a.compliance_deadline,
      'added_date', a.added_date, 'is_archived', a.is_archived, 'item_grade', a.item_grade, 'last_regenerated_at', a.last_regenerated_at, 'jurisdiction_iso', a.jurisdiction_iso,
      'origin_class', ii.origin_class)
    FROM public._workspace_active_items(p_org_id) a
    JOIN public.intelligence_items ii ON ii.id = a.id
   WHERE a.id = ANY(p_ids) AND public.item_is_admissible(ii.provenance_status, a.effective_archived, ii.replaced_by)
$$;
COMMENT ON FUNCTION public.get_workspace_items_by_ids(uuid, uuid[]) IS 'The named items as the workspace sees them (R2d migration 0095): admissible items with the workspace priority override and archive applied, one jsonb row each. Membership is asserted by _workspace_active_items.';
REVOKE ALL ON FUNCTION public.get_workspace_items_by_ids(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_workspace_items_by_ids(uuid, uuid[]) TO authenticated, service_role;

-- Self-check 0095-workspace-items-by-ids: a member gets the live items with the workspace priority on them; an item the workspace archived, an item another replaced and an unverified one are absent; an id that does
-- not exist is absent; a user who is not a member of the org is refused; anon holds no execute right.
DO $$
DECLARE
  tag text := 'selfcheck-0095'; org uuid := gen_random_uuid(); usr uuid := gen_random_uuid(); stranger uuid := gen_random_uuid(); i_live uuid; i_plain uuid; i_arch uuid; i_moved uuid; i_raw uuid;
  got jsonb; refused boolean := false;
BEGIN
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id, email) VALUES (usr, tag || '-a@invalid.example'), (stranger, tag || '-b@invalid.example');
    INSERT INTO public.profiles (id, email, display_name) VALUES (usr, tag || '-a@invalid.example', 'a'), (stranger, tag || '-b@invalid.example', 'b');
    INSERT INTO public.organizations (id, name, slug) VALUES (org, tag, tag || '-' || org);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, usr, 'member');
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, priority) VALUES (tag || ' live', 1, 'verified', false, 'LOW') RETURNING id INTO i_live;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, priority) VALUES (tag || ' plain', 1, 'verified', false, 'MODERATE') RETURNING id INTO i_plain;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, priority) VALUES (tag || ' archived by the workspace', 1, 'verified', false, 'HIGH') RETURNING id INTO i_arch;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, priority, replaced_by) VALUES (tag || ' replaced', 1, 'verified', false, 'HIGH', i_live) RETURNING id INTO i_moved;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, priority) VALUES (tag || ' unverified', 1, 'unverified', false, 'HIGH') RETURNING id INTO i_raw;
    INSERT INTO public.workspace_item_overrides (org_id, item_id, priority_override) VALUES (org, i_live, 'CRITICAL');
    INSERT INTO public.workspace_item_overrides (org_id, item_id, is_archived) VALUES (org, i_arch, true);
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', usr::text, true);
    SELECT jsonb_agg(r ORDER BY r ->> 'title') INTO got FROM public.get_workspace_items_by_ids(org, ARRAY[i_live, i_plain, i_arch, i_moved, i_raw, gen_random_uuid()]) AS r;
    IF jsonb_array_length(got) <> 2 THEN RAISE EXCEPTION '0095-workspace-items-by-ids: % items came back, expected the 2 live ones (archived by the workspace, replaced, unverified and unknown ids are absent)', jsonb_array_length(got); END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(got) e WHERE e ->> 'id' = i_live::text AND e ->> 'effective_priority' = 'CRITICAL' AND e ->> 'priority' = 'LOW') THEN
      RAISE EXCEPTION '0095-workspace-items-by-ids: the workspace priority is not on the item (effective_priority must be the override, priority the stored one)';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', stranger::text, true);
    BEGIN
      PERFORM 1 FROM public.get_workspace_items_by_ids(org, ARRAY[i_live]) AS r WHERE r ->> 'id' = i_live::text;
    EXCEPTION WHEN SQLSTATE '42501' THEN refused := true;
    END;
    IF NOT refused THEN RAISE EXCEPTION '0095-workspace-items-by-ids: a user who is not a member of the org read its items'; END IF;
    RESET ROLE;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_function_privilege('anon', 'public.get_workspace_items_by_ids(uuid,uuid[])', 'EXECUTE') OR NOT has_function_privilege('authenticated', 'public.get_workspace_items_by_ids(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION '0095-workspace-items-by-ids: the execute rights are wrong';
  END IF;
  RAISE NOTICE '0095-workspace-items-by-ids OK';
END $$;

COMMIT;
