-- Down for 0145_developing_connections_and_forming_patterns: the origin and lifecycle lists, the admissible view and the table lose what 0145 added. It fails, loudly, while a candidate edge, a forming row or a stored `missing` exists (remove them first).
ALTER TABLE public.item_cross_references DROP CONSTRAINT item_cross_references_origin_check;
ALTER TABLE public.item_cross_references ADD CONSTRAINT item_cross_references_origin_check CHECK (origin = ANY (ARRAY['manual'::text, 'agent_semantic'::text, 'entity_extraction'::text, 'provenance_discovery'::text]));
CREATE OR REPLACE VIEW public.derived_values_admissible WITH (security_invoker = on) AS
 SELECT d.value_id,
    d.entity_id,
    d.method_id,
    d.method_version,
    d.value,
    d.value_low,
    d.value_high,
    d.unit,
    d.currency,
    d.derivation,
    d.origin_class,
    d.lifecycle,
    d.admissibility,
    d.base_confidence,
    d.asserted_at,
    d.half_life_days,
    d.inputs,
    d.supersedes,
    d.computed_at,
    d.computed_by,
    d.invalidated_at,
    d.invalidated_by_event,
    public.effective_confidence(d.base_confidence, d.asserted_at, d.half_life_days, now()) AS effective_confidence,
    CASE d.admissibility WHEN 'display_only' THEN 0 WHEN 'analysis_ok' THEN 1 WHEN 'calculation_ok' THEN 2 WHEN 'filing_ok' THEN 3 END AS ceiling_rank
   FROM public.derived_values d
  WHERE d.lifecycle <> ALL (ARRAY['falsified'::text, 'obsolete'::text, 'superseded'::text]) AND d.admissibility <> 'stale'::text;
ALTER TABLE public.derived_values DROP CONSTRAINT derived_values_missing_is_object, DROP COLUMN missing;
ALTER TABLE public.derived_values DROP CONSTRAINT derived_values_lifecycle_check;
ALTER TABLE public.derived_values ADD CONSTRAINT derived_values_lifecycle_check CHECK (lifecycle = ANY (ARRAY['emerging'::text, 'strengthening'::text, 'corroborated'::text, 'verified'::text, 'stalled'::text, 'falsified'::text, 'superseded'::text, 'obsolete'::text]));
