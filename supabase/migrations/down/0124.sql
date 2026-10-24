-- Down for 0124_reroute_route_via: the catalog returns to what it was before the migration. Fails while a row has a NULL multiplier or a baseline equal to its reroute (such a row cannot be written in the old shape; delete it first).
DROP INDEX public.reroute_events_source_id_idx;
DROP INDEX public.reroute_events_route_key;
ALTER TABLE public.reroute_events
  DROP CONSTRAINT reroute_events_source_id_fkey,
  DROP CONSTRAINT reroute_events_route_via_check,
  DROP COLUMN source_id,
  DROP COLUMN route_via,
  ALTER COLUMN fuel_burn_multiplier SET NOT NULL,
  ADD CONSTRAINT reroute_events_distinct_corridors CHECK ((baseline_corridor_id <> reroute_corridor_id));
COMMENT ON TABLE public.reroute_events IS 'Spec 09 §1.7: the corridor-fix motivator (spec 09 §0). baseline_corridor_id and reroute_corridor_id are DIFFERENT entities.kind=''corridor'' rows by construction (reroute_events_distinct_corridors). src/lib/spec09/reroute.mjs applies fuel_burn_multiplier as a scaling function and names the five-surface compounding chain for the UI notice; it does NOT compute the bracketed FuelEU/EU-ETS penalty itself.';
COMMENT ON COLUMN public.reroute_events.reroute_corridor_id IS 'entities(entity_id), kind expected = corridor, and REQUIRED to differ from baseline_corridor_id.';
