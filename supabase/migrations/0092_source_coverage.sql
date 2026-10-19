-- 0092 source_coverage: items per source, the coverage invariant as a view (R2d addendum A, operator ruling 2026-10-20: "items per source is at least 1 for every source once collected; fewer items than sources
-- means uncollected, and the system must say so").
--
-- One row per public registry source (not admin-only, not suspended): its admissible items (verified, not archived, not replaced: item_is_admissible, the SQL twin of src/core/derived/admissible.ts), the
-- newest of them, the newest capture on record, and a state:
--   collected    at least one admissible item
--   refused      no item, and the registry or the sitemap walk recorded a refusal (fetch_status blocked or cdn_block, sitemap walk bot_wall)
--   uncollected  no item and no refusal on record (a capture with no item is still uncollected: the invariant is about items)
-- 'access_requested' is a fourth state the page vocabulary carries; the registry column that records it is R2c's (worklist state), and R2c's migration replaces this view's CASE when it adds the column.
-- A definer view: raw_fetches is service-role only and a member may learn WHEN a source was last captured and nothing else about the capture.
-- Reversal: DROP VIEW public.source_coverage; DROP FUNCTION public.item_is_admissible(public.provenance_status, boolean, uuid).
-- Not applied to production before the cutover window.

-- catalog: relation, column, function, acl

BEGIN;

CREATE FUNCTION public.item_is_admissible(p_status public.provenance_status, p_archived boolean, p_replaced_by uuid) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp
  AS $$ SELECT p_status = 'verified' AND p_archived = false AND p_replaced_by IS NULL $$;
COMMENT ON FUNCTION public.item_is_admissible(public.provenance_status, boolean, uuid) IS 'The admissible-item rule in SQL (R2d migration 0092): verified, not archived, not replaced. The TypeScript twin is isAdmissibleItem in src/core/derived/admissible.ts; tests/derived/readers.test.ts pins the two together.';
REVOKE ALL ON FUNCTION public.item_is_admissible(public.provenance_status, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.item_is_admissible(public.provenance_status, boolean, uuid) TO authenticated, service_role;

CREATE VIEW public.source_coverage AS
SELECT s.id AS source_id,
       coalesce(i.items_count, 0)::int AS items_count,
       i.last_item_at,
       c.last_capture_at,
       CASE
         WHEN coalesce(i.items_count, 0) >= 1 THEN 'collected'
         WHEN s.fetch_status IN ('blocked', 'cdn_block') OR s.sitemap_walk_outcome = 'bot_wall' THEN 'refused'
         ELSE 'uncollected'
       END AS state
  FROM public.sources s
  LEFT JOIN (SELECT source_id, count(*) AS items_count, max(created_at) AS last_item_at FROM public.intelligence_items
              WHERE public.item_is_admissible(provenance_status, is_archived, replaced_by) GROUP BY source_id) i ON i.source_id = s.id
  LEFT JOIN (SELECT source_id, max(fetched_at) AS last_capture_at FROM public.raw_fetches GROUP BY source_id) c ON c.source_id = s.id
 WHERE s.admin_only = false AND s.status <> 'suspended';
COMMENT ON VIEW public.source_coverage IS 'Items per public source and whether it is collected (R2d migration 0092): source_id, items_count of admissible items, last_item_at, last_capture_at, state (collected, uncollected, refused). A definer view by design: raw_fetches is service-role only.';
REVOKE ALL ON TABLE public.source_coverage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.source_coverage TO authenticated, service_role;

-- Self-check 0092-source-coverage: a source with a verified item is collected with that count and date; a source whose only items are archived or replaced, with a refusal on record, is refused; a source
-- with a capture and no item is uncollected and shows the capture time; an admin-only source and a suspended one are absent; anon holds no grant.
DO $$
DECLARE
  tag text := 'selfcheck-0092'; s_ok uuid := gen_random_uuid(); s_ref uuid := gen_random_uuid(); s_cap uuid := gen_random_uuid(); s_adm uuid := gen_random_uuid(); s_sus uuid := gen_random_uuid(); live uuid; r record; n int;
BEGIN
  BEGIN
    -- The fixture writes items straight to 'verified', which only the validation derivation may do; the user triggers are off for the fixture and the whole block rolls back.
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.sources (id, name, url, tier, base_tier, tier_at_creation, fetch_status, admin_only, status) VALUES
      (s_ok, tag || ' ok', 'https://selfcheck.invalid/0092/ok', 3, 3, 3, NULL, false, 'active'),
      (s_ref, tag || ' refused', 'https://selfcheck.invalid/0092/ref', 3, 3, 3, 'blocked', false, 'active'),
      (s_cap, tag || ' captured', 'https://selfcheck.invalid/0092/cap', 3, 3, 3, NULL, false, 'active'),
      (s_adm, tag || ' admin', 'https://selfcheck.invalid/0092/adm', 3, 3, 3, NULL, true, 'active'),
      (s_sus, tag || ' suspended', 'https://selfcheck.invalid/0092/sus', 3, 3, 3, NULL, false, 'suspended');
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, source_id) VALUES (tag || ' live', 1, 'verified', false, s_ok) RETURNING id INTO live;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, source_id) VALUES (tag || ' archived', 1, 'verified', true, s_ref);
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, source_id, replaced_by) VALUES (tag || ' replaced', 1, 'verified', false, s_ref, live);
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, source_id) VALUES (tag || ' unverified', 1, 'unverified', false, s_cap);
    INSERT INTO public.raw_fetches (source_id, content_hash, file_path, http_status) VALUES (s_cap, 'selfcheck-0092', 'selfcheck/0092.gz', 200);
    SELECT * INTO r FROM public.source_coverage WHERE source_id = s_ok;
    IF r.state <> 'collected' OR r.items_count <> 1 OR r.last_item_at IS NULL THEN RAISE EXCEPTION '0092-source-coverage: the source with a verified item is %, % items', r.state, r.items_count; END IF;
    SELECT * INTO r FROM public.source_coverage WHERE source_id = s_ref;
    IF r.state <> 'refused' OR r.items_count <> 0 THEN RAISE EXCEPTION '0092-source-coverage: the refused source is %, % items (an archived and a replaced item must not count)', r.state, r.items_count; END IF;
    SELECT * INTO r FROM public.source_coverage WHERE source_id = s_cap;
    IF r.state <> 'uncollected' OR r.items_count <> 0 OR r.last_capture_at IS NULL THEN RAISE EXCEPTION '0092-source-coverage: the captured source with no verified item is %, % items, capture %', r.state, r.items_count, r.last_capture_at; END IF;
    SELECT count(*) INTO n FROM public.source_coverage WHERE source_id IN (s_adm, s_sus);
    IF n <> 0 THEN RAISE EXCEPTION '0092-source-coverage: an admin-only or suspended source is listed'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_table_privilege('anon', 'public.source_coverage', 'SELECT') OR NOT has_table_privilege('authenticated', 'public.source_coverage', 'SELECT') THEN RAISE EXCEPTION '0092-source-coverage: the grants are wrong'; END IF;
  RAISE NOTICE '0092-source-coverage OK';
END $$;

COMMIT;
