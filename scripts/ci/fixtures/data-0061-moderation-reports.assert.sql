-- Assertions about the FIXTURE of 0061_data_moderation_reports_split.sql, run in the same rolled-back transaction after the file (apply-notes.json "assert"). The data file's own self-check asserted only that no `|` remains in any
-- reason; a wrong mapping (a body into notes, remove_post left unmapped) passed it. These name every fixture row and the fields the split must give it, and the already-split row it must leave alone.
DO $$
DECLARE r public.moderation_reports;
BEGIN
  SELECT * INTO r FROM public.moderation_reports WHERE target_id = '00610000-0000-4000-8000-0000000000a1';
  IF r.reason <> 'spam' OR r.body IS NOT NULL OR r.action IS NOT NULL OR r.notes IS NOT NULL THEN RAISE EXCEPTION 'data-0061 assertions: a bare reason changed: %', r; END IF;
  SELECT * INTO r FROM public.moderation_reports WHERE target_id = '00610000-0000-4000-8000-0000000000a2';
  IF r.reason <> 'harassment' OR r.body <> 'they keep tagging me' OR r.action IS NOT NULL OR r.notes IS NOT NULL THEN RAISE EXCEPTION 'data-0061 assertions: reason|body split wrongly: %', r; END IF;
  SELECT * INTO r FROM public.moderation_reports WHERE target_id = '00610000-0000-4000-8000-0000000000a3';
  IF r.reason <> 'misinformation' OR r.body <> 'false claim' OR r.action <> 'remove' OR r.notes <> 'removed after review' THEN RAISE EXCEPTION 'data-0061 assertions: a resolved report split wrongly: %', r; END IF;
  SELECT * INTO r FROM public.moderation_reports WHERE target_id = '00610000-0000-4000-8000-0000000000a4';
  IF r.reason <> 'other' OR r.body IS NOT NULL OR r.action <> 'dismiss' OR r.notes IS NOT NULL THEN RAISE EXCEPTION 'data-0061 assertions: a dismissed report split wrongly: %', r; END IF;
  SELECT * INTO r FROM public.moderation_reports WHERE target_id = '00610000-0000-4000-8000-0000000000a5';
  IF r.reason <> 'off-topic' OR r.body <> 'already split' OR r.action IS NOT NULL OR r.notes IS NOT NULL THEN RAISE EXCEPTION 'data-0061 assertions: the already-split row was touched: %', r; END IF;
  RAISE NOTICE 'data-0061 assertions OK';
END $$;
