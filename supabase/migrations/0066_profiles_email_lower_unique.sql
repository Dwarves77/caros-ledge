-- 0066 profiles_email_lower_unique (P2-15 PART A, IMP-058; the operator ruling on duplicates belongs to the window).
--
-- profiles.email is unique as typed (profiles_email_key), so two accounts can still differ only in case. 0020 added a plain index on lower(email) for the lookup; this migration makes it unique and drops the plain one it replaces
-- (the unique index serves the same equality lookup, so keeping both would be a duplicate). Applying it is AFTER THE QUERY: `supabase db query --linked -f scripts/cutover/duplicate-emails.sql` (read-only, member-safe) lists any addresses that
-- differ only in case; if it lists any, the operator rules (merge the accounts or leave the index unapplied) BEFORE this file runs, because CREATE UNIQUE INDEX refuses on a duplicate and nothing here deletes an account.
-- Not applied to production before the cutover window (supabase/migrations/APPLY.md lists it as "after the query").
--
-- Reversal: CREATE INDEX profiles_email_lower_idx ON public.profiles (lower(email)); DROP INDEX public.profiles_email_lower_key.

-- catalog: index

BEGIN;

CREATE UNIQUE INDEX profiles_email_lower_key ON public.profiles (lower(email));
DROP INDEX public.profiles_email_lower_idx;

-- Self-check 0066-email-lower-unique, in a fixture that rolls back: the unique index is on lower(email) and the plain one is gone; THE ATTACK: a second account whose address differs only in case is refused; a different address is
-- accepted; the planner still serves the equality lookup of profiles_by_email from the index.
DO $$
DECLARE def text; plan text; line text; u1 uuid := gen_random_uuid(); u2 uuid := gen_random_uuid(); u3 uuid := gen_random_uuid();
BEGIN
  SELECT indexdef INTO def FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'profiles_email_lower_key';
  IF def IS NULL OR def NOT LIKE 'CREATE UNIQUE INDEX%' OR def NOT LIKE '%(lower(email))%' THEN RAISE EXCEPTION '0066-email-lower-unique: the unique index on lower(email) is missing or wrong: %', def; END IF;
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'profiles_email_lower_idx') THEN RAISE EXCEPTION '0066-email-lower-unique: the plain index it replaces is still there'; END IF;
  SET LOCAL enable_seqscan = off;
  plan := '';
  FOR line IN EXECUTE 'EXPLAIN SELECT id FROM public.profiles WHERE lower(email) = ''selfcheck@invalid.example''' LOOP plan := plan || line || E'\n'; END LOOP;
  IF plan NOT LIKE '%profiles_email_lower_key%' THEN RAISE EXCEPTION '0066-email-lower-unique: the planner does not use the index: %', plan; END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (u1, 'Dup.Case_0066@Invalid.example'), (u2, 'dup.case_0066@invalid.example'), (u3, 'other_0066@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (u1, 'Dup.Case_0066@Invalid.example');
    BEGIN INSERT INTO public.profiles (id, email) VALUES (u2, 'dup.case_0066@invalid.example'); RAISE EXCEPTION '0066-email-lower-unique: an address differing only in case was accepted';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    INSERT INTO public.profiles (id, email) VALUES (u3, 'other_0066@invalid.example');
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0066-email-lower-unique OK';
END $$;

COMMIT;
