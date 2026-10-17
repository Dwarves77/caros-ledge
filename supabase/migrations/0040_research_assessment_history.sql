-- 0040 research history for a member (P2-S4, IMP-079; WHY section 7; P2-12's note: the chain showed "history incomplete" without a service key).
--
-- The raw table research_assessments is closed to a signed-in client (RLS on, no policy), and the page that walks an assessment's supersedes chain needed the service client to read it. The chain is now read
-- through a view, so the member page reads under its own client (the P2-02c rule):
--   * research_assessment_history: every column the page reads, for the rows of every chain whose CURRENT head a member may read. A definer view (owner postgres, no security_invoker): the member learns the
--     history of the assessments they can already see, never a row of a chain whose head they cannot, and the raw table stays refused.
--   * research_assessments_current is made the same kind of view, on purpose. Its definition said "the ONE view Research's read path selects from ... runs with the DEFINER's row-visibility, NOT the querying
--     role's" but it was created security_invoker over a table with no policy, so a signed-in member read ZERO rows from it [CONFIRMED on a fresh schema.sql: 0 rows as `authenticated`]. As a definer view with the
--     reader's rule written out it returns the current assessments of the items a member may open (verified, not archived: the intelligence_items_read policy); a service-role caller still reads every current row (the
--     producer and the signpost scoring read items that are not verified yet), by the same (select auth.role()) = 'service_role' test the policies use. Columns are unchanged.
-- Not applied to production before the cutover window; until then the page keeps its "history incomplete" note (the view is absent and the chain read says so).
--
-- Reversal: DROP VIEW public.research_assessment_history; CREATE OR REPLACE VIEW public.research_assessments_current WITH (security_invoker = on) AS (the same select with WHERE ra.is_current only).

-- catalog: relation, column, acl

BEGIN;

CREATE OR REPLACE VIEW public.research_assessments_current WITH (security_invoker = off) AS
SELECT ra.id, ra.item_id, ra.supersedes, ra.is_current, ra.technical_maturity_low, ra.technical_maturity_high, ra.technical_maturity_method, ra.technical_maturity_evidence_ids, ra.commercial_maturity_low,
       ra.commercial_maturity_high, ra.commercial_maturity_method, ra.commercial_maturity_evidence_ids, ra.horizon_kind, ra.horizon_band, ra.horizon_rule, ra.horizon_confidence, ra.horizon_trigger_note,
       ra.refusal_reason, ra.credibility_evidence_score, ra.credibility_authority_score, ra.computed_by, ra.computed_at, ra.status_token, ra.created_at, ra.entity_id, ra.lifecycle_state
  FROM public.research_assessments ra
 WHERE ra.is_current
   AND (((SELECT auth.role()) = 'service_role')
        OR EXISTS (SELECT 1 FROM public.intelligence_items i WHERE i.id = ra.item_id AND i.provenance_status = 'verified' AND i.is_archived IS NOT TRUE));
COMMENT ON VIEW public.research_assessments_current IS 'The ONE view Research''s read path selects from. A definer view (P2-S4 migration 0040): a signed-in reader gets the current assessments of the items they may open (verified, not archived); the service role gets every current row. The raw table stays closed.';

CREATE VIEW public.research_assessment_history AS
SELECT ra.id, ra.item_id, ra.supersedes, ra.is_current, ra.technical_maturity_low, ra.technical_maturity_high, ra.technical_maturity_method, ra.technical_maturity_evidence_ids, ra.commercial_maturity_low,
       ra.commercial_maturity_high, ra.commercial_maturity_method, ra.commercial_maturity_evidence_ids, ra.horizon_kind, ra.horizon_band, ra.horizon_rule, ra.horizon_confidence, ra.horizon_trigger_note,
       ra.refusal_reason, ra.credibility_evidence_score, ra.credibility_authority_score, ra.computed_by, ra.computed_at, ra.status_token, ra.created_at, ra.entity_id, ra.lifecycle_state
  FROM public.research_assessments ra
 WHERE EXISTS (SELECT 1 FROM public.research_assessments_current head WHERE head.item_id = ra.item_id);
COMMENT ON VIEW public.research_assessment_history IS 'Every assessment of an item whose current head the reader may read (P2-S4 migration 0040): the supersedes chain behind a research detail page. A definer view by design; the raw table stays closed.';
REVOKE ALL ON TABLE public.research_assessment_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.research_assessment_history TO authenticated, service_role;

-- Self-check 0040-research-history, in a fixture that rolls back: as an authenticated member the current view answers the current assessment of a visible item and nothing of an archived item's; the history view
-- answers both rows of the visible item's chain (superseded and current) and no row of the archived item's chain nor of an item with no current head; THE ATTACK: the member reading research_assessments directly
-- reads zero rows (still closed) and cannot insert; as the service role the current view still answers every current row; anon holds neither view.
DO $$
DECLARE
  uid uuid := gen_random_uuid(); v uuid; h uuid; nohead uuid; a1 uuid := gen_random_uuid(); a2 uuid := gen_random_uuid(); h1 uuid := gen_random_uuid(); h2 uuid := gen_random_uuid(); n1 uuid := gen_random_uuid(); n int;
BEGIN
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id, email) VALUES (uid, 'selfcheck-0040@invalid.example');
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0040 visible', 1, 'verified', false) RETURNING id INTO v;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0040 archived', 1, 'verified', true) RETURNING id INTO h;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0040 no head', 1, 'verified', false) RETURNING id INTO nohead;
    INSERT INTO public.research_assessments (id, item_id, supersedes, is_current, computed_by, status_token, refusal_reason) VALUES
      (a1, v, NULL, false, 'selfcheck', 'HYPOTHESIS', 'r'), (a2, v, a1, true, 'selfcheck', 'HYPOTHESIS', 'r'),
      (h1, h, NULL, false, 'selfcheck', 'HYPOTHESIS', 'r'), (h2, h, h1, true, 'selfcheck', 'HYPOTHESIS', 'r'),
      (n1, nohead, NULL, false, 'selfcheck', 'HYPOTHESIS', 'r');
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', uid::text, true);
    SELECT count(*) INTO n FROM public.research_assessments_current WHERE item_id IN (v, h, nohead);
    IF n <> 1 THEN RESET ROLE; RAISE EXCEPTION '0040-research-history: a member read % current assessments, expected 1 (the visible item only)', n; END IF;
    SELECT count(*) INTO n FROM public.research_assessment_history WHERE item_id = v;
    IF n <> 2 THEN RESET ROLE; RAISE EXCEPTION '0040-research-history: a member read % rows of the visible chain, expected 2', n; END IF;
    SELECT count(*) INTO n FROM public.research_assessment_history WHERE item_id IN (h, nohead);
    IF n <> 0 THEN RESET ROLE; RAISE EXCEPTION '0040-research-history: a member read % rows of a chain whose head they cannot read', n; END IF;
    SELECT count(*) INTO n FROM public.research_assessments WHERE item_id IN (v, h, nohead);
    IF n <> 0 THEN RESET ROLE; RAISE EXCEPTION '0040-research-history: the raw table answered a member (% rows)', n; END IF;
    BEGIN INSERT INTO public.research_assessments (item_id, computed_by, status_token, refusal_reason) VALUES (v, 'forged', 'HYPOTHESIS', 'r'); RESET ROLE; RAISE EXCEPTION '0040-research-history: a member wrote the raw table';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
    SET LOCAL ROLE service_role;
    PERFORM set_config('request.jwt.claim.role', 'service_role', true);
    SELECT count(*) INTO n FROM public.research_assessments_current WHERE item_id IN (v, h, nohead);
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.role', '', true);
    IF n <> 2 THEN RAISE EXCEPTION '0040-research-history: the service role read % current assessments, expected 2 (every current row)', n; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_table_privilege('anon', 'public.research_assessment_history', 'SELECT') OR has_table_privilege('anon', 'public.research_assessments_current', 'SELECT') THEN RAISE EXCEPTION '0040-research-history: anon holds SELECT on a view'; END IF;
  RAISE NOTICE '0040-research-history OK';
END $$;

COMMIT;
