-- Down for 0133_entity_refs_ref_table_state_cost_facts: the refs the widened CHECK admitted go, then the two-table CHECK comes back. The state-code rename is not reversed (the bare codes were the defect).
DELETE FROM public.entity_refs WHERE ref_table = 'state_cost_facts';
ALTER TABLE public.entity_refs DROP CONSTRAINT IF EXISTS entity_refs_ref_table_allowed;
ALTER TABLE public.entity_refs ADD CONSTRAINT entity_refs_ref_table_allowed CHECK ((ref_table = ANY (ARRAY['intelligence_items'::text, 'regions'::text])));
