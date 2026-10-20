-- Assertions about the FIXTURE of 0105_data_demote_legacy_verification.sql, run in the same rolled-back transaction after the file (apply-notes.json "assert"): the legacy corporate-email and linkedin marks are cleared with their
-- organisation key, the DNS proof is kept, the http avatar is cleared and the https avatar is kept.
DO $$
DECLARE m public.community_member_profiles;
BEGIN
  SELECT * INTO m FROM public.community_member_profiles WHERE user_id = '01050000-0000-4000-8000-000000000001';
  IF m.verified OR m.verified_at IS NOT NULL OR m.verification_method IS NOT NULL OR m.organisation_key IS NOT NULL THEN RAISE EXCEPTION 'data-0105 assertions: the corporate-email mark was kept: %', m; END IF;
  SELECT * INTO m FROM public.community_member_profiles WHERE user_id = '01050000-0000-4000-8000-000000000002';
  IF m.verified OR m.verification_method IS NOT NULL THEN RAISE EXCEPTION 'data-0105 assertions: the linkedin mark was kept: %', m; END IF;
  SELECT * INTO m FROM public.community_member_profiles WHERE user_id = '01050000-0000-4000-8000-000000000003';
  IF NOT m.verified OR m.verification_method <> 'domain-dns' OR m.organisation_key <> repeat('c', 64) THEN RAISE EXCEPTION 'data-0105 assertions: the DNS proof was touched: %', m; END IF;
  IF (SELECT avatar_url FROM public.profiles WHERE id = '01050000-0000-4000-8000-000000000001') IS NOT NULL THEN RAISE EXCEPTION 'data-0105 assertions: the http avatar was kept'; END IF;
  IF (SELECT avatar_url FROM public.profiles WHERE id = '01050000-0000-4000-8000-000000000003') <> 'https://img.example/a.png' THEN RAISE EXCEPTION 'data-0105 assertions: the https avatar was touched'; END IF;
  RAISE NOTICE 'data-0105 assertions OK';
END $$;
