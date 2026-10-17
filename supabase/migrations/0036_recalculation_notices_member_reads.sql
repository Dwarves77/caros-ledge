-- 0036 recalculation notices on a member's own client (P2-11, owed by P2-02c: "where a needed read has no member policy, that is a schema gap").
--
-- /api/notices and the notices rail read the recalculated figures a team tracks: the current derived value, the value it superseded, and the event that staled it. Under the old tree the route used the
-- service role; a member page needs none (P2-02c), and the parity job runs a member's site WITHOUT a service key on purpose. So the reads are granted where the data lives:
--   * derived_values_read_member: a derived value is corpus-level (computed from the published corpus: a market series, an emission factor), so any authenticated member may read the rows; anon holds the table
--     grant but no policy, so anon reads nothing.
--   * recalculation_events: the events behind those values as a view that exposes the event, the table, the row key, the kind and the instant only, for the two corpus tables a derived value is computed from.
--     propagation_events itself stays service-role: its new_row column carries whole rows. A definer view (the owner reads the table), so a member learns WHICH input changed and nothing else.
-- derivation_edges keeps no customer reader (its comment says so): lineage stays a service-side check.
-- Not applied to production before the cutover window.
--
-- Reversal: DROP VIEW public.recalculation_events; DROP POLICY derived_values_read_member ON public.derived_values; REVOKE SELECT ON TABLE public.derived_values FROM authenticated.

-- catalog: policy, relation, column, acl

BEGIN;

GRANT SELECT ON TABLE public.derived_values TO authenticated;
CREATE POLICY derived_values_read_member ON public.derived_values FOR SELECT TO authenticated USING (true);

CREATE VIEW public.recalculation_events AS
SELECT e.event_id, e.table_name, e.row_pk, e.change_kind, e.occurred_at
  FROM public.propagation_events e
 WHERE e.table_name IN ('market_series', 'emission_factors');
COMMENT ON VIEW public.recalculation_events IS 'The events behind a recalculation notice (P2-11 migration 0036): which corpus input changed, how and when; never the row itself. A definer view by design.';
REVOKE ALL ON TABLE public.recalculation_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.recalculation_events TO authenticated, service_role;

-- Self-check 0036-recalculation-notices: as an authenticated member the derived values and the corpus events answer; the event of a non-corpus table answers nothing and the view has no column that
-- carries a row; anon is refused both.
DO $$
DECLARE uid uuid := gen_random_uuid(); n int; anon_n int;
BEGIN
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id, email) VALUES (uid, 'selfcheck-0036@invalid.example');
    INSERT INTO public.derived_values (method_id, method_version, value, unit, derivation, origin_class, lifecycle, admissibility, base_confidence, asserted_at, inputs, computed_at, computed_by)
      VALUES ('selfcheck_0036', '1.0.0', 1, 'x', 'calculated', 'derived', 'verified', 'calculation_ok', 0.5, now(), '[]'::jsonb, now(), 'selfcheck-0036');
    INSERT INTO public.propagation_events (occurred_at, table_name, row_pk, change_kind, new_row) VALUES (now(), 'market_series', 'selfcheck-0036-a', 'insert', '{"secret":"x"}'::jsonb), (now(), 'org_notes', 'selfcheck-0036-b', 'insert', '{"secret":"y"}'::jsonb);
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', uid::text, true);
    SELECT count(*) INTO n FROM public.derived_values WHERE method_id = 'selfcheck_0036';
    IF n <> 1 THEN RESET ROLE; RAISE EXCEPTION '0036-recalculation-notices: a member read % derived values, expected 1', n; END IF;
    SELECT count(*) INTO n FROM public.recalculation_events WHERE row_pk LIKE 'selfcheck-0036-%';
    IF n <> 1 THEN RESET ROLE; RAISE EXCEPTION '0036-recalculation-notices: a member read % events, expected 1 (the corpus table only)', n; END IF;
    RESET ROLE;
    SET LOCAL ROLE anon;
    BEGIN
      SELECT count(*) INTO anon_n FROM public.derived_values WHERE method_id = 'selfcheck_0036';
    EXCEPTION WHEN insufficient_privilege THEN anon_n := 0;
    END;
    IF anon_n <> 0 THEN RESET ROLE; RAISE EXCEPTION '0036-recalculation-notices: anon read % derived values', anon_n; END IF;
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'recalculation_events' AND column_name IN ('new_row', 'old_row', 'entity_id', 'drained_at')) THEN
      RAISE EXCEPTION '0036-recalculation-notices: the events view exposes a row or an internal column';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_table_privilege('anon', 'public.recalculation_events', 'SELECT') THEN
    RAISE EXCEPTION '0036-recalculation-notices: anon holds SELECT on the events view';
  END IF;
  RAISE NOTICE '0036-recalculation-notices OK';
END $$;

COMMIT;
