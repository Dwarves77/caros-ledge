-- 0064 host_worklist (P2-15 PART A, IMP-114; WHY section 7).
--
-- registerAndRate answers `worklist` for a host the institution class table and the committed verdicts do not place. No table held such a host (census_worklist is document-level), so the answer was a return value a caller could
-- drop, and the host-verdicts batch kind had an apply and no producer. The unplaced hosts are now rows, written by the one function that returns the answer (record_host_worklist, called from registerAndRate itself):
--   host         primary key, the bare hostname as host_verdicts normalises it (lower case, no www., no trailing dot).
--   reason       why it is unplaced (the answer's own text).     first_seen_at, last_seen_at     when it was first and last returned.
--   seen_count   how many times registerAndRate returned it (each call counts once).     last_name   the source name the last caller gave, when it gave one.
-- record_host_worklist(p_host, p_reason, p_name) is one atomic upsert that increments seen_count; it is executable by service_role only. host_verdicts gains one trigger, so a verdict for a host removes its worklist row in the same
-- statement and transaction as the verdict (an applied verdict closes the item for every writer, not only the batch kind). The host-verdicts exporter (src/features/batches/kinds/host-verdicts/export.ts) reads this table.
-- Access: RLS on. service_role writes; a platform admin reads (the is_platform_admin() pattern of 0042); nobody else. Not applied to production before the cutover window.
--
-- Reversal: DROP TRIGGER host_verdicts_clears_worklist ON public.host_verdicts; DROP FUNCTION public.host_verdicts_clear_worklist(); DROP FUNCTION public.record_host_worklist(text, text, text); DROP TABLE public.host_worklist.

-- catalog: relation, column, constraint, index, policy, function, trigger, acl

BEGIN;

CREATE TABLE public.host_worklist (
  host text NOT NULL,
  reason text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  seen_count integer NOT NULL DEFAULT 1,
  last_name text,
  CONSTRAINT host_worklist_host_check CHECK (host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' AND host !~ '^www\.' AND host !~ '\.\.'),
  CONSTRAINT host_worklist_seen_count_check CHECK (seen_count >= 1),
  CONSTRAINT host_worklist_reason_check CHECK (btrim(reason) <> '')
);
ALTER TABLE public.host_worklist ADD CONSTRAINT host_worklist_pkey PRIMARY KEY (host);
CREATE INDEX host_worklist_last_seen_idx ON public.host_worklist (last_seen_at DESC);

COMMENT ON TABLE public.host_worklist IS 'Hosts registerAndRate could not place (P2-15 migration 0064): written by record_host_worklist, closed by a host_verdicts row for the host, read by the host-verdicts exporter and by platform admins.';

ALTER TABLE public.host_worklist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.host_worklist FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.host_worklist TO authenticated;
GRANT ALL ON TABLE public.host_worklist TO service_role;
CREATE POLICY host_worklist_read_platform_admin ON public.host_worklist FOR SELECT TO authenticated USING ((SELECT public.is_platform_admin()));

CREATE FUNCTION public.record_host_worklist(p_host text, p_reason text, p_name text) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp
  AS $$
  INSERT INTO public.host_worklist (host, reason, last_name) VALUES (p_host, p_reason, nullif(btrim(coalesce(p_name, '')), ''))
  ON CONFLICT (host) DO UPDATE SET seen_count = public.host_worklist.seen_count + 1, last_seen_at = now(), reason = EXCLUDED.reason,
    last_name = coalesce(EXCLUDED.last_name, public.host_worklist.last_name)
  RETURNING seen_count;
$$;
REVOKE ALL ON FUNCTION public.record_host_worklist(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_host_worklist(text, text, text) TO service_role;

CREATE FUNCTION public.host_verdicts_clear_worklist() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
BEGIN
  DELETE FROM public.host_worklist WHERE host = NEW.host;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.host_verdicts_clear_worklist() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER host_verdicts_clears_worklist AFTER INSERT OR UPDATE OF host ON public.host_verdicts FOR EACH ROW EXECUTE FUNCTION public.host_verdicts_clear_worklist();

-- Self-check 0064-host-worklist, in a fixture that rolls back: the first call writes one row (seen_count 1, the name kept); THE ATTACK ON COUNTING: a second call for the same host increments seen_count once (2), keeps first_seen_at,
-- moves last_seen_at forward and keeps the earlier name when the second caller gave none; a host with a scheme, an upper-case letter, a www. prefix or a blank reason, and a seen_count of 0, are each refused. THE ATTACK ON ACCESS:
-- as `authenticated` a non-admin reads nothing, cannot insert, and cannot execute record_host_worklist; a platform admin reads the row; anon holds nothing. THE ATTACK ON CLOSING: a verdict for the host removes its
-- worklist row in the same statement, a verdict for another host leaves it.
DO $$
DECLARE uid uuid := gen_random_uuid(); n int; first_at timestamptz; last_at timestamptz;
BEGIN
  IF (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'host_worklist') <> 'first_seen_at,host,last_name,last_seen_at,reason,seen_count' THEN
    RAISE EXCEPTION '0064-host-worklist: unexpected columns';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.host_worklist'::regclass) THEN RAISE EXCEPTION '0064-host-worklist: RLS is off'; END IF;
  IF has_table_privilege('anon', 'public.host_worklist', 'SELECT') OR has_table_privilege('authenticated', 'public.host_worklist', 'INSERT') OR has_table_privilege('authenticated', 'public.host_worklist', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.host_worklist', 'DELETE') OR NOT has_table_privilege('service_role', 'public.host_worklist', 'INSERT')
     OR has_function_privilege('anon', 'public.record_host_worklist(text,text,text)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.record_host_worklist(text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.record_host_worklist(text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0064-host-worklist: unexpected privileges';
  END IF;
  BEGIN
    IF public.record_host_worklist('unplaced.example', 'no class', 'Unplaced Org') <> 1 THEN RAISE EXCEPTION '0064-host-worklist: the first call did not write seen_count 1'; END IF;
    UPDATE public.host_worklist SET first_seen_at = first_seen_at - interval '1 day', last_seen_at = last_seen_at - interval '1 day' WHERE host = 'unplaced.example';
    SELECT first_seen_at, last_seen_at INTO first_at, last_at FROM public.host_worklist WHERE host = 'unplaced.example';
    IF public.record_host_worklist('unplaced.example', 'no class', NULL) <> 2 THEN RAISE EXCEPTION '0064-host-worklist: a second call did not increment seen_count once'; END IF;
    IF (SELECT first_seen_at FROM public.host_worklist WHERE host = 'unplaced.example') <> first_at THEN RAISE EXCEPTION '0064-host-worklist: first_seen_at moved'; END IF;
    IF (SELECT last_seen_at FROM public.host_worklist WHERE host = 'unplaced.example') <= last_at THEN RAISE EXCEPTION '0064-host-worklist: last_seen_at did not move forward'; END IF;
    IF (SELECT last_name FROM public.host_worklist WHERE host = 'unplaced.example') <> 'Unplaced Org' THEN RAISE EXCEPTION '0064-host-worklist: a call with no name erased the earlier one'; END IF;
    BEGIN PERFORM public.record_host_worklist('https://scheme.example', 'x', NULL); RAISE EXCEPTION '0064-host-worklist: a host with a scheme was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.record_host_worklist('Upper.Example', 'x', NULL); RAISE EXCEPTION '0064-host-worklist: an upper-case host was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.record_host_worklist('www.prefix.example', 'x', NULL); RAISE EXCEPTION '0064-host-worklist: a www. host was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN PERFORM public.record_host_worklist('blank.example', '  ', NULL); RAISE EXCEPTION '0064-host-worklist: a blank reason was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.host_worklist SET seen_count = 0 WHERE host = 'unplaced.example'; RAISE EXCEPTION '0064-host-worklist: a seen_count of 0 was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    INSERT INTO auth.users (id, email) VALUES (uid, 'selfcheck-0064@invalid.example');
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', uid::text, true);
    SELECT count(*) INTO n FROM public.host_worklist;
    IF n <> 0 THEN RESET ROLE; RAISE EXCEPTION '0064-host-worklist: a non-admin read % worklist rows', n; END IF;
    BEGIN INSERT INTO public.host_worklist (host, reason) VALUES ('forged.example', 'x'); RESET ROLE; RAISE EXCEPTION '0064-host-worklist: a non-admin wrote a worklist row';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN PERFORM public.record_host_worklist('forged.example', 'x', NULL); RESET ROLE; RAISE EXCEPTION '0064-host-worklist: a non-admin executed record_host_worklist';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
    INSERT INTO public.profiles (id, email, is_platform_admin) VALUES (uid, 'selfcheck-0064@invalid.example', true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO n FROM public.host_worklist;
    RESET ROLE;
    IF n <> 1 THEN RAISE EXCEPTION '0064-host-worklist: a platform admin read % worklist rows, expected 1', n; END IF;
    PERFORM public.record_host_worklist('other.example', 'no class', NULL);
    INSERT INTO public.host_verdicts (host, class, reason, batch_id, ruled_by) VALUES ('unplaced.example', 'association', 'the maker''s trade body', 'host-verdicts-001', 'session-lane');
    IF EXISTS (SELECT 1 FROM public.host_worklist WHERE host = 'unplaced.example') THEN RAISE EXCEPTION '0064-host-worklist: a verdict left its host on the worklist'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.host_worklist WHERE host = 'other.example') THEN RAISE EXCEPTION '0064-host-worklist: a verdict for one host closed another'; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0064-host-worklist OK';
END $$;

COMMIT;
