-- Down for 0035_admin_triage_rpcs: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.resolve_pending_jurisdiction_review(uuid,text,text,uuid);
DROP FUNCTION public.admin_attention_counts();
CREATE FUNCTION public.admin_attention_counts()
 RETURNS TABLE(provisional_sources_pending integer, staged_updates_pending integer, staged_updates_materialization_failed integer, integrity_flags_unresolved integer, platform_integrity_flags_open integer, source_attribution_mismatches integer, auto_approved_awaiting_spotcheck integer, coverage_gaps_critical integer, total integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  WITH counts AS (
    SELECT
      (SELECT COUNT(*)::INT FROM provisional_sources
        WHERE status IN ('pending_review', 'needs_more_data')) AS provisional_sources_pending,
      (SELECT COUNT(*)::INT FROM staged_updates WHERE status = 'pending') AS staged_updates_pending,
      (SELECT COUNT(*)::INT FROM staged_updates
        WHERE status = 'approved'
          AND materialized_at IS NULL
          AND materialization_error IS NOT NULL) AS staged_updates_materialization_failed,
      (SELECT COUNT(*)::INT FROM intelligence_items
        WHERE agent_integrity_flag = TRUE
          AND agent_integrity_resolved_at IS NULL) AS integrity_flags_unresolved,
      (SELECT COUNT(*)::INT FROM integrity_flags
        WHERE status IN ('open', 'in_review')) AS platform_integrity_flags_open,
      0 AS source_attribution_mismatches,
      (SELECT COUNT(*)::INT FROM sources
        WHERE created_at > NOW() - INTERVAL '7 days'
          AND COALESCE(spotchecked, FALSE) = FALSE) AS auto_approved_awaiting_spotcheck,
      0 AS coverage_gaps_critical
  )
  SELECT
    provisional_sources_pending,
    staged_updates_pending,
    staged_updates_materialization_failed,
    integrity_flags_unresolved,
    platform_integrity_flags_open,
    source_attribution_mismatches,
    auto_approved_awaiting_spotcheck,
    coverage_gaps_critical,
    (provisional_sources_pending
     + staged_updates_pending
     + staged_updates_materialization_failed
     + integrity_flags_unresolved
     + platform_integrity_flags_open
     + source_attribution_mismatches
     + auto_approved_awaiting_spotcheck
     + coverage_gaps_critical) AS total
  FROM counts;
$function$
;
REVOKE ALL ON FUNCTION public.admin_attention_counts() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_attention_counts() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_attention_counts() TO "anon";
GRANT EXECUTE ON FUNCTION public.admin_attention_counts() TO "authenticated";
GRANT EXECUTE ON FUNCTION public.admin_attention_counts() TO "service_role";
