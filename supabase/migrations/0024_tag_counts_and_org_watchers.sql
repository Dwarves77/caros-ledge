-- 0024 workspace tag counts and org watchers (P2-S3, owed by IMPROVEMENTS IMP-024).
--
-- Two reads paged whole tables into JavaScript to count or filter. After this migration the database answers them:
--   * workspace_tag_counts (org_id, tag_id, item_count): one row per tag of every workspace with the number of items it is applied to
--     (0 for an unused tag). Replaces the 5,000-row read of item_workspace_tags that the tag list counted client-side (and refused past the
--     cap). security_invoker: the caller's RLS on workspace_tags and item_workspace_tags decides what is visible.
--   * org_watchers(p_org_id, p_item_ids) -> (watcher_ids, on_team_watchlist): the org's members who watch any of the items (by uuid or
--     legacy id text), and whether any is on the team watchlist. Replaces the roster read, the chunked user_watchlist reads and the team read.
--     Scoped by MEMBERSHIP, not by user_watchlist.org_id (nullable, contextual): the item corpus is global, so an item-only filter would reach
--     other tenants' watchers. STABLE, SECURITY INVOKER, reads only.
-- Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.org_watchers(uuid, text[]); DROP VIEW public.workspace_tag_counts.

-- catalog: relation, column, acl, function

BEGIN;

CREATE VIEW public.workspace_tag_counts WITH (security_invoker = on) AS
SELECT t.org_id, t.id AS tag_id, count(l.tag_id)::int AS item_count
  FROM public.workspace_tags t
  LEFT JOIN public.item_workspace_tags l ON l.tag_id = t.id AND l.org_id = t.org_id
 GROUP BY t.org_id, t.id;
COMMENT ON VIEW public.workspace_tag_counts IS 'Items per workspace tag, 0 for an unused tag (P2-S3 migration 0024). security_invoker: RLS of the base tables applies to the reader.';
REVOKE ALL ON TABLE public.workspace_tag_counts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.workspace_tag_counts TO authenticated, service_role;

CREATE FUNCTION public.org_watchers(p_org_id uuid, p_item_ids text[]) RETURNS TABLE(watcher_ids uuid[], on_team_watchlist boolean)
  LANGUAGE sql STABLE SET search_path = public, pg_temp
  AS $$
  SELECT
    coalesce((SELECT array_agg(DISTINCT w.user_id ORDER BY w.user_id)
                FROM public.user_watchlist w
                JOIN public.org_memberships m ON m.user_id = w.user_id AND m.org_id = p_org_id
               WHERE w.item_id = ANY (p_item_ids)), '{}'::uuid[]),
    EXISTS (SELECT 1 FROM public.org_watchlist o WHERE o.org_id = p_org_id AND o.item_id = ANY (p_item_ids));
$$;
REVOKE ALL ON FUNCTION public.org_watchers(uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_watchers(uuid, text[]) TO authenticated, service_role;

-- Self-check 0024-tag-counts-watchers: counts per tag are right (a used tag, an unused tag, a second org's tag not mixed in); the watcher
-- rpc returns only members of the asked org (a watcher in another org is not returned, though they watch the same item), de-duplicated, with
-- the team flag true only for the org that has the item on its team list; an empty item list returns no watchers.
DO $$
DECLARE
  orgA uuid := gen_random_uuid(); orgB uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  tA1 uuid := gen_random_uuid(); tA2 uuid := gen_random_uuid(); tB uuid := gen_random_uuid(); i1 uuid; i2 uuid; w record; n int;
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (ua, 'a-0024@invalid.example'), (ub, 'b-0024@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (ua, 'a-0024@invalid.example'), (ub, 'b-0024@invalid.example');
    INSERT INTO public.organizations (id, name, slug) VALUES (orgA, 'selfcheck-0024-a', 'selfcheck-0024-a-' || orgA), (orgB, 'selfcheck-0024-b', 'selfcheck-0024-b-' || orgB);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (orgA, ua, 'member'), (orgB, ub, 'member');
    INSERT INTO public.intelligence_items (title, domain) VALUES ('selfcheck-0024-1', 1) RETURNING id INTO i1;
    INSERT INTO public.intelligence_items (title, domain) VALUES ('selfcheck-0024-2', 1) RETURNING id INTO i2;
    INSERT INTO public.workspace_tags (id, org_id, name) VALUES (tA1, orgA, 'used'), (tA2, orgA, 'unused'), (tB, orgB, 'other');
    INSERT INTO public.item_workspace_tags (tag_id, intelligence_item_id, org_id) VALUES (tA1, i1, orgA), (tA1, i2, orgA), (tB, i1, orgB);
    IF (SELECT item_count FROM public.workspace_tag_counts WHERE tag_id = tA1) <> 2 THEN RAISE EXCEPTION '0024-tag-counts-watchers: used tag count is wrong'; END IF;
    IF (SELECT item_count FROM public.workspace_tag_counts WHERE tag_id = tA2) <> 0 THEN RAISE EXCEPTION '0024-tag-counts-watchers: unused tag count is not 0'; END IF;
    IF (SELECT item_count FROM public.workspace_tag_counts WHERE tag_id = tB) <> 1 THEN RAISE EXCEPTION '0024-tag-counts-watchers: the other org tag count is wrong'; END IF;
    SELECT count(*) INTO n FROM public.workspace_tag_counts WHERE org_id = orgA;
    IF n <> 2 THEN RAISE EXCEPTION '0024-tag-counts-watchers: org A lists % tags, expected 2', n; END IF;
    INSERT INTO public.user_watchlist (user_id, item_type, item_id) VALUES (ua, 'reg', 'item-x'), (ua, 'reg', 'item-y'), (ub, 'reg', 'item-x');
    INSERT INTO public.org_watchlist (org_id, item_type, item_id) VALUES (orgB, 'reg', 'item-x');
    SELECT * INTO w FROM public.org_watchers(orgA, ARRAY['item-x', 'item-y']);
    IF w.watcher_ids IS DISTINCT FROM ARRAY[ua] OR w.on_team_watchlist THEN RAISE EXCEPTION '0024-tag-counts-watchers: org A watchers wrong: %', w; END IF;
    SELECT * INTO w FROM public.org_watchers(orgB, ARRAY['item-x']);
    IF w.watcher_ids IS DISTINCT FROM ARRAY[ub] OR NOT w.on_team_watchlist THEN RAISE EXCEPTION '0024-tag-counts-watchers: org B watchers wrong: %', w; END IF;
    SELECT * INTO w FROM public.org_watchers(orgA, ARRAY[]::text[]);
    IF cardinality(w.watcher_ids) <> 0 OR w.on_team_watchlist THEN RAISE EXCEPTION '0024-tag-counts-watchers: an empty item list returned watchers'; END IF;
    SELECT * INTO w FROM public.org_watchers(orgA, ARRAY['item-x']);
    IF w.on_team_watchlist THEN RAISE EXCEPTION '0024-tag-counts-watchers: org A saw org B team watchlist'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_table_privilege('anon', 'public.workspace_tag_counts', 'SELECT') OR has_function_privilege('anon', 'public.org_watchers(uuid,text[])', 'EXECUTE') THEN
    RAISE EXCEPTION '0024-tag-counts-watchers: anon holds a privilege';
  END IF;
  RAISE NOTICE '0024-tag-counts-watchers OK';
END $$;

COMMIT;
