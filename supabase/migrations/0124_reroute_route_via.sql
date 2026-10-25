-- 0124 reroute_route_via: a reroute is the same corridor sailed another way, so the row says which way (ARM-2).
--
-- Before: corridor identity is ORIGIN-DEST:mode (entities/id.ts corridorSeed), so Suez and the Cape of Good Hope between one port pair are ONE corridor entity, and reroute_events_distinct_corridors (baseline <> reroute) refused every
-- real reroute; fuel_burn_multiplier was required, yet no carrier advisory states a multiplier (it is derived later from the stated transit days or distance, derived_values); and the table kept no source, so a row could not show the
-- advisory it was authored from. After: route_via names the way (suez, cape_of_good_hope, panama, cape_horn, arctic, overland) under a CHECK; the distinct-corridors constraint is dropped; the row key is
-- (baseline_corridor_id, route_via, effective_from) under a unique index; fuel_burn_multiplier is nullable (its > 0 CHECK stays, so a typed zero or negative value is still refused); source_id (the registered advisory page) is added,
-- nullable for rows that predate it, written by the reroute producer on every row. Corridor identity is unchanged: no new entities.
-- The table holds no row at the time of writing (checked against production 2026-10-24); a database that does hold rows refuses this file rather than guess a route for them.
-- Access: unchanged (the table's policies and grants are not touched).
--
-- Reversal: down/0124.sql. It fails, by design, while any row has a NULL multiplier or a baseline equal to its reroute: such a row cannot be written in the old shape and is deleted first.

-- catalog: column, constraint, index

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.reroute_events) THEN
    RAISE EXCEPTION '0124-reroute-route-via: reroute_events holds rows that name no route; none is guessed, delete or backfill them first';
  END IF;
END $$;

ALTER TABLE public.reroute_events
  DROP CONSTRAINT reroute_events_distinct_corridors,
  ADD COLUMN route_via text NOT NULL,
  ADD COLUMN source_id uuid,
  ALTER COLUMN fuel_burn_multiplier DROP NOT NULL,
  ADD CONSTRAINT reroute_events_route_via_check CHECK (route_via IN ('suez', 'cape_of_good_hope', 'panama', 'cape_horn', 'arctic', 'overland')),
  ADD CONSTRAINT reroute_events_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX reroute_events_route_key ON public.reroute_events (baseline_corridor_id, route_via, effective_from);
CREATE INDEX reroute_events_source_id_idx ON public.reroute_events (source_id);

COMMENT ON TABLE public.reroute_events IS 'A corridor sailed another way for a period (spec 09 section 1.7; ARM-2 migration 0124). baseline_corridor_id and reroute_corridor_id are corridor entities and may be the SAME one: corridor identity is ORIGIN-DEST:mode, so route_via says which way (suez, cape_of_good_hope, ...). The row key is (baseline_corridor_id, route_via, effective_from). fuel_burn_multiplier is NULL until derived from transit_delta_days or distance_delta_nm (derived_values); it is never typed from an advisory. source_id is the registered advisory page.';
COMMENT ON COLUMN public.reroute_events.reroute_corridor_id IS 'entities(entity_id), kind expected = corridor. Equal to baseline_corridor_id when the same port pair is sailed another way (route_via).';

-- Self-check 0124-reroute-route-via: shape, and attacks: a same-corridor Suez and Cape pair inserts; a second row with the same key, a route outside the vocabulary, a zero multiplier and a missing route are refused; a row without a multiplier or a source inserts.
DO $$
DECLARE
  v_a text := 'cl:corridor:selfcheck0124a';
  v_b text := 'cl:corridor:selfcheck0124b';
BEGIN
  IF (SELECT string_agg(column_name || ':' || is_nullable, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reroute_events' AND column_name IN ('route_via', 'source_id', 'fuel_burn_multiplier')) <> 'fuel_burn_multiplier:YES,route_via:NO,source_id:YES' THEN
    RAISE EXCEPTION '0124-reroute-route-via: unexpected column nullability';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reroute_events_distinct_corridors') THEN
    RAISE EXCEPTION '0124-reroute-route-via: the distinct-corridors constraint is still there';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'reroute_events_route_key' AND indexdef LIKE 'CREATE UNIQUE INDEX%(baseline_corridor_id, route_via, effective_from)') THEN
    RAISE EXCEPTION '0124-reroute-route-via: the row key is not the unique index on (baseline_corridor_id, route_via, effective_from)';
  END IF;
  BEGIN
    INSERT INTO public.entities (entity_id, kind, canonical_name) VALUES (v_a, 'corridor', 'SELFCHECK-0124-A:ocean'), (v_b, 'corridor', 'SELFCHECK-0124-B:ocean');
    INSERT INTO public.reroute_events (baseline_corridor_id, reroute_corridor_id, route_via, cause, effective_from) VALUES (v_a, v_a, 'suez', 'a stated cause', '2026-01-01');
    INSERT INTO public.reroute_events (baseline_corridor_id, reroute_corridor_id, route_via, cause, effective_from, transit_delta_days, fuel_burn_multiplier) VALUES (v_a, v_a, 'cape_of_good_hope', 'a stated cause', '2026-01-01', 10, 1.4);
    BEGIN
      INSERT INTO public.reroute_events (baseline_corridor_id, reroute_corridor_id, route_via, cause, effective_from) VALUES (v_a, v_b, 'suez', 'the same key again', '2026-01-01');
      RAISE EXCEPTION '0124-reroute-route-via: a second row with the same (baseline, route, date) key was accepted';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.reroute_events (baseline_corridor_id, reroute_corridor_id, route_via, cause, effective_from) VALUES (v_b, v_b, 'sea', 'a route outside the vocabulary', '2026-01-01');
      RAISE EXCEPTION '0124-reroute-route-via: a route outside the vocabulary was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.reroute_events (baseline_corridor_id, reroute_corridor_id, route_via, cause, effective_from, fuel_burn_multiplier) VALUES (v_b, v_b, 'suez', 'a zero multiplier', '2026-01-01', 0);
      RAISE EXCEPTION '0124-reroute-route-via: a zero multiplier was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.reroute_events (baseline_corridor_id, reroute_corridor_id, cause, effective_from) VALUES (v_b, v_b, 'no route named', '2026-01-01');
      RAISE EXCEPTION '0124-reroute-route-via: a row naming no route was accepted';
    EXCEPTION WHEN not_null_violation THEN NULL;
    END;
    IF (SELECT count(*) FROM public.reroute_events WHERE baseline_corridor_id = v_a AND fuel_burn_multiplier IS NULL AND source_id IS NULL) <> 1 THEN
      RAISE EXCEPTION '0124-reroute-route-via: a row without a multiplier and a source did not insert as one row';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0124-reroute-route-via OK';
END $$;

COMMIT;
