-- 0100 admin_events and org_can (R2e M1, M2; register rows W:1-4, W:36, W:38; INV-R2e-2).
--
-- Membership and admin acts were written on the service client around the SEC-3b guard, in two statements, with no record of who did them or why; the permission behind them was decided in five places with five answers.
--   * admin_events: ONE append-only table for every privileged act, by an organisation's owner or admin and by a platform admin: (id, created_at, actor_id, org_id, action, target_kind, target_id, reason, detail).
--     Nobody writes it through a client role (no INSERT, UPDATE or DELETE grant to authenticated, anon or service_role): the only writer is record_admin_event, a function no client role can execute, called by the
--     SECURITY DEFINER functions of 0101 and 0102 inside the same transaction as the change, so a failed event rolls the change back and a failed change leaves no event. actor_id and org_id null out with the account or
--     organisation they name (the act stays on record, the person does not). Read: a platform admin reads every row; an organisation's owner or admin reads the rows of that organisation.
--   * org_role_actions, org_actions(org) and org_can(org, action): the ONE decision of what a role may do. The table is the vocabulary (action, role), seeded here; org_actions is the only place a role becomes a permission and org_can asks it;
--     both answer for auth.uid() only (no parameter names another user) and the pseudo-role platform_admin is answered by is_platform_admin(). Every function of 0101 decides through them and nothing else; the members route hands org_actions to the UI.
-- Not applied to production before the cutover window.
--
-- Reversal: DROP TABLE public.admin_events (its triggers go with it); DROP FUNCTION public.admin_events_guard(); DROP FUNCTION public.org_can(uuid, text); DROP FUNCTION public.org_actions(uuid); DROP FUNCTION public.record_admin_event(uuid, text, text, text, text, jsonb); DROP TABLE public.admin_events; DROP TABLE public.org_role_actions.

-- catalog: relation, column, constraint, index, policy, function, trigger, acl

BEGIN;

CREATE TABLE public.org_role_actions (
  action text NOT NULL,
  role text NOT NULL,
  CONSTRAINT org_role_actions_role_check CHECK (role IN ('owner', 'admin', 'member', 'viewer', 'platform_admin')),
  CONSTRAINT org_role_actions_action_check CHECK (action ~ '^[a-z][a-z0-9_]*$')
);
ALTER TABLE public.org_role_actions ADD CONSTRAINT org_role_actions_pkey PRIMARY KEY (action, role);
COMMENT ON TABLE public.org_role_actions IS 'R2e migration 0100. The vocabulary of org_can: which role may do which action in an organisation; platform_admin is answered by is_platform_admin(). Seeded by the migration; read only through org_actions.';
ALTER TABLE public.org_role_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.org_role_actions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.org_role_actions TO authenticated, service_role;
CREATE POLICY org_role_actions_read ON public.org_role_actions FOR SELECT TO authenticated, service_role USING (true);

INSERT INTO public.org_role_actions (action, role) VALUES
  ('read_roster', 'owner'), ('read_roster', 'admin'), ('read_roster', 'member'), ('read_roster', 'viewer'), ('read_roster', 'platform_admin'),
  ('read_roster_emails', 'owner'), ('read_roster_emails', 'admin'),
  ('invite_member', 'owner'), ('invite_member', 'admin'), ('invite_member', 'platform_admin'),
  ('revoke_invitation', 'owner'), ('revoke_invitation', 'admin'), ('revoke_invitation', 'platform_admin'),
  ('change_role', 'owner'), ('change_role', 'admin'), ('change_role', 'platform_admin'),
  ('grant_owner', 'owner'), ('grant_owner', 'platform_admin'),
  ('remove_member', 'owner'), ('remove_member', 'admin'), ('remove_member', 'platform_admin'),
  ('remove_owner', 'owner'), ('remove_owner', 'platform_admin'),
  ('ban_member', 'owner'), ('ban_member', 'admin'), ('ban_member', 'platform_admin'),
  ('rename_org', 'owner'), ('rename_org', 'platform_admin'),
  ('set_priority_override', 'owner'), ('set_priority_override', 'admin'),
  ('restore_team_item', 'owner'), ('restore_team_item', 'admin'),
  ('delete_any_tag', 'owner'), ('delete_any_tag', 'admin'),
  ('read_events', 'owner'), ('read_events', 'admin'), ('read_events', 'platform_admin');

CREATE FUNCTION public.org_actions(p_org uuid) RETURNS text[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
  SELECT coalesce(array_agg(DISTINCT a.action ORDER BY a.action), '{}'::text[]) FROM public.org_role_actions a
   WHERE (a.role = 'platform_admin' AND public.is_platform_admin())
      OR a.role = (SELECT m.role FROM public.org_memberships m WHERE m.org_id = p_org AND m.user_id = auth.uid())
$$;
REVOKE ALL ON FUNCTION public.org_actions(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_actions(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.org_actions(uuid) IS 'R2e migration 0100. Every action auth.uid() may do in organisation p_org (their membership role, plus platform_admin where is_platform_admin()). The one place a role becomes a permission; the members route hands it to the UI as the capability list.';

CREATE FUNCTION public.org_can(p_org uuid, p_action text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT p_action = ANY (public.org_actions(p_org)) $$;
REVOKE ALL ON FUNCTION public.org_can(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.org_can(uuid, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.org_can(uuid, text) IS 'R2e migration 0100. The one permission decision: may auth.uid() do p_action in organisation p_org. False for no session, no membership and an unknown action.';

CREATE TABLE public.admin_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid,
  org_id uuid,
  action text NOT NULL,
  target_kind text NOT NULL,
  target_id text NOT NULL,
  reason text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT admin_events_actor_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT admin_events_org_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE SET NULL,
  CONSTRAINT admin_events_action_check CHECK (action ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT admin_events_target_kind_check CHECK (target_kind ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT admin_events_reason_check CHECK (reason IS NULL OR (btrim(reason) <> '' AND length(reason) <= 2000)),
  CONSTRAINT admin_events_detail_object CHECK (jsonb_typeof(detail) = 'object')
);
ALTER TABLE public.admin_events ADD CONSTRAINT admin_events_pkey PRIMARY KEY (id);
CREATE INDEX admin_events_created_at_idx ON public.admin_events (created_at DESC, id);
CREATE INDEX admin_events_org_idx ON public.admin_events (org_id, created_at DESC);
CREATE INDEX admin_events_actor_idx ON public.admin_events (actor_id);
COMMENT ON TABLE public.admin_events IS 'R2e migration 0100. Append-only record of privileged acts (membership, organisation, source, flag, hold, corpus request, verification, group privacy). Written only by record_admin_event inside the same transaction as the change; no client role holds INSERT, UPDATE or DELETE.';
ALTER TABLE public.admin_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.admin_events TO authenticated, service_role;
CREATE POLICY admin_events_read ON public.admin_events FOR SELECT TO authenticated
  USING ((SELECT public.is_platform_admin()) OR (org_id IS NOT NULL AND public.org_can(org_id, 'read_events')));
CREATE POLICY admin_events_service_read ON public.admin_events FOR SELECT TO service_role USING (true);

CREATE FUNCTION public.record_admin_event(p_org_id uuid, p_action text, p_target_kind text, p_target_id text, p_reason text, p_detail jsonb) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.admin_events (actor_id, org_id, action, target_kind, target_id, reason, detail)
  VALUES (auth.uid(), p_org_id, p_action, p_target_kind, p_target_id, nullif(btrim(coalesce(p_reason, '')), ''), coalesce(p_detail, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_admin_event(uuid, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.record_admin_event(uuid, text, text, text, text, jsonb) IS 'R2e migration 0100. The one writer of admin_events: the actor is auth.uid(), never an argument. No client role can execute it; only the SECURITY DEFINER functions that make the change call it, inside their own transaction.';

-- Append-only, enforced where the data lives (a revoked grant is a presence check; this is the refusal): no UPDATE or DELETE or TRUNCATE succeeds on admin_events, for any role including the table's owner, except the two changes the
-- design needs. (1) A deleted account or organisation nulls the reference the row held (the foreign keys' own ON DELETE SET NULL; the act stays, the person does not). (2) delete_own_account scrubs the identifier of the person it
-- erased from target_id and detail, and only while it declares so (caros.admin_events_scrub, transaction-local). The trigger is ENABLE ALWAYS, so a session that sets session_replication_role = replica does not switch it off.
CREATE FUNCTION public.admin_events_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id AND NEW.created_at = OLD.created_at AND NEW.action = OLD.action AND NEW.target_kind = OLD.target_kind AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND (NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id OR NEW.actor_id IS NULL)
     AND (NEW.org_id IS NOT DISTINCT FROM OLD.org_id OR NEW.org_id IS NULL)
     AND ((NEW.target_id = OLD.target_id AND NEW.detail = OLD.detail) OR coalesce(current_setting('caros.admin_events_scrub', true), '') = 'on') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'admin_events is append-only: % is refused', TG_OP USING ERRCODE = '42501';
END;
$$;
REVOKE ALL ON FUNCTION public.admin_events_guard() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER admin_events_append_only BEFORE UPDATE OR DELETE ON public.admin_events FOR EACH ROW EXECUTE FUNCTION public.admin_events_guard();
CREATE TRIGGER admin_events_no_truncate BEFORE TRUNCATE ON public.admin_events FOR EACH STATEMENT EXECUTE FUNCTION public.admin_events_guard();
ALTER TABLE public.admin_events ENABLE ALWAYS TRIGGER admin_events_append_only;
ALTER TABLE public.admin_events ENABLE ALWAYS TRIGGER admin_events_no_truncate;
COMMENT ON FUNCTION public.admin_events_guard() IS 'R2e migration 0100. The append-only rule of admin_events: refuses UPDATE, DELETE and TRUNCATE for every role, except nulling actor_id or org_id and the declared scrub of a deleted member''s identifier.';

-- Self-check 0100-admin-events: shape and access, then attacks in a fixture that rolls back. No client role writes admin_events or runs record_admin_event; org_can answers by role (owner, admin, member, viewer, a stranger, a platform
-- admin, no session) for the seeded actions and says false for an unknown action; a platform admin reads every event, an organisation's owner reads that organisation's events only, a member and a stranger read none.
DO $$
DECLARE
  org uuid := gen_random_uuid(); orgb uuid := gen_random_uuid(); uo uuid := gen_random_uuid(); ua uuid := gen_random_uuid(); um uuid := gen_random_uuid(); uv uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); up uuid := gen_random_uuid();
  ev uuid; n int; replica boolean := true;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.admin_events'::regclass) OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.org_role_actions'::regclass) THEN RAISE EXCEPTION '0100-admin-events: RLS is off'; END IF;
  IF has_table_privilege('anon', 'public.admin_events', 'SELECT') OR has_table_privilege('authenticated', 'public.admin_events', 'INSERT') OR has_table_privilege('authenticated', 'public.admin_events', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.admin_events', 'DELETE') OR has_table_privilege('service_role', 'public.admin_events', 'INSERT') OR has_table_privilege('service_role', 'public.admin_events', 'UPDATE')
     OR has_table_privilege('service_role', 'public.admin_events', 'DELETE') OR has_table_privilege('authenticated', 'public.org_role_actions', 'INSERT') THEN
    RAISE EXCEPTION '0100-admin-events: a client role holds a privilege it must not';
  END IF;
  IF has_function_privilege('authenticated', 'public.record_admin_event(uuid, text, text, text, text, jsonb)', 'EXECUTE') OR has_function_privilege('service_role', 'public.record_admin_event(uuid, text, text, text, text, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.record_admin_event(uuid, text, text, text, text, jsonb)', 'EXECUTE') OR has_function_privilege('anon', 'public.org_can(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0100-admin-events: a client role can execute a function it must not';
  END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (uo, 'o-0100@invalid.example'), (ua, 'a-0100@invalid.example'), (um, 'm-0100@invalid.example'), (uv, 'v-0100@invalid.example'), (ub, 'b-0100@invalid.example'), (up, 'p-0100@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (uo, 'o-0100@invalid.example'), (ua, 'a-0100@invalid.example'), (um, 'm-0100@invalid.example'), (uv, 'v-0100@invalid.example'), (ub, 'b-0100@invalid.example'), (up, 'p-0100@invalid.example');
    UPDATE public.profiles SET is_platform_admin = true WHERE id = up;
    INSERT INTO public.organizations (id, name, slug) VALUES (org, 'selfcheck-0100', 'selfcheck-0100-' || org), (orgb, 'selfcheck-0100-b', 'selfcheck-0100-b-' || orgb);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, uo, 'owner'), (org, ua, 'admin'), (org, um, 'member'), (org, uv, 'viewer'), (orgb, ub, 'owner');
    PERFORM set_config('request.jwt.claim.sub', uo::text, true);
    ev := public.record_admin_event(org, 'selfcheck_a', 'organization', org::text, 'seed', '{}'::jsonb);
    PERFORM set_config('request.jwt.claim.sub', ub::text, true);
    PERFORM public.record_admin_event(orgb, 'selfcheck_b', 'organization', orgb::text, NULL, '{}'::jsonb);
    PERFORM set_config('request.jwt.claim.sub', '', true);

    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', uo::text, true);
    BEGIN INSERT INTO public.admin_events (action, target_kind, target_id) VALUES ('forged', 'organization', org::text); RAISE EXCEPTION '0100-admin-events: an owner forged an event';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN PERFORM public.record_admin_event(org, 'forged', 'organization', org::text, NULL, '{}'::jsonb); RAISE EXCEPTION '0100-admin-events: an owner ran record_admin_event';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    IF NOT public.org_can(org, 'change_role') OR NOT public.org_can(org, 'rename_org') OR NOT public.org_can(org, 'grant_owner') OR NOT public.org_can(org, 'read_roster_emails') THEN RAISE EXCEPTION '0100-admin-events: an owner lacks an owner action'; END IF;
    IF public.org_can(orgb, 'change_role') OR public.org_can(org, 'no_such_action') THEN RAISE EXCEPTION '0100-admin-events: an owner can act in another organisation or on an unknown action'; END IF;
    SELECT count(*) INTO n FROM public.admin_events WHERE action LIKE 'selfcheck%';
    IF n <> 1 THEN RAISE EXCEPTION '0100-admin-events: an owner reads % of the selfcheck events, expected their own organisation''s 1', n; END IF;
    PERFORM set_config('request.jwt.claim.sub', ua::text, true);
    IF NOT public.org_can(org, 'change_role') OR NOT public.org_can(org, 'read_roster_emails') OR public.org_can(org, 'rename_org') OR public.org_can(org, 'grant_owner') OR public.org_can(org, 'remove_owner') THEN RAISE EXCEPTION '0100-admin-events: an admin''s actions are wrong'; END IF;
    PERFORM set_config('request.jwt.claim.sub', um::text, true);
    IF public.org_can(org, 'change_role') OR public.org_can(org, 'read_roster_emails') OR NOT public.org_can(org, 'read_roster') OR public.org_can(org, 'set_priority_override') THEN RAISE EXCEPTION '0100-admin-events: a member''s actions are wrong'; END IF;
    SELECT count(*) INTO n FROM public.admin_events;
    IF n <> 0 THEN RAISE EXCEPTION '0100-admin-events: a member reads % events', n; END IF;
    PERFORM set_config('request.jwt.claim.sub', uv::text, true);
    IF public.org_can(org, 'invite_member') OR NOT public.org_can(org, 'read_roster') THEN RAISE EXCEPTION '0100-admin-events: a viewer''s actions are wrong'; END IF;
    PERFORM set_config('request.jwt.claim.sub', ub::text, true);
    IF public.org_can(org, 'read_roster') OR public.org_can(org, 'change_role') THEN RAISE EXCEPTION '0100-admin-events: a stranger can act in an organisation they are not in'; END IF;
    SELECT count(*) INTO n FROM public.admin_events WHERE action = 'selfcheck_a';
    IF n <> 0 THEN RAISE EXCEPTION '0100-admin-events: a stranger reads another organisation''s events'; END IF;
    PERFORM set_config('request.jwt.claim.sub', up::text, true);
    IF NOT public.org_can(org, 'change_role') OR NOT public.org_can(org, 'rename_org') OR public.org_can(org, 'read_roster_emails') OR public.org_can(org, 'set_priority_override') THEN RAISE EXCEPTION '0100-admin-events: a platform admin''s actions are wrong'; END IF;
    SELECT count(*) INTO n FROM public.admin_events WHERE action LIKE 'selfcheck%';
    IF n <> 2 THEN RAISE EXCEPTION '0100-admin-events: a platform admin reads % of 2 selfcheck events', n; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    IF public.org_can(org, 'read_roster') THEN RAISE EXCEPTION '0100-admin-events: a caller with no session can act'; END IF;
    RESET ROLE;
    -- THE ATTACK (rule 15): the table's owner, the role that holds every privilege, is refused too; so is a session that switches triggers off. Each attempt must fail with 42501 and leave the row as it was.
    BEGIN UPDATE public.admin_events SET reason = 'rewritten' WHERE id = ev; RAISE EXCEPTION '0100-admin-events: the owner edited an event''s reason';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN UPDATE public.admin_events SET actor_id = ua WHERE id = ev; RAISE EXCEPTION '0100-admin-events: the owner re-attributed an event to another person';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN UPDATE public.admin_events SET detail = '{"forged":true}'::jsonb WHERE id = ev; RAISE EXCEPTION '0100-admin-events: the owner rewrote an event''s detail';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN DELETE FROM public.admin_events WHERE id = ev; RAISE EXCEPTION '0100-admin-events: the owner deleted an event';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN TRUNCATE public.admin_events; RAISE EXCEPTION '0100-admin-events: the owner truncated the event table';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
    BEGIN SET LOCAL session_replication_role = replica; EXCEPTION WHEN insufficient_privilege THEN replica := false; END;
    IF replica THEN
      BEGIN UPDATE public.admin_events SET reason = 'rewritten' WHERE id = ev; RAISE EXCEPTION '0100-admin-events: switching triggers off (session_replication_role = replica) allowed an edit';
      EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
      BEGIN DELETE FROM public.admin_events WHERE id = ev; RAISE EXCEPTION '0100-admin-events: switching triggers off allowed a delete';
      EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END;
      SET LOCAL session_replication_role = origin;
    END IF;
    IF (SELECT reason FROM public.admin_events WHERE id = ev) IS DISTINCT FROM 'seed' OR (SELECT actor_id FROM public.admin_events WHERE id = ev) IS DISTINCT FROM uo THEN RAISE EXCEPTION '0100-admin-events: an attack changed the event'; END IF;
    -- The account an event names can be deleted without losing the event: the actor nulls out.
    DELETE FROM public.org_memberships WHERE org_id = org AND user_id = uo;
    DELETE FROM public.profiles WHERE id = uo;
    DELETE FROM auth.users WHERE id = uo;
    IF (SELECT actor_id FROM public.admin_events WHERE id = ev) IS NOT NULL OR NOT EXISTS (SELECT 1 FROM public.admin_events WHERE id = ev) THEN RAISE EXCEPTION '0100-admin-events: deleting the actor lost the event or kept the actor'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0100-admin-events OK';
END $$;

COMMIT;
