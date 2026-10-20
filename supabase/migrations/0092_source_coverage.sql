-- 0092 source_coverage: items per source, the coverage invariant as a view (R2d addendum A, operator ruling 2026-10-20: "items per source is at least 1 for every source once collected; fewer items than sources
-- means uncollected, and the system must say so").
--
-- One row per public registry source (not admin-only, not suspended): its admissible items (verified, not archived, not replaced: item_is_admissible, the SQL twin of src/core/derived/admissible.ts), the
-- newest of them, the newest capture on record, and a state read from the registry columns R2c added (0080 sources.collection_state):
--   collected         at least one admissible item (the invariant is about items: a capture with no item is not collected)
--   access_requested  no item, and the ladder ended in a request to the publisher (collection_state access_requested)
--   refused           no item, and the publisher or its wall refused the ladder (collection_state refused or robots_disallowed)
--   uncollected       no item and no refusal on record (unattempted, served with nothing minted yet, or deferred: tried again later, never denied)
-- last_capture_at is the newest of the change-detection captures (raw_fetches) and the capture worker's (agent_run_searches rows of 'capture-worker:first-fetch', through agent_runs.source_id).
-- A definer view: raw_fetches and agent_runs are service-role only, and a member may learn WHEN a source was last captured and nothing else about the capture.
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
       greatest(c.last_capture_at, w.last_capture_at) AS last_capture_at,
       CASE
         WHEN coalesce(i.items_count, 0) >= 1 THEN 'collected'
         WHEN s.collection_state = 'access_requested' THEN 'access_requested'
         WHEN s.collection_state IN ('refused', 'robots_disallowed') THEN 'refused'
         ELSE 'uncollected'
       END AS state
  FROM public.sources s
  LEFT JOIN (SELECT source_id, count(*) AS items_count, max(created_at) AS last_item_at FROM public.intelligence_items
              WHERE public.item_is_admissible(provenance_status, is_archived, replaced_by) GROUP BY source_id) i ON i.source_id = s.id
  LEFT JOIN (SELECT source_id, max(fetched_at) AS last_capture_at FROM public.raw_fetches GROUP BY source_id) c ON c.source_id = s.id
  LEFT JOIN (SELECT r.source_id, max(a.searched_at) AS last_capture_at FROM public.agent_run_searches a JOIN public.agent_runs r ON r.id = a.agent_run_id
              WHERE a.search_query = 'capture-worker:first-fetch' AND r.source_id IS NOT NULL GROUP BY r.source_id) w ON w.source_id = s.id
 WHERE s.admin_only = false AND s.status <> 'suspended';
COMMENT ON VIEW public.source_coverage IS 'Items per public source and whether it is collected (R2d migration 0092): source_id, items_count of admissible items, last_item_at, last_capture_at, state (collected, uncollected, refused, access_requested). A definer view by design: raw_fetches and agent_runs are service-role only.';
REVOKE ALL ON TABLE public.source_coverage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.source_coverage TO authenticated, service_role;

-- Self-check 0092-source-coverage: a source with a verified item is collected with that count and date (even one the ladder once refused); a source whose only items are archived or replaced, refused by
-- the ladder, is refused (robots_disallowed too); a source whose ladder ended in a request to the publisher is access_requested; a source with a raw capture and no verified item is uncollected and shows the
-- capture time; one with only a capture-worker row shows that time; a deferred or unattempted source is uncollected; an admin-only source and a suspended one are absent; anon holds no grant.
DO $$
DECLARE
  tag text := 'selfcheck-0092'; s_ok uuid := gen_random_uuid(); s_ref uuid := gen_random_uuid(); s_rob uuid := gen_random_uuid(); s_req uuid := gen_random_uuid(); s_cap uuid := gen_random_uuid(); s_wrk uuid := gen_random_uuid();
  s_def uuid := gen_random_uuid(); s_adm uuid := gen_random_uuid(); s_sus uuid := gen_random_uuid(); live uuid; run uuid; r record; n int;
BEGIN
  BEGIN
    -- The fixture writes items straight to 'verified', which only the validation derivation may do; the user triggers are off for the fixture and the whole block rolls back.
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.sources (id, name, url, tier, base_tier, tier_at_creation, admin_only, status) VALUES
      (s_ok, tag || ' ok', 'https://selfcheck.invalid/0092/ok', 3, 3, 3, false, 'active'),
      (s_ref, tag || ' refused', 'https://selfcheck.invalid/0092/ref', 3, 3, 3, false, 'active'),
      (s_rob, tag || ' robots', 'https://selfcheck.invalid/0092/rob', 3, 3, 3, false, 'active'),
      (s_req, tag || ' requested', 'https://selfcheck.invalid/0092/req', 3, 3, 3, false, 'active'),
      (s_cap, tag || ' captured', 'https://selfcheck.invalid/0092/cap', 3, 3, 3, false, 'active'),
      (s_wrk, tag || ' worker', 'https://selfcheck.invalid/0092/wrk', 3, 3, 3, false, 'active'),
      (s_def, tag || ' deferred', 'https://selfcheck.invalid/0092/def', 3, 3, 3, false, 'active'),
      (s_adm, tag || ' admin', 'https://selfcheck.invalid/0092/adm', 3, 3, 3, true, 'active'),
      (s_sus, tag || ' suspended', 'https://selfcheck.invalid/0092/sus', 3, 3, 3, false, 'suspended');
    UPDATE public.sources SET collection_state = 'refused' WHERE id IN (s_ok, s_ref);
    UPDATE public.sources SET collection_state = 'robots_disallowed' WHERE id = s_rob;
    UPDATE public.sources SET collection_state = 'access_requested', access_requested_at = now() WHERE id = s_req;
    UPDATE public.sources SET collection_state = 'deferred' WHERE id = s_def;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, source_id) VALUES (tag || ' live', 1, 'verified', false, s_ok) RETURNING id INTO live;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, source_id) VALUES (tag || ' archived', 1, 'verified', true, s_ref);
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, source_id, replaced_by) VALUES (tag || ' replaced', 1, 'verified', false, s_ref, live);
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived, source_id) VALUES (tag || ' unverified', 1, 'unverified', false, s_cap);
    INSERT INTO public.raw_fetches (source_id, content_hash, file_path, http_status) VALUES (s_cap, 'selfcheck-0092', 'selfcheck/0092.gz', 200);
    INSERT INTO public.agent_runs (source_id, source_url, fetch_method, status) VALUES (s_wrk, 'https://selfcheck.invalid/0092/wrk', 'capture-worker', 'success') RETURNING id INTO run;
    INSERT INTO public.agent_run_searches (agent_run_id, search_query, result_url, searched_at) VALUES (run, 'capture-worker:first-fetch', 'https://selfcheck.invalid/0092/wrk', now());
    SELECT * INTO r FROM public.source_coverage WHERE source_id = s_ok;
    IF r.state <> 'collected' OR r.items_count <> 1 OR r.last_item_at IS NULL THEN RAISE EXCEPTION '0092-source-coverage: the source with a verified item is %, % items', r.state, r.items_count; END IF;
    SELECT * INTO r FROM public.source_coverage WHERE source_id = s_ref;
    IF r.state <> 'refused' OR r.items_count <> 0 THEN RAISE EXCEPTION '0092-source-coverage: the refused source is %, % items (an archived and a replaced item must not count)', r.state, r.items_count; END IF;
    SELECT * INTO r FROM public.source_coverage WHERE source_id = s_rob;
    IF r.state <> 'refused' THEN RAISE EXCEPTION '0092-source-coverage: the robots-disallowed source is %', r.state; END IF;
    SELECT * INTO r FROM public.source_coverage WHERE source_id = s_req;
    IF r.state <> 'access_requested' THEN RAISE EXCEPTION '0092-source-coverage: the source whose access was requested is %', r.state; END IF;
    SELECT * INTO r FROM public.source_coverage WHERE source_id = s_cap;
    IF r.state <> 'uncollected' OR r.items_count <> 0 OR r.last_capture_at IS NULL THEN RAISE EXCEPTION '0092-source-coverage: the captured source with no verified item is %, % items, capture %', r.state, r.items_count, r.last_capture_at; END IF;
    SELECT * INTO r FROM public.source_coverage WHERE source_id = s_wrk;
    IF r.state <> 'uncollected' OR r.last_capture_at IS NULL THEN RAISE EXCEPTION '0092-source-coverage: the worker-captured source is %, capture %', r.state, r.last_capture_at; END IF;
    SELECT * INTO r FROM public.source_coverage WHERE source_id = s_def;
    IF r.state <> 'uncollected' THEN RAISE EXCEPTION '0092-source-coverage: the deferred source is % (deferred is tried again later, never denied)', r.state; END IF;
    SELECT count(*) INTO n FROM public.source_coverage WHERE source_id IN (s_adm, s_sus);
    IF n <> 0 THEN RAISE EXCEPTION '0092-source-coverage: an admin-only or suspended source is listed'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_table_privilege('anon', 'public.source_coverage', 'SELECT') OR NOT has_table_privilege('authenticated', 'public.source_coverage', 'SELECT') THEN RAISE EXCEPTION '0092-source-coverage: the grants are wrong'; END IF;
  RAISE NOTICE '0092-source-coverage OK';
END $$;

COMMIT;
