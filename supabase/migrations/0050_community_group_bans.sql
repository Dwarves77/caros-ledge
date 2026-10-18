-- 0050 community_group_bans (P2-16, BUILD-PLAN section 4 ruling 5: bans are GROUP-SCOPED).
--
-- A "ban" in the old tree deleted a membership row and recorded nothing, so the banned author joined a public group again with one click. This migration is the record and the wall:
--   * community_group_bans(group_id, user_id, banned_by, reason, created_at), PK (group_id, user_id): one ban per member per group. RLS on: a group admin or moderator of the group and a platform admin
--     can SELECT; nobody writes through a client role. The only writer is moderate_report (0057, security definer) and the service role.
--   * community_group_members_ban_guard: a BEFORE INSERT trigger on community_group_members that refuses (42501) a membership for a banned user, whoever writes it (the join route's service client, the invitation
--     accept function, an admin). A check in the route is the first wall; this is the second, so a new writer cannot forget it. The ban is lifted only by deleting its row.
-- Not applied to production before the cutover window.
--
-- Reversal: DROP TRIGGER community_group_members_ban_guard_trg ON public.community_group_members; DROP FUNCTION public.community_group_members_ban_guard(); DROP TABLE public.community_group_bans.

-- catalog: relation, column, constraint, index, policy, trigger, function, acl

BEGIN;

CREATE TABLE public.community_group_bans (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  banned_by uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_group_bans_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.community_groups(id) ON DELETE CASCADE,
  CONSTRAINT community_group_bans_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT community_group_bans_banned_by_fkey FOREIGN KEY (banned_by) REFERENCES auth.users(id) ON DELETE SET NULL
);
ALTER TABLE public.community_group_bans ADD CONSTRAINT community_group_bans_pkey PRIMARY KEY (group_id, user_id);
CREATE INDEX community_group_bans_user_id_idx ON public.community_group_bans (user_id);
CREATE INDEX community_group_bans_banned_by_idx ON public.community_group_bans (banned_by);

COMMENT ON TABLE public.community_group_bans IS 'Group-scoped bans (P2-16 migration 0050). Written only by moderate_report and the service role; read by the group''s admins and moderators and platform admins. A banned user cannot become a member of the group (community_group_members_ban_guard).';

ALTER TABLE public.community_group_bans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.community_group_bans FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.community_group_bans TO authenticated;
GRANT ALL ON TABLE public.community_group_bans TO service_role;

CREATE POLICY community_group_bans_select_reviewer ON public.community_group_bans FOR SELECT TO authenticated
  USING (public.user_is_group_admin(group_id, (SELECT auth.uid())) OR (SELECT public.is_platform_admin()));

CREATE FUNCTION public.community_group_members_ban_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.community_group_bans b WHERE b.group_id = NEW.group_id AND b.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'This account is banned from the group' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.community_group_members_ban_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER community_group_members_ban_guard_trg BEFORE INSERT ON public.community_group_members FOR EACH ROW EXECUTE FUNCTION public.community_group_members_ban_guard();

-- Self-check 0050-group-bans: shape and access; then attacks in a fixture that rolls back. A banned user's membership insert is refused by the trigger, from the service path and from a group admin's own session; the
-- ban of one group does not stop the same user joining another; a group's admin sees the ban row and an ordinary member sees none; no client role writes the table; removing the ban lets the user in.
DO $$
DECLARE g1 uuid := gen_random_uuid(); g2 uuid := gen_random_uuid(); adm uuid := gen_random_uuid(); mem uuid := gen_random_uuid(); bad uuid := gen_random_uuid(); n int;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.community_group_bans'::regclass) THEN RAISE EXCEPTION '0050-group-bans: RLS is off'; END IF;
  IF has_table_privilege('anon', 'public.community_group_bans', 'SELECT') OR has_table_privilege('authenticated', 'public.community_group_bans', 'INSERT')
     OR has_table_privilege('authenticated', 'public.community_group_bans', 'UPDATE') OR has_table_privilege('authenticated', 'public.community_group_bans', 'DELETE') THEN
    RAISE EXCEPTION '0050-group-bans: a client role holds a privilege it must not';
  END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (adm, 'adm-0050@invalid.example'), (mem, 'mem-0050@invalid.example'), (bad, 'bad-0050@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (adm, 'adm-0050@invalid.example'), (mem, 'mem-0050@invalid.example'), (bad, 'bad-0050@invalid.example');
    INSERT INTO public.community_groups (id, name, slug, region, privacy, owner_user_id) VALUES (g1, 'g1', 'g1-0050-' || g1, 'GLOBAL', 'public', adm), (g2, 'g2', 'g2-0050-' || g2, 'GLOBAL', 'public', adm);
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g1, adm, 'admin'), (g1, mem, 'member');
    INSERT INTO public.community_group_bans (group_id, user_id, banned_by, reason) VALUES (g1, bad, adm, 'selfcheck');

    BEGIN INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g1, bad, 'member'); RAISE EXCEPTION '0050-group-bans: a banned user became a member';
    EXCEPTION WHEN SQLSTATE '42501' THEN IF SQLERRM <> 'This account is banned from the group' THEN RAISE EXCEPTION '0050-group-bans: refused for another reason: %', SQLERRM; END IF; END;
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g2, bad, 'member');

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', adm::text, true);
    SELECT count(*) INTO n FROM public.community_group_bans;
    IF n <> 1 THEN RAISE EXCEPTION '0050-group-bans: a group admin sees % ban rows, expected 1', n; END IF;
    BEGIN INSERT INTO public.community_group_bans (group_id, user_id, banned_by) VALUES (g1, mem, adm); RAISE EXCEPTION '0050-group-bans: a client role wrote a ban';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g1, bad, 'member'); RAISE EXCEPTION '0050-group-bans: an admin session added a banned user';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    PERFORM set_config('request.jwt.claim.sub', mem::text, true);
    SELECT count(*) INTO n FROM public.community_group_bans;
    IF n <> 0 THEN RAISE EXCEPTION '0050-group-bans: an ordinary member reads % ban rows', n; END IF;
    RESET ROLE;

    DELETE FROM public.community_group_bans WHERE group_id = g1 AND user_id = bad;
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g1, bad, 'member');
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0050-group-bans OK';
END $$;

COMMIT;
