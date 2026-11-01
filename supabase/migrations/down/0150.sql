-- Down for 0150_listings_rpc_what_it_changes: both functions return to their previous bodies (get_workspace_intelligence_listings as in schema.sql, get_workspace_items_by_ids as in 0095).
DROP FUNCTION public.get_workspace_intelligence_listings(uuid, integer);
CREATE FUNCTION public.get_workspace_intelligence_listings(p_org_id uuid, p_domain integer DEFAULT NULL::integer) RETURNS TABLE(id uuid, legacy_id text, title text, what_is_it text, why_matters text, key_data text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, effective_priority text, effective_archived boolean, jurisdiction_iso text[], item_grade text, cost_mechanism text, penalty_range text, enforcement_body text, requirement_trajectory jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.what_is_it, ii.why_matters,
    ii.key_data, ii.tags, ii.domain, ii.category, ii.item_type,
    ii.source_id, ii.source_url, ii.jurisdictions, ii.transport_modes,
    ii.verticals, ii.status, ii.severity, ii.confidence, ii.priority,
    ii.entry_into_force, ii.compliance_deadline, ii.next_review_date,
    ii.added_date, ii.last_verified, ii.is_archived,
    ii.effective_priority, ii.effective_archived, ii.jurisdiction_iso,
    ii.item_grade,
    ii.cost_mechanism, ii.penalty_range, ii.enforcement_body, ii.requirement_trajectory
  FROM public._workspace_active_items(p_org_id) ii
  WHERE (p_domain IS NULL OR ii.domain = p_domain)
  ORDER BY
    CASE ii.effective_priority
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC, ii.id ASC;
END;
$$;
REVOKE ALL ON FUNCTION public.get_workspace_intelligence_listings(p_org_id uuid, p_domain integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_listings(p_org_id uuid, p_domain integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_listings(p_org_id uuid, p_domain integer) TO service_role;
CREATE OR REPLACE FUNCTION public.get_workspace_items_by_ids(p_org_id uuid, p_ids uuid[]) RETURNS SETOF jsonb
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
