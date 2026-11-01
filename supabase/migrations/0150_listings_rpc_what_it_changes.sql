-- 0150 listings_rpc_what_it_changes: the listing rows carry the reader's what_it_changes, and the Dashboard's by-id rows carry what_is_it, why_matters and what_it_changes (LIST-RPC-1, wave P58, Section 0 / rule 21).
-- change: get_workspace_intelligence_listings gains what_it_changes in its RETURNS TABLE; get_workspace_items_by_ids adds what_is_it, why_matters and what_it_changes to its jsonb row
--
-- Before: a list row's second line falls through why_matters -> what_it_changes -> what_is_it -> summary -> a composed "Applies in EU; next date ..." line (src/core/lists/row-fields.ts toListRowFields), but the
-- workspace listing RPC returned what_is_it and why_matters only, and the Dashboard's by-id backfill (0095) returned none of the three, so an item whose reader wrote what_it_changes but no why_matters drew the composed
-- fallback on /regulations and on the Dashboard's Due next card (Playwright on fe69d8d9: 4 of 5 Due-next rows). After: both functions carry the fields; the reader maps what_it_changes in the shared row mapping
-- (src/features/lists/map-rows.ts baseResourceFields), so every surface that reads through it draws the same second line. get_workspace_due_next is unchanged: the Dashboard reads it for the ids and the dates only and
-- lays its row over the by-id row (src/features/dashboard/read/digest.ts readDigest). A RETURNS TABLE cannot change under CREATE OR REPLACE, so the listing function is dropped and re-created with the same grants.
-- Access: unchanged (authenticated and service_role execute both; anon neither). Reversal: down/0150.sql restores both bodies as they stood (schema.sql and 0095).

-- catalog: function

BEGIN;

DROP FUNCTION public.get_workspace_intelligence_listings(uuid, integer);
CREATE FUNCTION public.get_workspace_intelligence_listings(p_org_id uuid, p_domain integer DEFAULT NULL::integer) RETURNS TABLE(id uuid, legacy_id text, title text, what_is_it text, why_matters text, what_it_changes text, key_data text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, effective_priority text, effective_archived boolean, jurisdiction_iso text[], item_grade text, cost_mechanism text, penalty_range text, enforcement_body text, requirement_trajectory jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.what_is_it, ii.why_matters, x.what_it_changes,
    ii.key_data, ii.tags, ii.domain, ii.category, ii.item_type,
    ii.source_id, ii.source_url, ii.jurisdictions, ii.transport_modes,
    ii.verticals, ii.status, ii.severity, ii.confidence, ii.priority,
    ii.entry_into_force, ii.compliance_deadline, ii.next_review_date,
    ii.added_date, ii.last_verified, ii.is_archived,
    ii.effective_priority, ii.effective_archived, ii.jurisdiction_iso,
    ii.item_grade,
    ii.cost_mechanism, ii.penalty_range, ii.enforcement_body, ii.requirement_trajectory
  FROM public._workspace_active_items(p_org_id) ii
  JOIN public.intelligence_items x ON x.id = ii.id
  WHERE (p_domain IS NULL OR ii.domain = p_domain)
  ORDER BY
    CASE ii.effective_priority
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC, ii.id ASC;
END;
$$;
COMMENT ON FUNCTION public.get_workspace_intelligence_listings(uuid, integer) IS 'The workspace listing rows (migration 0150 adds what_it_changes): active, verified items with the workspace override applied, ordered by effective priority then added_date. Membership is asserted by _workspace_active_items.';
REVOKE ALL ON FUNCTION public.get_workspace_intelligence_listings(p_org_id uuid, p_domain integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_listings(p_org_id uuid, p_domain integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_listings(p_org_id uuid, p_domain integer) TO service_role;

CREATE OR REPLACE FUNCTION public.get_workspace_items_by_ids(p_org_id uuid, p_ids uuid[]) RETURNS SETOF jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp
  AS $$
  SELECT jsonb_build_object(
      'id', a.id, 'legacy_id', a.legacy_id, 'title', a.title, 'summary', a.summary, 'what_is_it', a.what_is_it, 'why_matters', a.why_matters, 'what_it_changes', ii.what_it_changes,
      'tags', a.tags, 'domain', a.domain, 'category', a.category, 'item_type', a.item_type,
      'source_id', a.source_id, 'source_url', a.source_url, 'jurisdictions', a.jurisdictions, 'transport_modes', a.transport_modes, 'verticals', a.verticals,
      'priority', a.priority, 'effective_priority', a.effective_priority, 'effective_archived', a.effective_archived, 'compliance_deadline', a.compliance_deadline,
      'added_date', a.added_date, 'is_archived', a.is_archived, 'item_grade', a.item_grade, 'last_regenerated_at', a.last_regenerated_at, 'jurisdiction_iso', a.jurisdiction_iso,
      'origin_class', ii.origin_class)
    FROM public._workspace_active_items(p_org_id) a
    JOIN public.intelligence_items ii ON ii.id = a.id
   WHERE a.id = ANY(p_ids) AND public.item_is_admissible(ii.provenance_status, a.effective_archived, ii.replaced_by)
$$;
COMMENT ON FUNCTION public.get_workspace_items_by_ids(uuid, uuid[]) IS 'The named items as the workspace sees them (R2d migration 0095; 0150 adds what_is_it, why_matters, what_it_changes): admissible items with the workspace priority override and archive applied, one jsonb row each. Membership is asserted by _workspace_active_items.';

-- Self-check 0150-listings-rpc-what-it-changes: THE PROOF EXECUTES. A member reads an item whose reader wrote what_it_changes and an empty why_matters (the column is NOT NULL; empty is how a missing reader text is stored): the listing row carries what_it_changes, the by-id row carries all three
-- fields with their values; a stranger is still refused by both; the execute rights are unchanged (authenticated yes, anon no).
DO $$
DECLARE
  tag text := 'selfcheck-0150'; org uuid := gen_random_uuid(); usr uuid := gen_random_uuid(); stranger uuid := gen_random_uuid(); item uuid;
  got_listing text; got_row jsonb; refused int := 0;
BEGIN
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id, email) VALUES (usr, tag || '-a@invalid.example'), (stranger, tag || '-b@invalid.example');
    INSERT INTO public.profiles (id, email, display_name) VALUES (usr, tag || '-a@invalid.example', 'a'), (stranger, tag || '-b@invalid.example', 'b');
    INSERT INTO public.organizations (id, name, slug) VALUES (org, tag, tag || '-' || org);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, usr, 'member');
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, priority, what_is_it, why_matters, what_it_changes)
      VALUES (tag || ' item', 1, 'verified', false, 'HIGH', 'What it is.', '', 'From 2027 every quote carries a surcharge. Then it rises.') RETURNING id INTO item;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', usr::text, true);
    SELECT l.what_it_changes INTO got_listing FROM public.get_workspace_intelligence_listings(org, 1) l WHERE l.id = item;
    IF got_listing IS DISTINCT FROM 'From 2027 every quote carries a surcharge. Then it rises.' THEN RAISE EXCEPTION '0150-listings-rpc-what-it-changes: the listing row does not carry what_it_changes (got %)', got_listing; END IF;
    SELECT r INTO got_row FROM public.get_workspace_items_by_ids(org, ARRAY[item]) r;
    IF got_row IS NULL OR got_row ->> 'what_is_it' IS DISTINCT FROM 'What it is.' OR got_row ->> 'why_matters' IS DISTINCT FROM '' OR got_row ->> 'what_it_changes' IS DISTINCT FROM 'From 2027 every quote carries a surcharge. Then it rises.' THEN
      RAISE EXCEPTION '0150-listings-rpc-what-it-changes: the by-id row does not carry what_is_it, why_matters and what_it_changes (got %)', got_row;
    END IF;
    PERFORM set_config('request.jwt.claim.sub', stranger::text, true);
    BEGIN
      PERFORM 1 FROM public.get_workspace_intelligence_listings(org, 1) l WHERE l.id = item;
    EXCEPTION WHEN SQLSTATE '42501' THEN refused := refused + 1;
    END;
    BEGIN
      PERFORM 1 FROM public.get_workspace_items_by_ids(org, ARRAY[item]) r;
    EXCEPTION WHEN SQLSTATE '42501' THEN refused := refused + 1;
    END;
    IF refused <> 2 THEN RAISE EXCEPTION '0150-listings-rpc-what-it-changes: a user who is not a member of the org read its items (% of 2 reads refused)', refused; END IF;
    RESET ROLE;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_function_privilege('anon', 'public.get_workspace_intelligence_listings(uuid,integer)', 'EXECUTE') OR NOT has_function_privilege('authenticated', 'public.get_workspace_intelligence_listings(uuid,integer)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.get_workspace_intelligence_listings(uuid,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_workspace_items_by_ids(uuid,uuid[])', 'EXECUTE') OR NOT has_function_privilege('authenticated', 'public.get_workspace_items_by_ids(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION '0150-listings-rpc-what-it-changes: the execute rights are wrong';
  END IF;
  RAISE NOTICE '0150-listings-rpc-what-it-changes OK';
END $$;

COMMIT;
