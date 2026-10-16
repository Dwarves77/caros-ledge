-- 0018 invitation tokens stored hashed (P2-S3, owed by IMPROVEMENTS IMP-009, accepted by the operator 2026-10-16).
--
-- Before: org_invitations.token held the bearer credential in clear (32 random bytes as hex); a read of the table, a backup or a log of the
-- row yielded a usable invite link, and `invitations/mine` returned it. After: the table holds only sha256(token) as token_hash and the
-- last four characters as token_last4 (what an admin list or `mine` may show). The raw token exists in exactly one place, the request that
-- creates the invitation: it generates the token, inserts it as token_input, and returns the link once.
--   * token_input is a write-only transit column. The BEFORE INSERT trigger org_invitations_hash_token refuses a missing or malformed
--     token, writes token_hash and token_last4, and sets token_input to NULL before the row is stored; a CHECK (token_input IS NULL)
--     makes a stored raw value impossible even if the trigger is disabled or replaced.
--   * invitation_token_hash(text) is the one home of the hash; lookup_invitation, accept_invitation and decline_invitation match on it
--     (the token is lower-cased first: the link is hex, so a case-mangled copy still resolves). Their bodies are otherwise unchanged.
--   * Existing rows are hashed in place from their plain token, then the plain column (and its unique constraint) is dropped, so a
--     pending invitation issued before the cutover keeps working with the same link.
-- Not applied to production before the cutover window (the old tree reads org_invitations.token).
--
-- Reversal: not reversible for rows created after the change (the raw token is gone by design). For the rows that exist at the cutover:
-- ADD COLUMN token text and set it from a backup; restore the three rpc bodies from supabase/schema.sql; drop the trigger and the
-- helper; drop token_hash, token_last4 and token_input.

-- catalog: column, constraint, index, trigger, function

BEGIN;

CREATE FUNCTION public.invitation_token_hash(p_token text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT SET search_path = public, pg_temp
  AS $$ SELECT encode(sha256(convert_to(lower(p_token), 'UTF8')), 'hex') $$;
REVOKE ALL ON FUNCTION public.invitation_token_hash(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invitation_token_hash(text) TO service_role;

ALTER TABLE public.org_invitations ADD COLUMN token_hash text, ADD COLUMN token_last4 text, ADD COLUMN token_input text;
UPDATE public.org_invitations SET token_hash = public.invitation_token_hash(token), token_last4 = right(token, 4);
ALTER TABLE public.org_invitations
  ALTER COLUMN token_hash SET NOT NULL,
  ALTER COLUMN token_last4 SET NOT NULL,
  ADD CONSTRAINT org_invitations_token_hash_key UNIQUE (token_hash),
  ADD CONSTRAINT org_invitations_token_input_unstored CHECK (token_input IS NULL),
  ADD CONSTRAINT org_invitations_token_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$' AND length(token_last4) = 4),
  DROP COLUMN token;

COMMENT ON COLUMN public.org_invitations.token_hash IS 'sha256 (hex) of the invitation token. The raw token is never stored: the creating request generates it, returns the link once, and inserts it as token_input, which the BEFORE INSERT trigger hashes and clears (P2-S3 migration 0018).';
COMMENT ON COLUMN public.org_invitations.token_last4 IS 'The last four characters of the token, the only part a list may show.';
COMMENT ON COLUMN public.org_invitations.token_input IS 'Write-only transit for the raw token on INSERT. Always NULL at rest (CHECK org_invitations_token_input_unstored).';

CREATE FUNCTION public.org_invitations_hash_token() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NEW.token_input IS NULL OR NEW.token_input !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'an invitation needs a token of 64 lowercase hex characters' USING ERRCODE = '22023';
  END IF;
  NEW.token_hash := public.invitation_token_hash(NEW.token_input);
  NEW.token_last4 := right(NEW.token_input, 4);
  NEW.token_input := NULL;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.org_invitations_hash_token() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER org_invitations_hash_token_trg BEFORE INSERT ON public.org_invitations FOR EACH ROW EXECUTE FUNCTION public.org_invitations_hash_token();

CREATE OR REPLACE FUNCTION public.lookup_invitation(p_token text) RETURNS TABLE(id uuid, org_id uuid, org_name text, invited_email text, proposed_role text, status text, created_at timestamp with time zone, expires_at timestamp with time zone, is_expired boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  SELECT
    inv.id,
    inv.org_id,
    o.name AS org_name,
    inv.invited_email,
    inv.proposed_role,
    CASE WHEN inv.status = 'pending' AND inv.expires_at <= now() THEN 'expired' ELSE inv.status END AS status,
    inv.created_at,
    inv.expires_at,
    (inv.expires_at <= now()) AS is_expired
  FROM public.org_invitations inv
  JOIN public.organizations o ON o.id = inv.org_id
  WHERE inv.token_hash = public.invitation_token_hash(p_token);
$$;

CREATE OR REPLACE FUNCTION public.accept_invitation(p_token text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_invitation public.org_invitations;
  v_caller_id  uuid;
  v_caller_email text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT lower(u.email) INTO v_caller_email
  FROM auth.users u WHERE u.id = v_caller_id;
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'Caller email not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_invitation
  FROM public.org_invitations
  WHERE token_hash = public.invitation_token_hash(p_token)
  FOR UPDATE;

  IF v_invitation IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is %', v_invitation.status USING ERRCODE = '22023';
  END IF;
  IF v_invitation.expires_at <= now() THEN
    UPDATE public.org_invitations SET status = 'expired' WHERE id = v_invitation.id;
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;
  IF v_invitation.invited_email <> v_caller_email THEN
    RAISE EXCEPTION 'Invitation is for a different email' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.org_member_bans b
    WHERE b.org_id = v_invitation.org_id
      AND b.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'This account is banned from the workspace' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.org_memberships (org_id, user_id, role)
  VALUES (v_invitation.org_id, v_caller_id, v_invitation.proposed_role)
  ON CONFLICT (org_id, user_id) DO UPDATE
    SET role = EXCLUDED.role
    WHERE (org_memberships.role = 'viewer' AND EXCLUDED.role IN ('member', 'admin'))
       OR (org_memberships.role = 'member' AND EXCLUDED.role = 'admin');

  UPDATE public.org_invitations
  SET status = 'accepted',
      accepted_at = now(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_invitation.id;

  RETURN v_invitation.org_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.decline_invitation(p_token text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_invitation public.org_invitations;
  v_caller_id  uuid;
  v_caller_email text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT lower(u.email) INTO v_caller_email
  FROM auth.users u WHERE u.id = v_caller_id;

  SELECT * INTO v_invitation
  FROM public.org_invitations
  WHERE token_hash = public.invitation_token_hash(p_token)
  FOR UPDATE;

  IF v_invitation IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is %', v_invitation.status USING ERRCODE = '22023';
  END IF;
  IF v_invitation.invited_email <> COALESCE(v_caller_email, '') THEN
    RAISE EXCEPTION 'Invitation is for a different email' USING ERRCODE = '42501';
  END IF;

  UPDATE public.org_invitations
  SET status = 'declined',
      declined_at = now()
  WHERE id = v_invitation.id;
END;
$$;

-- Self-check 0018-invitation-tokens: the plain column is gone; a created invitation stores no usable token anywhere in the row (the whole row
-- as jsonb is searched for the raw value); lookup, accept and decline resolve the raw token (and not the hash, and not a wrong token); a
-- missing or malformed token is refused; and the CHECK holds even with the trigger disabled (attack: a raw token planted past the trigger).
DO $$
DECLARE
  raw text := encode(sha256(convert_to('selfcheck-0018-' || clock_timestamp()::text, 'UTF8')), 'hex');
  second text := encode(sha256(convert_to('second-0018', 'UTF8')), 'hex');
  org uuid := gen_random_uuid(); inviter uuid := gen_random_uuid(); invitee uuid := gen_random_uuid();
  inv uuid; r public.org_invitations; got uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'org_invitations' AND column_name = 'token') THEN
    RAISE EXCEPTION '0018-invitation-tokens: the plain token column still exists';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'org_invitations'
         AND column_name IN ('token_hash', 'token_last4', 'token_input')) <> 3 THEN
    RAISE EXCEPTION '0018-invitation-tokens: token_hash, token_last4 or token_input is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.org_invitations WHERE token_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION '0018-invitation-tokens: a stored row has no hash';
  END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (inviter, 'inviter-0018@invalid.example'), (invitee, 'invitee-0018@invalid.example');
    INSERT INTO public.profiles (id, email) VALUES (inviter, 'inviter-0018@invalid.example'), (invitee, 'invitee-0018@invalid.example');
    INSERT INTO public.organizations (id, name, slug) VALUES (org, 'selfcheck-0018', 'selfcheck-0018-' || org);
    INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input)
      VALUES (org, 'invitee-0018@invalid.example', inviter, 'member', raw) RETURNING * INTO r;
    inv := r.id;
    IF r.token_input IS NOT NULL OR r.token_last4 <> right(raw, 4) OR r.token_hash <> encode(sha256(convert_to(raw, 'UTF8')), 'hex') THEN
      RAISE EXCEPTION '0018-invitation-tokens: the stored row is not hashed (input %, last4 %)', r.token_input, r.token_last4;
    END IF;
    IF position(raw IN (SELECT to_jsonb(i)::text FROM public.org_invitations i WHERE i.id = inv)) > 0 THEN
      RAISE EXCEPTION '0018-invitation-tokens: the raw token is readable from the row';
    END IF;
    IF (SELECT count(*) FROM public.lookup_invitation(raw)) <> 1 THEN RAISE EXCEPTION '0018-invitation-tokens: lookup by the raw token failed'; END IF;
    IF (SELECT count(*) FROM public.lookup_invitation(r.token_hash)) <> 0 THEN RAISE EXCEPTION '0018-invitation-tokens: the stored hash works as a token'; END IF;
    IF (SELECT count(*) FROM public.lookup_invitation(repeat('0', 64))) <> 0 THEN RAISE EXCEPTION '0018-invitation-tokens: a wrong token resolved'; END IF;
    BEGIN
      INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role) VALUES (org, 'x-0018@invalid.example', inviter, 'member');
      RAISE EXCEPTION '0018-invitation-tokens: an invitation without a token was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    BEGIN
      INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input) VALUES (org, 'y-0018@invalid.example', inviter, 'member', 'short');
      RAISE EXCEPTION '0018-invitation-tokens: a malformed token was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
    END;
    ALTER TABLE public.org_invitations DISABLE TRIGGER org_invitations_hash_token_trg;
    BEGIN
      INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input, token_hash, token_last4)
        VALUES (org, 'z-0018@invalid.example', inviter, 'member', raw, repeat('a', 64), 'abcd');
      RAISE EXCEPTION '0018-invitation-tokens: a raw token was stored past a disabled trigger';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    ALTER TABLE public.org_invitations ENABLE TRIGGER org_invitations_hash_token_trg;
    PERFORM set_config('request.jwt.claim.sub', invitee::text, true);
    got := public.accept_invitation(raw);
    IF got <> org OR (SELECT status FROM public.org_invitations WHERE id = inv) <> 'accepted' THEN RAISE EXCEPTION '0018-invitation-tokens: accept by the raw token failed'; END IF;
    INSERT INTO public.org_invitations (org_id, invited_email, invited_by_user_id, proposed_role, token_input)
      VALUES (org, 'invitee-0018@invalid.example', inviter, 'viewer', second) RETURNING id INTO inv;
    PERFORM public.decline_invitation(second);
    IF (SELECT status FROM public.org_invitations WHERE id = inv) <> 'declined' THEN RAISE EXCEPTION '0018-invitation-tokens: decline by the raw token failed'; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  IF (SELECT tgenabled FROM pg_trigger WHERE tgname = 'org_invitations_hash_token_trg') <> 'O' THEN
    RAISE EXCEPTION '0018-invitation-tokens: the hash trigger is not enabled';
  END IF;
  RAISE NOTICE '0018-invitation-tokens OK';
END $$;

COMMIT;
