-- 0031 member detail reads (P2-10, owed by P2-02c: "where a needed read has no member policy, that is a schema gap").
--
-- A member's detail page reads, on the member's own client, five things no policy let an authenticated member read: the grounded claims of an item (the rating drawn on each fact), the inference
-- records a page may show, the bias tags of a source, the sources an item cites, and which fact claims an admin suppressed. Under the old tree the page used the service role for all five; the parity job
-- runs a member's site WITHOUT a service key on purpose (P2-02c), so the reads are granted where the data lives:
--   * section_claim_provenance_read_member: a claim of an item the reader can open (the items policy decides: verified, not archived).
--   * intelligence_item_citations_read_member: a citation of an item the reader can open.
--   * source_bias_tags_read_member and inference_records_read_member: the tags and the records are product content a customer is shown; the page's own rules narrow what is drawn (the allowlisted
--     method, the current row, the citation gate: src/core/detail/inference-view.ts).
--   * fact_suppressions: the active fact suppressions of items the reader can open, as a view that exposes the target, the operation and the machine text only (never the reason or the admin).
--     item_corrections stays readable by platform admins alone. A definer view (owner reads the table), so a member can learn WHICH claims are suppressed and nothing else; INV-270 needs the page to
--     know, because a suppressed claim must never reach a render and a page that cannot read the suppressions would show it.
--   * census_worklist_read_member: the instruments catalogued to be minted (dryrun_disposition = would_mint), so the coverage line under a list (numerator beside denominator, 'See coverage') reads on the
--     member's client; the old page read it through a cached service-role read. Held rows stay unreadable.
-- Not applied to production before the cutover window.
--
-- Reversal: DROP VIEW public.fact_suppressions; DROP POLICY section_claim_provenance_read_member ON public.section_claim_provenance; DROP POLICY intelligence_item_citations_read_member ON public.intelligence_item_citations;
-- DROP POLICY source_bias_tags_read_member ON public.source_bias_tags; DROP POLICY inference_records_read_member ON public.inference_records; DROP POLICY census_worklist_read_member ON public.census_worklist.

-- catalog: policy, relation, column, acl

BEGIN;

CREATE POLICY section_claim_provenance_read_member ON public.section_claim_provenance FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.intelligence_items i WHERE i.id = section_claim_provenance.intelligence_item_id));
CREATE POLICY intelligence_item_citations_read_member ON public.intelligence_item_citations FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.intelligence_items i WHERE i.id = intelligence_item_citations.intelligence_item_id));
CREATE POLICY source_bias_tags_read_member ON public.source_bias_tags FOR SELECT TO authenticated USING (true);
CREATE POLICY inference_records_read_member ON public.inference_records FOR SELECT TO authenticated USING (true);
CREATE POLICY census_worklist_read_member ON public.census_worklist FOR SELECT TO authenticated USING (dryrun_disposition = 'would_mint');

CREATE VIEW public.fact_suppressions AS
SELECT c.id, c.item_id, c.target_kind, c.target_ref, c.op, c.machine_value, c.created_at, c.revoked_at
  FROM public.item_corrections c
 WHERE c.target_kind = 'fact'
   AND EXISTS (SELECT 1 FROM public.intelligence_items i WHERE i.id = c.item_id AND i.provenance_status = 'verified' AND i.is_archived IS NOT TRUE);
COMMENT ON VIEW public.fact_suppressions IS 'The fact suppressions a reader needs to hide suppressed claims (P2-10 migration 0031): target, operation and machine text of items the reader can open; never the reason or the admin. A definer view by design.';
REVOKE ALL ON TABLE public.fact_suppressions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.fact_suppressions TO authenticated, service_role;

-- Self-check 0031-member-detail-reads: as an authenticated member the claims of a visible item, its citations and the suppression view answer; the claims of an archived item answer nothing; the
-- suppression view shows the target and the machine text but has no column that names the reason or the admin; anon is refused every one of them.
DO $$
DECLARE uid uuid := gen_random_uuid(); sid uuid := gen_random_uuid(); live uuid; gone uuid; n int;
BEGIN
  BEGIN
    -- The fixture writes an item straight to 'verified', which only the validation derivation may do; the user triggers are off for the fixture and the whole block rolls back.
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id, email) VALUES (uid, 'selfcheck-0031@invalid.example');
    INSERT INTO public.sources (id, name, url, tier, base_tier, tier_at_creation) VALUES (sid, 'selfcheck-0031', 'https://selfcheck.invalid/0031', 3, 3, 3);
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0031 live', 1, 'verified', false) RETURNING id INTO live;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0031 archived', 1, 'verified', true) RETURNING id INTO gone;
    INSERT INTO public.section_claim_provenance (intelligence_item_id, claim_text, claim_kind, source_id) VALUES (live, 'live claim', 'ANALYSIS', sid), (gone, 'archived claim', 'ANALYSIS', sid);
    INSERT INTO public.intelligence_item_citations (intelligence_item_id, source_id, origin) VALUES (live, sid, 'manual'), (gone, sid, 'manual');
    INSERT INTO public.item_corrections (item_id, target_kind, target_ref, op, machine_value, reason, created_by) VALUES (live, 'fact', 'c-live', 'suppress', '{"claim_text":"live claim"}'::jsonb, 'selfcheck reason', uid), (gone, 'fact', 'c-gone', 'suppress', '{"claim_text":"archived claim"}'::jsonb, 'selfcheck reason', uid);
    INSERT INTO public.census_worklist (source_id, document_url, title, lane, created_by, dryrun_disposition, hold_reason) VALUES (sid, 'https://selfcheck.invalid/0031/mint', 'selfcheck mint', 'A', 'selfcheck', 'would_mint', NULL), (sid, 'https://selfcheck.invalid/0031/hold', 'selfcheck hold', 'A', 'selfcheck', 'hold', 'selfcheck');
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', uid::text, true);
    SELECT count(*) INTO n FROM public.section_claim_provenance WHERE intelligence_item_id IN (live, gone);
    IF n <> 1 THEN RESET ROLE; RAISE EXCEPTION '0031-member-detail-reads: a member read % claims, expected 1 (the visible item only)', n; END IF;
    SELECT count(*) INTO n FROM public.intelligence_item_citations WHERE intelligence_item_id IN (live, gone);
    IF n <> 1 THEN RESET ROLE; RAISE EXCEPTION '0031-member-detail-reads: a member read % citations, expected 1', n; END IF;
    SELECT count(*) INTO n FROM public.fact_suppressions WHERE item_id IN (live, gone);
    IF n <> 1 THEN RESET ROLE; RAISE EXCEPTION '0031-member-detail-reads: a member read % suppressions, expected 1', n; END IF;
    SELECT count(*) INTO n FROM public.census_worklist WHERE document_url LIKE 'https://selfcheck.invalid/0031/%';
    IF n <> 1 THEN RESET ROLE; RAISE EXCEPTION '0031-member-detail-reads: a member read % census rows, expected 1 (the would_mint row only)', n; END IF;
    SELECT count(*) INTO n FROM public.item_corrections WHERE item_id IN (live, gone);
    IF n <> 0 THEN RESET ROLE; RAISE EXCEPTION '0031-member-detail-reads: a non-admin read % item_corrections rows directly', n; END IF;
    RESET ROLE;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fact_suppressions' AND column_name IN ('reason', 'created_by', 'revoked_by', 'revoked_reason', 'value')) THEN
      RAISE EXCEPTION '0031-member-detail-reads: the suppression view exposes the reason or the admin';
    END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_table_privilege('anon', 'public.fact_suppressions', 'SELECT') OR has_table_privilege('anon', 'public.section_claim_provenance', 'SELECT') OR has_table_privilege('anon', 'public.inference_records', 'SELECT') OR has_table_privilege('anon', 'public.census_worklist', 'INSERT') OR has_table_privilege('anon', 'public.source_bias_tags', 'SELECT') OR has_table_privilege('anon', 'public.intelligence_item_citations', 'SELECT') THEN
    RAISE EXCEPTION '0031-member-detail-reads: anon holds SELECT on a member-only relation';
  END IF;
  RAISE NOTICE '0031-member-detail-reads OK';
END $$;

COMMIT;
