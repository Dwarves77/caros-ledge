-- Down for 0092_source_coverage: the view and the admissible-item rule go.
DROP VIEW public.source_coverage;
DROP FUNCTION public.item_is_admissible(public.provenance_status, boolean, uuid);
