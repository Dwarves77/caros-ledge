-- Down for 0090_derived_values_ceiling: the use-ceiling function goes and the view returns to the body schema.sql gave it (no ceiling_rank, a superseded value visible again).
DROP FUNCTION public.derived_values_for_use(text);
DROP VIEW public.derived_values_admissible;
CREATE VIEW public.derived_values_admissible WITH (security_invoker='on') AS
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
    public.effective_confidence(d.base_confidence, d.asserted_at, d.half_life_days, now()) AS effective_confidence
   FROM public.derived_values d
  WHERE ((d.lifecycle <> ALL (ARRAY['falsified'::text, 'obsolete'::text])) AND (d.admissibility <> 'stale'::text));
COMMENT ON VIEW public.derived_values_admissible IS 'Spec 08 §3.3''s second enforcement point ("RLS denies SELECT on the raw table... granting it only on a view that has already applied the gate"). Hides stale/falsified/obsolete rows and pre-computes effective_confidence so a caller never re-derives the decay formula. Deliberately NOT security_invoker, which is what lets a role with no direct grant on derived_values still read through this view.';
GRANT SELECT ON TABLE public.derived_values_admissible TO authenticated;
GRANT ALL ON TABLE public.derived_values_admissible TO service_role;
