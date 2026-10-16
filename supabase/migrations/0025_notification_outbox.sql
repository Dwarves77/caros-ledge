-- 0025 notification_outbox (P2-S3, owed by IMPROVEMENTS IMP-025, accepted by the operator 2026-10-16).
--
-- Archive and assignment notifications were best effort: a failed send was counted in the response and then lost. A write that must notify
-- now inserts one outbox row per recipient (the same transaction boundary as the write it belongs to, in P2-02b) and a drain kind in
-- P2-07 sends them, retrying a failure with its attempts and last_error recorded. This migration is the table only; the writers switch in
-- P2-02b and the drain kind is P2-07's.
--   id uuid, user_id (the recipient; the row goes with the account), kind text (non-blank; the vocabulary belongs to the drain), payload
--   jsonb (what the notification says), attempts int, last_error text, status pending | sent | failed, created_at, sent_at.
--   A row is `sent` exactly when it has a sent_at. Index (status, created_at) serves the drain's oldest-pending read; an index on user_id
--   serves the foreign key.
-- RLS on, no policy: service_role only (INV-139). Not applied to production before the cutover window.
--
-- Reversal: DROP TABLE public.notification_outbox.

-- catalog: relation, column, constraint, index, acl

BEGIN;

CREATE TABLE public.notification_outbox (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts int NOT NULL DEFAULT 0,
  last_error text,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT notification_outbox_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT notification_outbox_status_check CHECK (status IN ('pending', 'sent', 'failed')),
  CONSTRAINT notification_outbox_kind_check CHECK (length(btrim(kind)) > 0),
  CONSTRAINT notification_outbox_attempts_check CHECK (attempts >= 0),
  CONSTRAINT notification_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT notification_outbox_sent_consistency CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
ALTER TABLE public.notification_outbox ADD CONSTRAINT notification_outbox_pkey PRIMARY KEY (id);
CREATE INDEX notification_outbox_status_created_idx ON public.notification_outbox (status, created_at);
CREATE INDEX notification_outbox_user_id_idx ON public.notification_outbox (user_id);

COMMENT ON TABLE public.notification_outbox IS 'Retryable notifications, one row per recipient (P2-S3 migration 0025). Written by the workspace writers, drained by the notification-outbox drain kind (P2-07); service_role only.';

ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.notification_outbox TO service_role;

-- Self-check 0025-notification-outbox: shape and access, then attacks in a fixture that rolls back: a status outside the vocabulary, a blank
-- kind, a non-object payload, a negative attempt count and a sent row with no sent_at are each refused; a clean row defaults to pending with
-- 0 attempts; deleting the user removes the row; and as `authenticated` the table cannot be read or written (RLS on, no grant, no policy).
DO $$
DECLARE u uuid := gen_random_uuid(); oid_ uuid; st text; att int;
BEGIN
  IF (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'notification_outbox')
     <> 'attempts,created_at,id,kind,last_error,payload,sent_at,status,user_id' THEN
    RAISE EXCEPTION '0025-notification-outbox: unexpected columns';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.notification_outbox'::regclass) THEN RAISE EXCEPTION '0025-notification-outbox: RLS is off'; END IF;
  IF has_table_privilege('anon', 'public.notification_outbox', 'SELECT') OR has_table_privilege('authenticated', 'public.notification_outbox', 'SELECT')
     OR has_table_privilege('authenticated', 'public.notification_outbox', 'INSERT') THEN
    RAISE EXCEPTION '0025-notification-outbox: a client role holds a privilege';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.notification_outbox', 'INSERT') THEN RAISE EXCEPTION '0025-notification-outbox: service_role cannot write'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'notification_outbox_status_created_idx' AND indexdef LIKE '%(status, created_at)%') THEN
    RAISE EXCEPTION '0025-notification-outbox: the (status, created_at) index is missing';
  END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (u, 'selfcheck-0025@invalid.example');
    INSERT INTO public.notification_outbox (user_id, kind, payload) VALUES (u, 'archive', '{"title":"x"}') RETURNING id, status, attempts INTO oid_, st, att;
    IF st <> 'pending' OR att <> 0 THEN RAISE EXCEPTION '0025-notification-outbox: a new row is % with % attempts', st, att; END IF;
    BEGIN INSERT INTO public.notification_outbox (user_id, kind, status) VALUES (u, 'archive', 'done'); RAISE EXCEPTION '0025-notification-outbox: a status outside the vocabulary was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.notification_outbox (user_id, kind) VALUES (u, '  '); RAISE EXCEPTION '0025-notification-outbox: a blank kind was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.notification_outbox (user_id, kind, payload) VALUES (u, 'archive', '[]'); RAISE EXCEPTION '0025-notification-outbox: an array payload was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.notification_outbox (user_id, kind, attempts) VALUES (u, 'archive', -1); RAISE EXCEPTION '0025-notification-outbox: negative attempts were accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.notification_outbox (user_id, kind, status) VALUES (u, 'archive', 'sent'); RAISE EXCEPTION '0025-notification-outbox: a sent row with no sent_at was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.notification_outbox (user_id, kind, sent_at) VALUES (u, 'archive', now()); RAISE EXCEPTION '0025-notification-outbox: a pending row with a sent_at was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    SET LOCAL ROLE authenticated;
    BEGIN PERFORM 1 FROM public.notification_outbox; RAISE EXCEPTION '0025-notification-outbox: authenticated read the outbox';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    BEGIN INSERT INTO public.notification_outbox (user_id, kind) VALUES (u, 'forged'); RAISE EXCEPTION '0025-notification-outbox: authenticated wrote the outbox';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
    DELETE FROM auth.users WHERE id = u;
    IF EXISTS (SELECT 1 FROM public.notification_outbox WHERE id = oid_) THEN RAISE EXCEPTION '0025-notification-outbox: the row outlived its user'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0025-notification-outbox OK';
END $$;

COMMIT;
