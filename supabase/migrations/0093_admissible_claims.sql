-- 0093 admissible_claims: the claims a customer reader may use, as a view (R2d, MASTER I13, register flywheel:21, 27).
--
-- The same rule as src/core/derived/admissible.ts `admissibleRows.claims`: a claim of an admissible item (verified, not archived, not replaced: item_is_admissible, 0092) that no active fact suppression covers.
-- A suppression covers a claim when the newest active correction for the claim's id is a suppress, or, with none for the id, when the newest active correction whose machine text IS the claim's text is a
-- suppress (core/corrections suppressedClaimMatcher: id first, then text; a later replace or a revoked suppression restores the claim). Corrections are read through `fact_suppressions` (0031), the view a member
-- may read, so the view runs with the caller's rights (security_invoker): a member sees the claims the member policy lets them open, minus the suppressed ones.
-- Reversal: DROP VIEW public.admissible_claims.
-- Not applied to production before the cutover window.

-- catalog: relation, column, acl

BEGIN;

CREATE VIEW public.admissible_claims WITH (security_invoker = on) AS
SELECT c.*
  FROM public.section_claim_provenance c
  JOIN public.intelligence_items i ON i.id = c.intelligence_item_id AND public.item_is_admissible(i.provenance_status, i.is_archived, i.replaced_by)
 WHERE NOT coalesce((
   SELECT d.op = 'suppress'
     FROM (SELECT DISTINCT ON (f.target_ref) f.target_ref, f.op, f.machine_value, f.created_at, f.id
             FROM public.fact_suppressions f
            WHERE f.item_id = c.intelligence_item_id AND f.revoked_at IS NULL
            ORDER BY f.target_ref, f.created_at DESC, f.id DESC) d
    WHERE d.target_ref = c.id::text OR d.machine_value ->> 'claim_text' = c.claim_text
    ORDER BY (d.target_ref = c.id::text) DESC, d.created_at DESC, d.id DESC
    LIMIT 1), false);
COMMENT ON VIEW public.admissible_claims IS 'The claims of admissible items that no active fact suppression covers (R2d migration 0093): the SQL twin of admissibleRows.claims in src/core/derived/admissible.ts. security_invoker: the caller RLS applies.';
REVOKE ALL ON TABLE public.admissible_claims FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.admissible_claims TO authenticated, service_role;

-- Self-check 0093-admissible-claims: a claim of a live item is admissible; one of an archived, a replaced and an unverified item is not; a claim suppressed by id is not; one suppressed by its text only is not;
-- a suppression a later replace overrides, and a revoked one, leave the claim in; a suppression of another item's claim by the same text touches nothing; anon holds no grant.
-- fact_suppressions only shows a suppression of a verified, unarchived item, so the fixture's suppressions are on the live item; its other items prove the item rule alone.
DO $$
DECLARE
  tag text := 'selfcheck-0093'; live uuid; gone uuid; moved uuid; raw uuid; other uuid; c_ok uuid; c_id uuid; c_txt uuid; c_back uuid; c_rev uuid; c_other uuid; c_gone uuid; c_moved uuid; c_raw uuid; usr uuid; n int;
BEGIN
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES (tag || ' live', 1, 'verified', false) RETURNING id INTO live;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES (tag || ' other', 1, 'verified', false) RETURNING id INTO other;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES (tag || ' archived', 1, 'verified', true) RETURNING id INTO gone;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, replaced_by) VALUES (tag || ' replaced', 1, 'verified', false, live) RETURNING id INTO moved;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES (tag || ' unverified', 1, 'unverified', false) RETURNING id INTO raw;
    INSERT INTO public.section_claim_provenance (intelligence_item_id, claim_text, claim_kind) VALUES (live, tag || ' stands', 'FACT') RETURNING id INTO c_ok;
    INSERT INTO public.section_claim_provenance (intelligence_item_id, claim_text, claim_kind) VALUES (live, tag || ' by id', 'FACT') RETURNING id INTO c_id;
    INSERT INTO public.section_claim_provenance (intelligence_item_id, claim_text, claim_kind) VALUES (live, tag || ' by text', 'FACT') RETURNING id INTO c_txt;
    INSERT INTO public.section_claim_provenance (intelligence_item_id, claim_text, claim_kind) VALUES (live, tag || ' restored', 'FACT') RETURNING id INTO c_back;
    INSERT INTO public.section_claim_provenance (intelligence_item_id, claim_text, claim_kind) VALUES (live, tag || ' revoked', 'FACT') RETURNING id INTO c_rev;
    INSERT INTO public.section_claim_provenance (intelligence_item_id, claim_text, claim_kind) VALUES (other, tag || ' by text', 'FACT') RETURNING id INTO c_other;
    INSERT INTO public.section_claim_provenance (intelligence_item_id, claim_text, claim_kind) VALUES (gone, tag || ' archived item', 'FACT') RETURNING id INTO c_gone;
    INSERT INTO public.section_claim_provenance (intelligence_item_id, claim_text, claim_kind) VALUES (moved, tag || ' replaced item', 'FACT') RETURNING id INTO c_moved;
    INSERT INTO public.section_claim_provenance (intelligence_item_id, claim_text, claim_kind) VALUES (raw, tag || ' unverified item', 'FACT') RETURNING id INTO c_raw;
    SELECT id INTO usr FROM auth.users LIMIT 1;
    IF usr IS NULL THEN
      INSERT INTO auth.users (id) VALUES (gen_random_uuid()) RETURNING id INTO usr;
    END IF;
    INSERT INTO public.item_corrections (item_id, target_kind, target_ref, op, machine_value, reason, created_by, created_at) VALUES
      (live, 'fact', c_id::text, 'suppress', jsonb_build_object('claim_text', 'something else'), 'selfcheck', usr, now() - interval '5 minutes'),
      (live, 'fact', 'text-ref-1', 'suppress', jsonb_build_object('claim_text', tag || ' by text'), 'selfcheck', usr, now() - interval '5 minutes'),
      (live, 'fact', c_back::text, 'suppress', jsonb_build_object('claim_text', tag || ' restored'), 'selfcheck', usr, now() - interval '5 minutes'),
      (live, 'fact', c_back::text, 'replace', jsonb_build_object('claim_text', tag || ' restored'), 'selfcheck', usr, now() - interval '1 minute');
    INSERT INTO public.item_corrections (item_id, target_kind, target_ref, op, machine_value, reason, created_by, created_at, revoked_at, revoked_by) VALUES
      (live, 'fact', c_rev::text, 'suppress', jsonb_build_object('claim_text', tag || ' revoked'), 'selfcheck', usr, now() - interval '5 minutes', now(), usr);
    SELECT count(*) INTO n FROM public.admissible_claims WHERE id IN (c_ok, c_back, c_rev, c_other);
    IF n <> 4 THEN RAISE EXCEPTION '0093-admissible-claims: % of the 4 standing claims are admissible (a replace and a revocation restore a claim; a suppression on another item touches nothing)', n; END IF;
    IF EXISTS (SELECT 1 FROM public.admissible_claims WHERE id = c_id) THEN RAISE EXCEPTION '0093-admissible-claims: a claim suppressed by id is admissible'; END IF;
    IF EXISTS (SELECT 1 FROM public.admissible_claims WHERE id = c_txt) THEN RAISE EXCEPTION '0093-admissible-claims: a claim suppressed by its text is admissible'; END IF;
    IF EXISTS (SELECT 1 FROM public.admissible_claims WHERE id IN (c_gone, c_moved, c_raw)) THEN RAISE EXCEPTION '0093-admissible-claims: a claim of an archived, replaced or unverified item is admissible'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_table_privilege('anon', 'public.admissible_claims', 'SELECT') OR NOT has_table_privilege('authenticated', 'public.admissible_claims', 'SELECT') THEN RAISE EXCEPTION '0093-admissible-claims: the grants are wrong'; END IF;
  RAISE NOTICE '0093-admissible-claims OK';
END $$;

COMMIT;
