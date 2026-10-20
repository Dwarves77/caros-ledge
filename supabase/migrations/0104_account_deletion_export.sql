-- 0104 delete and export one's own account (R2e M5; INV-R2e-4).
--
-- A member could leave nothing behind and take nothing with them: no way to delete the account, no way to get the data. Two functions, each acting on auth.uid() only (no argument names another account), each one transaction:
--   delete_own_account(): the auth user, the profile and everything that cascades from them (memberships, watchlist, notes' author link, saved views, notifications, community profile, group memberships, invitations addressed to them).
--     THE COMMUNITY RULE: what a member wrote stays and is attributed to a deleted member (community_posts.author_user_id nulls out); a thread others replied to is not torn out from under them. A group the member owned goes to its
--     oldest other admin, else its oldest other member (made an admin), else it is deleted with its last member. An organisation the member is the sole member of is deleted with them; one they solely OWN while others belong is
--     refused with the sentence that says who must be made owner first (22023). A platform administrator account is removed by another administrator (22023). The invitations the member issued and the sign-off requests they made
--     are deleted (their foreign keys restrict); an invitation another member issued TO them stays as that member's record with the address redacted and a pending one revoked. One admin_events row (counts only, no person) is written first; verification events that name the member as their target are scrubbed.
--   export_own_account(): the member's own rows as one jsonb (profile, memberships, the consents they gave, invitations received, watchlist, per-user item state, saved views, notifications and preferences, notes, assignments, tags, community profile,
--     groups, posts, sign-off requests, reports filed, acts performed). Rows that name other people (invitations they issued, who they assigned) are counted, never listed. Each section is bounded at 5000 rows.
-- Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.delete_own_account(); DROP FUNCTION public.export_own_account().

-- catalog: function

BEGIN;

CREATE FUNCTION public.delete_own_account() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE
  uid uuid := auth.uid(); v_email text; o record; g record; succ uuid; orgs_deleted int := 0; memberships int; groups_deleted int := 0; groups_handed int := 0; posts int;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to delete your account' USING ERRCODE = '42501'; END IF;
  IF public.is_platform_admin() THEN RAISE EXCEPTION 'A platform administrator account is removed by another administrator.' USING ERRCODE = '22023'; END IF;
  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = uid;
  FOR o IN SELECT m.org_id, org.name FROM public.org_memberships m JOIN public.organizations org ON org.id = m.org_id
            WHERE m.user_id = uid AND m.role = 'owner' AND NOT EXISTS (SELECT 1 FROM public.org_memberships x WHERE x.org_id = m.org_id AND x.role = 'owner' AND x.user_id <> uid)
              AND EXISTS (SELECT 1 FROM public.org_memberships x WHERE x.org_id = m.org_id AND x.user_id <> uid) LOOP
    RAISE EXCEPTION 'You are the only owner of "%" and other people belong to it. Make someone else an owner, or remove the members, first.', o.name USING ERRCODE = '22023';
  END LOOP;
  FOR o IN SELECT m.org_id FROM public.org_memberships m WHERE m.user_id = uid AND NOT EXISTS (SELECT 1 FROM public.org_memberships x WHERE x.org_id = m.org_id AND x.user_id <> uid) LOOP
    DELETE FROM public.auxiliary_energy_profiles WHERE org_id = o.org_id;
    DELETE FROM public.indexation_clauses WHERE org_id = o.org_id;
    DELETE FROM public.organizations WHERE id = o.org_id;
    orgs_deleted := orgs_deleted + 1;
  END LOOP;
  SELECT count(*) INTO memberships FROM public.org_memberships WHERE user_id = uid;
  UPDATE public.org_invitations SET invited_email = 'deleted-member-' || id::text || '@deleted.invalid', status = CASE WHEN status = 'pending' THEN 'revoked' ELSE status END,
         revoked_at = CASE WHEN status = 'pending' THEN now() ELSE revoked_at END WHERE invited_email = v_email AND invited_by_user_id <> uid;
  DELETE FROM public.org_invitations WHERE invited_by_user_id = uid;
  FOR g IN SELECT id FROM public.community_groups WHERE owner_user_id = uid LOOP
    succ := (SELECT m.user_id FROM public.community_group_members m WHERE m.group_id = g.id AND m.user_id <> uid ORDER BY (m.role = 'admin') DESC, m.joined_at, m.user_id LIMIT 1);
    IF succ IS NULL THEN
      DELETE FROM public.community_groups WHERE id = g.id;
      groups_deleted := groups_deleted + 1;
    ELSE
      UPDATE public.community_group_members SET role = 'admin' WHERE group_id = g.id AND user_id = succ AND role <> 'admin';
      UPDATE public.community_groups SET owner_user_id = succ WHERE id = g.id;
      groups_handed := groups_handed + 1;
    END IF;
  END LOOP;
  DELETE FROM public.community_post_signoff_requests WHERE requested_by = uid;
  SELECT count(*) INTO posts FROM public.community_posts WHERE author_user_id = uid;
  PERFORM public.record_admin_event(NULL, 'account_deleted', 'account', 'self', NULL,
    jsonb_build_object('organisations_deleted', orgs_deleted, 'memberships_removed', memberships, 'groups_deleted', groups_deleted, 'groups_handed_over', groups_handed, 'posts_kept_unattributed', posts));
  PERFORM set_config('caros.admin_events_scrub', 'on', true);
  UPDATE public.admin_events SET target_id = 'deleted-member' WHERE target_kind = 'member' AND target_id = uid::text;
  PERFORM set_config('caros.admin_events_scrub', 'off', true);
  DELETE FROM auth.users WHERE id = uid;
  RETURN jsonb_build_object('deleted', true, 'organisations_deleted', orgs_deleted, 'memberships_removed', memberships, 'groups_deleted', groups_deleted, 'groups_handed_over', groups_handed, 'posts_kept_unattributed', posts);
END;
$$;

CREATE FUNCTION public.export_own_account() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE uid uuid := auth.uid(); v_email text;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'sign in to export your account' USING ERRCODE = '42501'; END IF;
  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = uid;
  RETURN jsonb_build_object(
    'profile', (SELECT to_jsonb(p) FROM public.profiles p WHERE p.id = uid),
    'memberships', (SELECT coalesce(jsonb_agg(jsonb_build_object('org_id', m.org_id, 'org_name', o.name, 'role', m.role, 'joined_at', m.created_at) ORDER BY m.created_at, m.id), '[]'::jsonb) FROM public.org_memberships m JOIN public.organizations o ON o.id = m.org_id WHERE m.user_id = uid),
    'consents', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT o.name AS org_name, c.role, c.basis, c.consented_at FROM public.membership_consents c JOIN public.organizations o ON o.id = c.org_id WHERE c.user_id = uid ORDER BY c.consented_at, c.id LIMIT 5000) t),
    'invitations_received', (SELECT coalesce(jsonb_agg(jsonb_build_object('org_name', o.name, 'proposed_role', i.proposed_role, 'status', i.status, 'created_at', i.created_at) ORDER BY i.created_at, i.id), '[]'::jsonb) FROM public.org_invitations i JOIN public.organizations o ON o.id = i.org_id WHERE i.invited_email = v_email),
    'invitations_issued_count', (SELECT count(*) FROM public.org_invitations WHERE invited_by_user_id = uid),
    'watchlist', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT org_id, item_type, item_id, created_at FROM public.user_watchlist WHERE user_id = uid ORDER BY created_at, id LIMIT 5000) t),
    'item_state', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT org_id, item_id, is_archived, archive_note, archived_at FROM public.user_item_state WHERE user_id = uid ORDER BY created_at, id LIMIT 5000) t),
    'saved_views', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT surface, name, query, created_at FROM public.saved_views WHERE user_id = uid ORDER BY created_at, id LIMIT 5000) t),
    'notifications', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT kind, payload, read_at, created_at FROM public.notifications WHERE user_id = uid ORDER BY created_at DESC, id LIMIT 5000) t),
    'notification_preferences', (SELECT to_jsonb(t) FROM (SELECT enabled, on_mention, on_reply_in_my_threads, on_new_post_in_joined_groups, on_invite, on_promote, channels, updated_at FROM public.notification_preferences WHERE user_id = uid) t),
    'notes', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT org_id, item_id, body, created_at, edited_at FROM public.item_notes WHERE author_user_id = uid AND deleted_at IS NULL ORDER BY created_at, id LIMIT 5000) t),
    'assignments', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT org_id, item_id, due_on, state, created_at, (assignee_user_id = uid) AS assigned_to_me FROM public.item_assignments WHERE assignee_user_id = uid OR assigned_by = uid ORDER BY created_at, id LIMIT 5000) t),
    'tags_created', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT org_id, name, created_at FROM public.workspace_tags WHERE created_by = uid ORDER BY created_at, id LIMIT 5000) t),
    'community', jsonb_build_object(
      'profile', (SELECT to_jsonb(t) FROM (SELECT org_type, role, sector, region, verified, verified_at, verification_method, default_anonymous, created_at FROM public.community_member_profiles WHERE user_id = uid) t),
      'groups', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT g.name AS group_name, m.role, m.joined_at, (g.owner_user_id = uid) AS owner FROM public.community_group_members m JOIN public.community_groups g ON g.id = m.group_id WHERE m.user_id = uid ORDER BY m.joined_at, g.id LIMIT 5000) t),
      'posts', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT id, group_id, parent_post_id, title, body, anonymous, created_at FROM public.community_posts WHERE author_user_id = uid ORDER BY created_at, id LIMIT 5000) t),
      'signoff_requests', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT post_id, status, primary_doc_url, decision_note, created_at, decided_at FROM public.community_post_signoff_requests WHERE requested_by = uid ORDER BY created_at, id LIMIT 5000) t),
      'reports_filed', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT target_kind, reason, body, status, created_at FROM public.moderation_reports WHERE reporter_user_id = uid ORDER BY created_at, id LIMIT 5000) t)),
    'acts_performed', (SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) FROM (SELECT created_at, action, target_kind, reason FROM public.admin_events WHERE actor_id = uid ORDER BY created_at, id LIMIT 5000) t)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_own_account(), public.export_own_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_own_account(), public.export_own_account() TO authenticated;
COMMENT ON FUNCTION public.delete_own_account() IS 'R2e migration 0104. Delete the caller''s own account in one transaction: community writing stays under a deleted member, owned groups are handed over, a sole-member organisation goes with them, a sole owner of a shared one is refused; one admin_events row.';
COMMENT ON FUNCTION public.export_own_account() IS 'R2e migration 0104. The caller''s own rows as one jsonb; rows that name other people are counted, never listed.';

-- Self-check 0104-account: INV-R2e-4. A fixture of two members with data in every table, then: export is the caller''s alone (no id or address of the other member appears in it); deletion is refused for a platform admin, for the only owner of
-- an organisation others belong to, and with no session; deleting A removes A''s auth user, profile, membership, watchlist, notes, preferences, community profile and issued invitations, leaves A''s posts under no author, hands A''s group to B,
-- redacts the address on the invitation B sent to A, deletes the organisation A alone belonged to, writes one admin_events row naming no person, scrubs the verification event that named A, and changes NOTHING of B''s (every row count of B equal before and after).
DO $$
DECLARE
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); orga uuid := gen_random_uuid(); orgs uuid := gen_random_uuid(); orgb uuid := gen_random_uuid(); g uuid := gen_random_uuid(); gb uuid := gen_random_uuid(); it uuid;
  pa uuid; pb uuid; ex jsonb; res jsonb; before_b jsonb; after_b jsonb; ids text;
BEGIN
  IF has_function_privilege('anon', 'public.delete_own_account()', 'EXECUTE') OR has_function_privilege('anon', 'public.export_own_account()', 'EXECUTE') THEN RAISE EXCEPTION '0104-account: anon can execute a function it must not'; END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (a, 'a-0104@invalid.example'), (b, 'b-0104@invalid.example'), (adm, 'adm-0104@invalid.example');
    INSERT INTO public.profiles (id, email, full_name) VALUES (a, 'a-0104@invalid.example', 'Ann A'), (b, 'b-0104@invalid.example', 'Bob B'), (adm, 'adm-0104@invalid.example', 'Admin');
    UPDATE public.profiles SET is_platform_admin = true WHERE id = adm;
    INSERT INTO public.organizations (id, name, slug) VALUES (orga, 'selfcheck-0104-a', 'selfcheck-0104-a-' || orga), (orgs, 'selfcheck-0104-shared', 'selfcheck-0104-s-' || orgs), (orgb, 'selfcheck-0104-b', 'selfcheck-0104-b-' || orgb);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (orga, a, 'owner'), (orgs, a, 'owner'), (orgs, b, 'member'), (orgb, b, 'owner');
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('selfcheck-0104', 1, 'verified', false) RETURNING id INTO it;
    INSERT INTO public.membership_consents (user_id, org_id, role, basis) VALUES (a, orga, 'owner', 'organisation_created'), (a, orgs, 'owner', 'organisation_created'), (b, orgs, 'member', 'invitation_accepted'), (b, orgb, 'owner', 'organisation_created');
    INSERT INTO public.user_watchlist (user_id, org_id, item_type, item_id) VALUES (a, orga, 'reg', 'x-a'), (b, orgb, 'reg', 'x-b');
    INSERT INTO public.item_notes (org_id, item_id, author_user_id, body) VALUES (orga, it, a, 'note of A'), (orgb, it, b, 'note of B');
    INSERT INTO public.saved_views (user_id, surface, name, query) VALUES (a, 'regulations', 'A view', 'q=a'), (b, 'regulations', 'B view', 'q=b');
    INSERT INTO public.notification_preferences (user_id) VALUES (a), (b);
    INSERT INTO public.community_member_profiles (user_id, org_type) VALUES (a, 'forwarder'), (b, 'carrier');
    INSERT INTO public.community_groups (id, name, slug, region, privacy, owner_user_id) VALUES (g, 'ga', 'ga-0104-' || g, 'GLOBAL', 'public', a), (gb, 'gb-solo', 'gb-0104-' || gb, 'GLOBAL', 'public', a);
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g, a, 'admin'), (g, b, 'member'), (gb, a, 'admin');
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, a, 'by A', 'x') RETURNING id INTO pa;
    INSERT INTO public.community_posts (group_id, author_user_id, title, body) VALUES (g, b, 'by B', 'x') RETURNING id INTO pb;
    INSERT INTO public.community_post_signoff_requests (post_id, requested_by) VALUES (pa, a);
    INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input) VALUES (orgs, 'someone-0104@invalid.example', a, 'member', repeat('1', 64)), (orgb, 'a-0104@invalid.example', b, 'member', repeat('2', 64));
    PERFORM set_config('request.jwt.claim.sub', a::text, true);
    PERFORM public.record_admin_event(NULL, 'member_verified_domain', 'member', a::text, NULL, '{}'::jsonb);
    PERFORM set_config('request.jwt.claim.sub', '', true);

    -- export: the caller's rows only
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', a::text, true);
    ex := public.export_own_account();
    RESET ROLE;
    IF ex -> 'profile' ->> 'full_name' <> 'Ann A' OR jsonb_array_length(ex -> 'watchlist') <> 1 OR jsonb_array_length(ex -> 'notes') <> 1 OR jsonb_array_length(ex -> 'community' -> 'posts') <> 1 OR jsonb_array_length(ex -> 'memberships') <> 2 OR jsonb_array_length(ex -> 'consents') <> 2
       OR jsonb_array_length(ex -> 'invitations_received') <> 1 OR (ex ->> 'invitations_issued_count')::int <> 1 THEN RAISE EXCEPTION '0104-account: the export is not the caller''s rows: %', ex; END IF;
    IF ex::text LIKE '%' || b::text || '%' OR ex::text LIKE '%b-0104@invalid.example%' OR ex::text LIKE '%someone-0104%' OR ex::text LIKE '%note of B%' OR ex::text LIKE '%by B%' THEN RAISE EXCEPTION '0104-account: the export carries another member''s data'; END IF;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    BEGIN PERFORM public.export_own_account(); RAISE EXCEPTION '0104-account: exported with no session'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.delete_own_account(); RAISE EXCEPTION '0104-account: deleted with no session'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', adm::text, true);
    BEGIN PERFORM public.delete_own_account(); RAISE EXCEPTION '0104-account: a platform admin deleted their own account'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    -- A is the only owner of the shared organisation: refused, nothing changed
    PERFORM set_config('request.jwt.claim.sub', a::text, true);
    BEGIN PERFORM public.delete_own_account(); RAISE EXCEPTION '0104-account: the only owner of a shared organisation was deleted'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    RESET ROLE;
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = a) OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = orga) THEN RAISE EXCEPTION '0104-account: a refused deletion changed state'; END IF;
    -- make B an owner of the shared organisation, then A can go
    UPDATE public.org_memberships SET role = 'owner' WHERE org_id = orgs AND user_id = b;
    SELECT jsonb_build_object('wl', (SELECT count(*) FROM public.user_watchlist WHERE user_id = b), 'notes', (SELECT count(*) FROM public.item_notes WHERE author_user_id = b), 'views', (SELECT count(*) FROM public.saved_views WHERE user_id = b),
      'prefs', (SELECT count(*) FROM public.notification_preferences WHERE user_id = b), 'cmp', (SELECT count(*) FROM public.community_member_profiles WHERE user_id = b), 'posts', (SELECT count(*) FROM public.community_posts WHERE author_user_id = b),
      'mem', (SELECT count(*) FROM public.org_memberships WHERE user_id = b), 'cons', (SELECT count(*) FROM public.membership_consents WHERE user_id = b), 'inv', (SELECT count(*) FROM public.org_invitations WHERE invited_by_user_id = b), 'orgb', (SELECT count(*) FROM public.organizations WHERE id = orgb),
      'prof', (SELECT count(*) FROM public.profiles WHERE id = b), 'user', (SELECT count(*) FROM auth.users WHERE id = b), 'gm', (SELECT count(*) FROM public.community_group_members WHERE user_id = b)) INTO before_b;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', a::text, true);
    res := public.delete_own_account();
    RESET ROLE;
    IF (res ->> 'organisations_deleted')::int <> 1 OR (res ->> 'groups_deleted')::int <> 1 OR (res ->> 'groups_handed_over')::int <> 1 OR (res ->> 'posts_kept_unattributed')::int <> 1 THEN RAISE EXCEPTION '0104-account: the counts are wrong: %', res; END IF;
    IF EXISTS (SELECT 1 FROM auth.users WHERE id = a) OR EXISTS (SELECT 1 FROM public.profiles WHERE id = a) OR EXISTS (SELECT 1 FROM public.org_memberships WHERE user_id = a) OR EXISTS (SELECT 1 FROM public.membership_consents WHERE user_id = a) OR EXISTS (SELECT 1 FROM public.user_watchlist WHERE user_id = a)
       OR EXISTS (SELECT 1 FROM public.item_notes WHERE author_user_id = a) OR EXISTS (SELECT 1 FROM public.notification_preferences WHERE user_id = a) OR EXISTS (SELECT 1 FROM public.community_member_profiles WHERE user_id = a)
       OR EXISTS (SELECT 1 FROM public.org_invitations WHERE invited_by_user_id = a OR invited_email = 'a-0104@invalid.example') OR NOT EXISTS (SELECT 1 FROM public.org_invitations WHERE invited_by_user_id = b AND invited_email LIKE 'deleted-member-%@deleted.invalid' AND status = 'revoked') OR EXISTS (SELECT 1 FROM public.organizations WHERE id = orga) OR EXISTS (SELECT 1 FROM public.community_groups WHERE id = gb)
       OR EXISTS (SELECT 1 FROM public.community_post_signoff_requests WHERE post_id = pa) THEN RAISE EXCEPTION '0104-account: something of A''s remains'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.community_posts WHERE id = pa AND author_user_id IS NULL) OR (SELECT owner_user_id FROM public.community_groups WHERE id = g) <> b OR (SELECT role FROM public.community_group_members WHERE group_id = g AND user_id = b) <> 'admin' THEN
      RAISE EXCEPTION '0104-account: the community rule did not hold (post kept without an author, group handed to B)';
    END IF;
    IF (SELECT count(*) FROM public.admin_events WHERE action = 'account_deleted' AND actor_id IS NULL AND detail::text NOT LIKE '%' || a::text || '%') <> 1 OR EXISTS (SELECT 1 FROM public.admin_events WHERE target_id = a::text) OR (SELECT count(*) FROM public.admin_events WHERE target_id = 'deleted-member') <> 1 THEN
      RAISE EXCEPTION '0104-account: the event trail is wrong';
    END IF;
    SELECT jsonb_build_object('wl', (SELECT count(*) FROM public.user_watchlist WHERE user_id = b), 'notes', (SELECT count(*) FROM public.item_notes WHERE author_user_id = b), 'views', (SELECT count(*) FROM public.saved_views WHERE user_id = b),
      'prefs', (SELECT count(*) FROM public.notification_preferences WHERE user_id = b), 'cmp', (SELECT count(*) FROM public.community_member_profiles WHERE user_id = b), 'posts', (SELECT count(*) FROM public.community_posts WHERE author_user_id = b),
      'mem', (SELECT count(*) FROM public.org_memberships WHERE user_id = b), 'cons', (SELECT count(*) FROM public.membership_consents WHERE user_id = b), 'inv', (SELECT count(*) FROM public.org_invitations WHERE invited_by_user_id = b), 'orgb', (SELECT count(*) FROM public.organizations WHERE id = orgb),
      'prof', (SELECT count(*) FROM public.profiles WHERE id = b), 'user', (SELECT count(*) FROM auth.users WHERE id = b), 'gm', (SELECT count(*) FROM public.community_group_members WHERE user_id = b)) INTO after_b;
    IF before_b IS DISTINCT FROM after_b THEN RAISE EXCEPTION '0104-account: deleting A touched B: % then %', before_b, after_b; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0104-account OK';
END $$;

COMMIT;
