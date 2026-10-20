-- 0105 DATA migration: clear the verifications and avatar addresses that 0103 no longer admits (R2e M3, register rows W:26, W:27).
--
-- A member verified before 0103 was verified because their account address was not on a list of free-mail domains: nothing was proven about the domain, so the mark said more than the system had recorded. Every verified row whose
-- method is not one the system performs now ('domain-dns', 'admin-mark') is returned to unverified (verified false, no date, no method, no organisation key); the member verifies again by the DNS proof or an admin marks them.
-- A profile avatar address that is not https is cleared (0103 admits only https and the page draws avatars from the app's own storage origin). Rows already conforming are not touched, so a second run changes nothing.
--
-- THIS IS A DATA MIGRATION. TWO-TRACK POLICY: it ships with its consumer (the Community identity and the profile form read the verified columns) and is RUN ONLY AT THE CUTOVER WINDOW, after 0103; the CI schema job never commits it, it runs
-- it once in a rolled-back transaction after the fixture named below (rule 15: the SQL is proven to execute).
--
-- Reversal: none; the cleared marks carried no proof. Members and admins re-establish them. The fixture rows are asserted by scripts/ci/fixtures/data-0105-verification.assert.sql.

-- catalog: none (data migration, not run by the schema job)
-- rollback-test: scripts/ci/fixtures/data-0105-verification.sql

BEGIN;

UPDATE public.community_member_profiles
   SET verified = false, verified_at = NULL, verification_method = NULL, organisation_key = NULL
 WHERE verified AND verification_method IS DISTINCT FROM 'domain-dns' AND verification_method IS DISTINCT FROM 'admin-mark';

UPDATE public.profiles SET avatar_url = NULL WHERE avatar_url IS NOT NULL AND avatar_url !~ '^https://[^/[:space:]]+/[^[:space:]]*$';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.community_member_profiles WHERE verified AND verification_method NOT IN ('domain-dns', 'admin-mark')) THEN RAISE EXCEPTION '0105: a verification the system did not perform remains'; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles WHERE avatar_url IS NOT NULL AND avatar_url !~ '^https://[^/[:space:]]+/[^[:space:]]*$') THEN RAISE EXCEPTION '0105: a non-https avatar remains'; END IF;
  RAISE NOTICE '0105-demote-legacy-verification OK';
END $$;

COMMIT;
