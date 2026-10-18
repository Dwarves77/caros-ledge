-- 0052 a community group keeps an admin (P2-16, INV-238).
--
-- The leave route counted admins and refused at one, but the rule lived in the route: a moderation ban, a service-role delete or any later writer could remove the last admin and leave the group ungovernable. The rule
-- moves to the data: community_group_keeps_an_admin is a BEFORE DELETE OR UPDATE OF role trigger on community_group_members that refuses (22023, a 409 to the client) removing or demoting the only admin of a
-- group. It stands aside when the group itself is being deleted (the cascade removes every member) and when the member's account is being deleted (the cascade must not be blocked by a group).
-- Not applied to production before the cutover window.
--
-- Reversal: DROP TRIGGER community_group_keeps_an_admin_trg ON public.community_group_members; DROP FUNCTION public.community_group_keeps_an_admin().

-- catalog: function, trigger

BEGIN;

CREATE FUNCTION public.community_group_keeps_an_admin() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF OLD.role = 'admin' AND (TG_OP = 'DELETE' OR NEW.role <> 'admin')
     AND EXISTS (SELECT 1 FROM public.community_groups g WHERE g.id = OLD.group_id)
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id)
     AND NOT EXISTS (SELECT 1 FROM public.community_group_members m WHERE m.group_id = OLD.group_id AND m.role = 'admin' AND m.user_id <> OLD.user_id) THEN
    RAISE EXCEPTION 'You are the only admin of this group. Make another member an admin first.' USING ERRCODE = '22023';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
REVOKE ALL ON FUNCTION public.community_group_keeps_an_admin() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER community_group_keeps_an_admin_trg BEFORE DELETE OR UPDATE OF role ON public.community_group_members FOR EACH ROW EXECUTE FUNCTION public.community_group_keeps_an_admin();

-- Self-check 0052-keeps-an-admin: the only admin cannot leave (their own session, then the service path) or be demoted, and the group is unchanged; with a second admin the first can leave; a plain member leaves freely; deleting
-- the group removes every member including its last admin; deleting the last admin's account is not blocked by the group.
DO $$
DECLARE g uuid := gen_random_uuid(); g2 uuid := gen_random_uuid(); a1 uuid := gen_random_uuid(); a2 uuid := gen_random_uuid(); m uuid := gen_random_uuid(); solo uuid := gen_random_uuid(); n int;
BEGIN
  IF has_function_privilege('authenticated', 'public.community_group_keeps_an_admin()', 'EXECUTE') OR has_function_privilege('anon', 'public.community_group_keeps_an_admin()', 'EXECUTE') THEN
    RAISE EXCEPTION '0052-keeps-an-admin: a client role can execute the trigger function';
  END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (a1, 'a1-0052@invalid.example'), (a2, 'a2-0052@invalid.example'), (m, 'm-0052@invalid.example'), (solo, 'solo-0052@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (a1, 'a1-0052@invalid.example'), (a2, 'a2-0052@invalid.example'), (m, 'm-0052@invalid.example'), (solo, 'solo-0052@invalid.example');
    INSERT INTO public.community_groups (id, name, slug, region, privacy, owner_user_id) VALUES (g, 'g', 'g-0052-' || g, 'GLOBAL', 'public', a1), (g2, 'g2', 'g2-0052-' || g2, 'GLOBAL', 'public', a2);
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g, a1, 'admin'), (g, m, 'member'), (g2, solo, 'admin');

    BEGIN DELETE FROM public.community_group_members WHERE group_id = g AND user_id = a1; RAISE EXCEPTION '0052-keeps-an-admin: the only admin was removed';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN UPDATE public.community_group_members SET role = 'member' WHERE group_id = g AND user_id = a1; RAISE EXCEPTION '0052-keeps-an-admin: the only admin was demoted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', a1::text, true);
    BEGIN DELETE FROM public.community_group_members WHERE group_id = g AND user_id = a1; RAISE EXCEPTION '0052-keeps-an-admin: the only admin left through their own session';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    RESET ROLE;
    SELECT count(*) INTO n FROM public.community_group_members WHERE group_id = g;
    IF n <> 2 THEN RAISE EXCEPTION '0052-keeps-an-admin: a refused removal still changed the group (% members)', n; END IF;

    DELETE FROM public.community_group_members WHERE group_id = g AND user_id = m;
    INSERT INTO public.community_group_members (group_id, user_id, role) VALUES (g, a2, 'admin');
    DELETE FROM public.community_group_members WHERE group_id = g AND user_id = a1;
    IF EXISTS (SELECT 1 FROM public.community_group_members WHERE group_id = g AND user_id = a1) THEN RAISE EXCEPTION '0052-keeps-an-admin: an admin with a second admin could not leave'; END IF;

    DELETE FROM auth.users WHERE id = solo;
    IF EXISTS (SELECT 1 FROM public.community_group_members WHERE group_id = g2) THEN RAISE EXCEPTION '0052-keeps-an-admin: the last admin''s account deletion left a membership behind'; END IF;
    DELETE FROM public.community_groups WHERE id = g;
    IF EXISTS (SELECT 1 FROM public.community_group_members WHERE group_id = g) THEN RAISE EXCEPTION '0052-keeps-an-admin: deleting the group left members behind'; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0052-keeps-an-admin OK';
END $$;

COMMIT;
