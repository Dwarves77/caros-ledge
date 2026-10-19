-- Down for 0010_derivation_inputs_outbox_and_allowlist: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TRIGGER propagation_outbox_trg ON public.state_cost_facts;
ALTER TABLE public.derivation_edges DROP CONSTRAINT IF EXISTS derivation_edges_from_table_allowed;
ALTER TABLE public.derivation_edges ADD CONSTRAINT derivation_edges_from_table_allowed CHECK ((from_table = ANY (ARRAY['emission_factors'::text, 'market_series'::text, 'regional_data_facts'::text, 'derived_values'::text, 'statutory_computations'::text, 'estimated_values'::text, 'state_cost_facts'::text, 'inference_records'::text])));
