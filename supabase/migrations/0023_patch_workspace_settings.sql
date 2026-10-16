-- 0023 patch_workspace_settings (P2-S3, owed by IMPROVEMENTS IMP-023).
--
-- INV-168: every writer of a workspace_settings jsonb column patches it key-wise, never replaces it. The code did that with a read, a merge in
-- JavaScript and a compare-and-swap on updated_at, retried up to five times. One UPDATE does the same merge atomically: under READ COMMITTED
-- a second writer waits for the row lock and merges over the first writer's committed value, so two writers of different keys lose nothing
-- and no retry exists.
--   * SECURITY INVOKER: the caller's own RLS (settings_update_admin) decides who may write; the function adds no privilege. A caller who may
--     not write, or an org with no settings row, changes nothing and gets NULL back.
--   * The column is one of the five jsonb columns, checked against a list inside the function (the dynamic column name never reaches
--     format() unvalidated); the patch must be a jsonb object; the merge is top-level (`||`), as the code's spread was.
--   * A NULL or non-object stored value (jurisdiction_weights is nullable) merges over {}.
-- Returns the merged value stored. Not applied to production before the cutover window.
--
-- Reversal: DROP FUNCTION public.patch_workspace_settings(uuid, text, jsonb).

-- catalog: function

BEGIN;

CREATE FUNCTION public.patch_workspace_settings(p_org_id uuid, p_column text, p_patch jsonb) RETURNS jsonb
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp
  AS $$
DECLARE v jsonb;
BEGIN
  IF p_column IS NULL OR p_column NOT IN ('profile', 'alert_config', 'home_sections', 'default_filters', 'jurisdiction_weights') THEN
    RAISE EXCEPTION '% is not a patchable workspace setting', p_column USING ERRCODE = '22023';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'the patch must be a json object of keys to change' USING ERRCODE = '22023';
  END IF;
  EXECUTE format('UPDATE public.workspace_settings SET %1$I = (CASE WHEN jsonb_typeof(%1$I) = ''object'' THEN %1$I ELSE ''{}''::jsonb END) || $1 WHERE org_id = $2 RETURNING %1$I', p_column)
    INTO v USING p_patch, p_org_id;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION public.patch_workspace_settings(uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.patch_workspace_settings(uuid, text, jsonb) TO authenticated, service_role;

-- Self-check 0023-patch-settings: as an org admin (role authenticated, RLS on) two patches of different keys both survive and a re-patched key
-- changes; a nullable column merges over {}; a non-admin member of the same org changes nothing and gets NULL; an unknown column, a column
-- outside the list (org_id) and a non-object patch are refused; an org with no settings row returns NULL.
DO $$
DECLARE
  org uuid := gen_random_uuid(); admin uuid := gen_random_uuid(); member uuid := gen_random_uuid(); v jsonb;
BEGIN
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (admin, 'admin-0023@invalid.example'), (member, 'member-0023@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (admin, 'admin-0023@invalid.example'), (member, 'member-0023@invalid.example');
    INSERT INTO public.organizations (id, name, slug) VALUES (org, 'selfcheck-0023', 'selfcheck-0023-' || org);
    INSERT INTO public.org_memberships (org_id, user_id, role) VALUES (org, admin, 'admin'), (org, member, 'member');
    INSERT INTO public.workspace_settings (org_id, alert_config) VALUES (org, '{"priorities":["CRITICAL"]}');
    SET LOCAL ROLE authenticated;
    PERFORM set_config('request.jwt.claim.sub', admin::text, true);
    v := public.patch_workspace_settings(org, 'alert_config', '{"briefingCadence":"weekly"}');
    v := public.patch_workspace_settings(org, 'alert_config', '{"briefingDay":"friday","briefingCadence":"daily"}');
    IF v IS DISTINCT FROM '{"priorities":["CRITICAL"],"briefingCadence":"daily","briefingDay":"friday"}'::jsonb THEN
      RAISE EXCEPTION '0023-patch-settings: key-wise merge lost or kept the wrong keys: %', v;
    END IF;
    v := public.patch_workspace_settings(org, 'jurisdiction_weights', '{"US":2}');
    IF v IS DISTINCT FROM '{"US":2}'::jsonb THEN RAISE EXCEPTION '0023-patch-settings: a NULL column did not merge over {}: %', v; END IF;
    PERFORM set_config('request.jwt.claim.sub', member::text, true);
    v := public.patch_workspace_settings(org, 'alert_config', '{"forged":true}');
    IF v IS NOT NULL THEN RAISE EXCEPTION '0023-patch-settings: a non-admin member patched the settings: %', v; END IF;
    PERFORM set_config('request.jwt.claim.sub', admin::text, true);
    IF (SELECT alert_config ? 'forged' FROM public.workspace_settings WHERE org_id = org) THEN RAISE EXCEPTION '0023-patch-settings: the forged key is stored'; END IF;
    IF public.patch_workspace_settings(gen_random_uuid(), 'profile', '{"a":1}') IS NOT NULL THEN RAISE EXCEPTION '0023-patch-settings: an org with no settings row returned a value'; END IF;
    BEGIN
      PERFORM public.patch_workspace_settings(org, 'org_id', '{"a":1}');
      RAISE EXCEPTION '0023-patch-settings: a column outside the list was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    BEGIN
      PERFORM public.patch_workspace_settings(org, 'profile', '["a"]');
      RAISE EXCEPTION '0023-patch-settings: an array patch was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    BEGIN
      PERFORM public.patch_workspace_settings(org, 'profile"; DROP TABLE x; --', '{"a":1}');
      RAISE EXCEPTION '0023-patch-settings: an injected column name was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    RESET ROLE;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF has_function_privilege('anon', 'public.patch_workspace_settings(uuid,text,jsonb)', 'EXECUTE') THEN RAISE EXCEPTION '0023-patch-settings: anon can execute it'; END IF;
  RAISE NOTICE '0023-patch-settings OK';
END $$;

COMMIT;
