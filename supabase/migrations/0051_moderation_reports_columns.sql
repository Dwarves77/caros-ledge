-- 0051 moderation_reports gets the columns its three values were hidden in (P2-16, community-b register section 3 rank 2).
--
-- The table shipped with one text column, `reason`, and the old routes packed three things into it: `<reason>|<body>||action=<a>;notes=<n>`. This adds the columns the values belong in:
--   * body: the reporter's free text (at most 2000 characters);
--   * action: what the reviewer did (dismiss, warn, remove, mute, ban); null while the report is open;
--   * notes: the reviewer's note (at most 1000 characters).
-- `reason` holds the reason alone from here on (0061 splits the rows that exist). The vocabulary lives in the CHECK on action; the reason list stays in code because the old rows are not yet split.
-- Not applied to production before the cutover window.
--
-- Reversal: ALTER TABLE public.moderation_reports DROP COLUMN body, DROP COLUMN action, DROP COLUMN notes.

-- catalog: column, constraint

BEGIN;

ALTER TABLE public.moderation_reports ADD COLUMN body text, ADD COLUMN action text, ADD COLUMN notes text;
ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_action_check CHECK (action IS NULL OR action IN ('dismiss', 'warn', 'remove', 'mute', 'ban')),
  ADD CONSTRAINT moderation_reports_body_length CHECK (body IS NULL OR length(body) <= 2000),
  ADD CONSTRAINT moderation_reports_notes_length CHECK (notes IS NULL OR length(notes) <= 1000);

COMMENT ON COLUMN public.moderation_reports.body IS 'The reporter''s own words (P2-16 migration 0051); the reason column holds the reason alone.';
COMMENT ON COLUMN public.moderation_reports.action IS 'What the reviewer did when the report closed: dismiss, warn, remove, mute or ban (P2-16 migration 0051). Written only by moderate_report.';
COMMENT ON COLUMN public.moderation_reports.notes IS 'The reviewer''s note on the action (P2-16 migration 0051).';

-- Self-check 0051-moderation-columns: the three columns exist and are nullable; an action outside the vocabulary and an over-long body or note are refused; a clean report keeps its three values apart.
DO $$
DECLARE u uuid := gen_random_uuid(); rid uuid; got record;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'moderation_reports' AND column_name IN ('body', 'action', 'notes') AND is_nullable = 'YES') <> 3 THEN
    RAISE EXCEPTION '0051-moderation-columns: the three nullable columns are not all there';
  END IF;
  BEGIN
    INSERT INTO auth.users (id, email) VALUES (u, 'u-0051@invalid.example');
    INSERT INTO public.moderation_reports (target_kind, target_id, reporter_user_id, reason, body) VALUES ('post', gen_random_uuid(), u, 'spam', 'selling pricing') RETURNING id INTO rid;
    UPDATE public.moderation_reports SET status = 'resolved', action = 'warn', notes = 'told them' WHERE id = rid;
    SELECT reason, body, action, notes INTO got FROM public.moderation_reports WHERE id = rid;
    IF got.reason <> 'spam' OR got.body <> 'selling pricing' OR got.action <> 'warn' OR got.notes <> 'told them' THEN RAISE EXCEPTION '0051-moderation-columns: the values were not kept apart'; END IF;
    BEGIN UPDATE public.moderation_reports SET action = 'delete' WHERE id = rid; RAISE EXCEPTION '0051-moderation-columns: an action outside the vocabulary was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.moderation_reports SET body = repeat('x', 2001) WHERE id = rid; RAISE EXCEPTION '0051-moderation-columns: an over-long body was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.moderation_reports SET notes = repeat('x', 1001) WHERE id = rid; RAISE EXCEPTION '0051-moderation-columns: an over-long note was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0051-moderation-columns OK';
END $$;

COMMIT;
