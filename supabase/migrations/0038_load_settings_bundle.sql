-- 0038 settings bundle (P2-S4, IMP-066; accepted by the operator, WHY section 7).
--
-- The /settings page read its archive and supersession history with four requests: the workspace's archived items, the reader's personal archive, the replacements of every archived item (one request per
-- chunk of ids) and the most recent supersessions. load_settings_bundle(p_org_id, p_user_id, p_limit) answers all four in one call, SECURITY INVOKER so the caller's own RLS decides every row (the override policy of
-- their org, their own user_item_state rows, the visible items): a reader sees exactly what the four reads showed them and nothing wider. Returns jsonb:
--   overrides      the org's archived items, newest archive first (item_id, archive_reason, archive_note, archived_at, item {id, legacy_id, title, item_type, domain}), at most p_limit
--   personal       the caller's own archived items, same shape without a reason
--   supersessions  the most recent supersessions with both sides (id, supersession_date, severity, note, old, new), at most p_limit
--   history        for each archived item above, the replacement the item has (old_item_id, new): the latest supersession whose new side the reader can open
--   truncated      {overrides, personal, supersessions}: true when the bound cut rows off (the page says "showing the most recent")
-- p_user_id names whose personal archive is read (auth.uid() is not callable by the invoker role in the CI stubs; the own-rows policy of user_item_state makes another id read nothing). p_limit is clamped to 1..1000 (the page asks 200, the caps the reads had). A NULL p_org_id returns no team rows. A row whose item the reader cannot open is left out, as the embedded read left it out.
-- Not applied to production before the cutover window; until then the page renders each section as a failed block with Retry.
--
-- Reversal: DROP FUNCTION public.load_settings_bundle(uuid, uuid, int).

-- catalog: function

BEGIN;

CREATE FUNCTION public.load_settings_bundle(p_org_id uuid, p_user_id uuid, p_limit int DEFAULT 200) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp
  AS $$
  WITH n AS (SELECT greatest(1, least(coalesce(p_limit, 200), 1000)) AS v),
  ov AS (
    SELECT row_number() OVER (ORDER BY archived_at DESC NULLS FIRST, item_id) AS rn, * FROM (
      SELECT o.item_id, o.archive_reason, o.archive_note, o.archived_at,
             jsonb_build_object('id', i.id, 'legacy_id', i.legacy_id, 'title', i.title, 'item_type', i.item_type, 'domain', i.domain) AS item
        FROM public.workspace_item_overrides o JOIN public.intelligence_items i ON i.id = o.item_id
       WHERE o.org_id = p_org_id AND o.is_archived
       ORDER BY o.archived_at DESC NULLS FIRST, o.item_id LIMIT (SELECT v + 1 FROM n)) s),
  pe AS (
    SELECT row_number() OVER (ORDER BY archived_at DESC NULLS FIRST, item_id) AS rn, * FROM (
      SELECT u.item_id, u.archive_note, u.archived_at,
             jsonb_build_object('id', i.id, 'legacy_id', i.legacy_id, 'title', i.title, 'item_type', i.item_type, 'domain', i.domain) AS item
        FROM public.user_item_state u JOIN public.intelligence_items i ON i.id = u.item_id
       WHERE u.user_id = p_user_id AND u.is_archived
       ORDER BY u.archived_at DESC NULLS FIRST, u.item_id LIMIT (SELECT v + 1 FROM n)) s),
  su AS (
    SELECT row_number() OVER (ORDER BY supersession_date DESC, id) AS rn, * FROM (
      SELECT s.id, s.supersession_date, s.severity, s.note,
             jsonb_build_object('id', a.id, 'legacy_id', a.legacy_id, 'title', a.title, 'item_type', a.item_type, 'domain', a.domain) AS old,
             jsonb_build_object('id', b.id, 'legacy_id', b.legacy_id, 'title', b.title, 'item_type', b.item_type, 'domain', b.domain) AS new
        FROM public.item_supersessions s JOIN public.intelligence_items a ON a.id = s.old_item_id JOIN public.intelligence_items b ON b.id = s.new_item_id
       ORDER BY s.supersession_date DESC, s.id LIMIT (SELECT v + 1 FROM n)) s),
  hi AS (
    SELECT DISTINCT ON (s.old_item_id) s.old_item_id,
           jsonb_build_object('id', b.id, 'legacy_id', b.legacy_id, 'title', b.title, 'item_type', b.item_type, 'domain', b.domain) AS new
      FROM public.item_supersessions s JOIN public.intelligence_items b ON b.id = s.new_item_id
     WHERE s.old_item_id IN (SELECT item_id FROM ov WHERE rn <= (SELECT v FROM n) UNION SELECT item_id FROM pe WHERE rn <= (SELECT v FROM n))
     ORDER BY s.old_item_id, s.supersession_date DESC, s.id)
  SELECT jsonb_build_object(
    'overrides', coalesce((SELECT jsonb_agg(to_jsonb(ov) - 'rn' ORDER BY rn) FROM ov WHERE rn <= (SELECT v FROM n)), '[]'::jsonb),
    'personal', coalesce((SELECT jsonb_agg(to_jsonb(pe) - 'rn' ORDER BY rn) FROM pe WHERE rn <= (SELECT v FROM n)), '[]'::jsonb),
    'supersessions', coalesce((SELECT jsonb_agg(to_jsonb(su) - 'rn' ORDER BY rn) FROM su WHERE rn <= (SELECT v FROM n)), '[]'::jsonb),
    'history', coalesce((SELECT jsonb_agg(to_jsonb(hi)) FROM hi), '[]'::jsonb),
    'truncated', jsonb_build_object(
      'overrides', EXISTS (SELECT 1 FROM ov WHERE rn > (SELECT v FROM n)),
      'personal', EXISTS (SELECT 1 FROM pe WHERE rn > (SELECT v FROM n)),
      'supersessions', EXISTS (SELECT 1 FROM su WHERE rn > (SELECT v FROM n))));
$$;
REVOKE ALL ON FUNCTION public.load_settings_bundle(uuid, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.load_settings_bundle(uuid, uuid, int) TO authenticated, service_role;

-- Self-check 0038-settings-bundle, in a fixture that rolls back: as an org member the bundle carries the org's archived items newest first, the member's own personal archive (never another user's), the supersessions with
-- both sides, and the replacement of an archived item; a bound of 1 cuts the list and says so; an item the reader cannot open (unverified) leaves its row out, and an item that is NOT archived (a team override with is_archived false, a personal row with is_archived false) is never listed; THE ATTACK: a stranger of another org reads none of the org's
-- archived rows and none of the member's personal ones, and an unknown org id returns none; anon cannot execute the function.
DO $$
DECLARE
  org uuid := gen_random_uuid(); um uuid := gen_random_uuid(); uo uuid := gen_random_uuid(); ux uuid := gen_random_uuid(); a uuid; b uuid; c uuid; hidden uuid; r jsonb;
BEGIN
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO auth.users (id, email) VALUES (um, 'm-0038@invalid.example'), (uo, 'o-0038@invalid.example'), (ux, 'x-0038@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (um, 'm-0038@invalid.example'), (uo, 'o-0038@invalid.example'), (ux, 'x-0038@invalid.example');
    INSERT INTO public.organizations (id, name, slug) VALUES (org, 'selfcheck-0038', 'selfcheck-0038-' || org);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, um, 'member'), (org, uo, 'member');
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0038 a', 1, 'verified', false) RETURNING id INTO a;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0038 b', 1, 'verified', false) RETURNING id INTO b;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0038 c', 1, 'verified', false) RETURNING id INTO c;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0038 hidden', 1, 'quarantined', false) RETURNING id INTO hidden;
    INSERT INTO public.workspace_item_overrides (org_id, item_id, is_archived, archive_reason, archived_at) VALUES (org, a, true, 'superseded', '2026-02-01'), (org, b, true, 'not relevant', '2026-03-01'), (org, hidden, true, 'x', '2026-04-01'), (org, c, false, NULL, NULL);
    INSERT INTO public.user_item_state (user_id, org_id, item_id, is_archived, archive_note, archived_at) VALUES (um, org, c, true, 'mine', '2026-01-01'), (uo, org, b, true, 'theirs', '2026-01-02'), (um, org, a, false, NULL, NULL);
    INSERT INTO public.item_supersessions (old_item_id, new_item_id, supersession_date, severity) VALUES (a, c, '2026-02-15', 'major'), (a, b, '2026-01-15', 'minor');
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    r := public.load_settings_bundle(org, um);
    IF jsonb_array_length(r->'overrides') <> 2 OR (r->'overrides'->0->>'item_id') <> b::text OR (r->'overrides'->1->>'item_id') <> a::text THEN RAISE EXCEPTION '0038-settings-bundle: the team archive is wrong or not newest first (the unverified item must be left out): %', r->'overrides'; END IF;
    IF jsonb_array_length(r->'personal') <> 1 OR (r->'personal'->0->>'item_id') <> c::text OR (r->'personal'->0->>'archive_note') <> 'mine' THEN RAISE EXCEPTION '0038-settings-bundle: the personal archive is wrong: %', r->'personal'; END IF;
    IF jsonb_array_length(r->'supersessions') <> 2 OR (r->'supersessions'->0->'new'->>'id') <> c::text OR (r->'supersessions'->0->'old'->>'title') <> 'selfcheck-0038 a' THEN RAISE EXCEPTION '0038-settings-bundle: the supersessions are wrong: %', r->'supersessions'; END IF;
    IF jsonb_array_length(r->'history') <> 1 OR (r->'history'->0->>'old_item_id') <> a::text OR (r->'history'->0->'new'->>'id') <> c::text THEN RAISE EXCEPTION '0038-settings-bundle: the replacement of the archived item is wrong: %', r->'history'; END IF;
    IF (r->'truncated'->>'overrides') <> 'false' THEN RAISE EXCEPTION '0038-settings-bundle: an uncut list says it is cut'; END IF;
    r := public.load_settings_bundle(org, um, 1);
    IF jsonb_array_length(r->'overrides') <> 1 OR (r->'truncated'->>'overrides') <> 'true' OR (r->'truncated'->>'supersessions') <> 'true' OR (r->'truncated'->>'personal') <> 'false' THEN RAISE EXCEPTION '0038-settings-bundle: a bound of 1 did not cut and say so: %', r->'truncated'; END IF;
    PERFORM set_config('request.jwt.claim.sub', ux::text, true);
    r := public.load_settings_bundle(org, um);
    IF jsonb_array_length(r->'overrides') <> 0 OR jsonb_array_length(r->'personal') <> 0 THEN RAISE EXCEPTION '0038-settings-bundle: a stranger read the org archive or another user''s personal archive: %', r; END IF;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    r := public.load_settings_bundle(gen_random_uuid(), um);
    IF jsonb_array_length(r->'overrides') <> 0 THEN RAISE EXCEPTION '0038-settings-bundle: an unknown org returned rows'; END IF;
    r := public.load_settings_bundle(NULL, um);
    IF jsonb_array_length(r->'overrides') <> 0 THEN RAISE EXCEPTION '0038-settings-bundle: a NULL org returned rows'; END IF;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_function_privilege('anon', 'public.load_settings_bundle(uuid,uuid,int)', 'EXECUTE') THEN RAISE EXCEPTION '0038-settings-bundle: anon can execute it'; END IF;
  RAISE NOTICE '0038-settings-bundle OK';
END $$;

COMMIT;
