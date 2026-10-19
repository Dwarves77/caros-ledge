-- Down for 0005_vocabulary_checks: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
ALTER TABLE public.monitoring_queue DROP CONSTRAINT IF EXISTS monitoring_queue_last_result_check;
ALTER TABLE public.monitoring_queue ADD CONSTRAINT monitoring_queue_last_result_check CHECK (((last_result IS NULL) OR (last_result = ANY (ARRAY['no_change'::text, 'updated'::text, 'new_item'::text, 'error'::text, 'inaccessible'::text]))));
ALTER TABLE public.state_cost_facts DROP CONSTRAINT IF EXISTS state_cost_facts_dimension_check;
ALTER TABLE public.state_cost_facts ADD CONSTRAINT state_cost_facts_dimension_check CHECK ((dimension = ANY (ARRAY['regulatory_feasibility'::text, 'regional_resources'::text, 'labor_markets'::text, 'materials_sourcing'::text, 'infrastructure'::text, 'operational_cost'::text])));
ALTER TABLE public.user_watchlist DROP CONSTRAINT IF EXISTS user_watchlist_item_type_check;
ALTER TABLE public.user_watchlist ADD CONSTRAINT user_watchlist_item_type_check CHECK ((item_type = ANY (ARRAY['source'::text, 'reg'::text, 'signal'::text, 'research'::text, 'operations'::text])));
