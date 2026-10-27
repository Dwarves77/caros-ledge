-- 0143 obligation_due_date_precision: an obligation object's due_date states the precision its quote supports, day, month or year (ENGINE-CORE-FIX-1, G3).
-- change: obligation_objects.due_date_precision text NOT NULL DEFAULT 'day' CHECK (day, month, year), the same precision rule item_forward_events already carries
--
-- Before: obligation_objects.due_date is a date, so a mandate the source dates "in 2027" had to be stored as 2027-01-01 and read as a day. The pattern detectors compare that day with a capacity's day and report a gap in months from a date the
-- source never stated. item_forward_events.date_precision (day | month | year) already says how precise an event date is; the object's due_date had no such column.
-- After: due_date_precision says it. A month or year value is stored normalised (the first of the month, or 1 January) and the reader contract requires the quote to state it at that precision and the most precise date the quote states (D1).
-- Every existing row takes 'day': the column defaults, and no row changes meaning (the live self-check below reads the table to prove it: no existing row with a due date carries anything but 'day').
--
-- Access and shape: a plain column on a table whose policies, grants and triggers do not name it; nothing else is touched. Reversal: down/0143.sql drops the column and its constraint.

-- catalog: column, constraint

BEGIN;

ALTER TABLE public.obligation_objects
  ADD COLUMN due_date_precision text NOT NULL DEFAULT 'day'
  CONSTRAINT obligation_objects_due_date_precision_values CHECK (due_date_precision IN ('day', 'month', 'year'));

COMMENT ON COLUMN public.obligation_objects.due_date_precision IS 'Migration 0143. How precise due_date is: day, month (stored as the first of the month) or year (stored as 1 January). The quote states the date at that precision.';

-- Self-check 0143-due-date-precision: the column's shape (text, NOT NULL, default day); the live table (the rows production holds all took the default, none changed meaning); and, on a scratch copy of the table's own constraints and defaults (a temp table made
-- LIKE the real one, so the real CHECK is what is attacked), the attacks: an unknown precision is refused as a check violation, the three allowed values are accepted, and an omitted precision is 'day'.
DO $$
DECLARE
  total bigint; dated bigint; off bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'obligation_objects' AND column_name = 'due_date_precision'
                   AND data_type = 'text' AND is_nullable = 'NO' AND column_default LIKE '''day''%') THEN
    RAISE EXCEPTION '0143-due-date-precision: the column is not text NOT NULL DEFAULT ''day''';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.obligation_objects'::regclass AND conname = 'obligation_objects_due_date_precision_values' AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION '0143-due-date-precision: the CHECK constraint is not in place and validated';
  END IF;

  -- The live table: read, not assumed. Every row that existed took the default.
  SELECT count(*), count(*) FILTER (WHERE due_date IS NOT NULL), count(*) FILTER (WHERE due_date_precision <> 'day') INTO total, dated, off FROM public.obligation_objects;
  IF off <> 0 THEN
    RAISE EXCEPTION '0143-due-date-precision: % of % live row(s) (% dated) carry a precision other than day after the migration', off, total, dated;
  END IF;

  -- The attacks, against the real table definition's own constraints.
  CREATE TEMP TABLE selfcheck_0143 (LIKE public.obligation_objects INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP;
  BEGIN
    INSERT INTO selfcheck_0143 (obligation_id, instrument_item_id, pinpoint_citation, verbatim_text, binding_position, duty_holder_class, applicability_trigger, capture_id, due_date, due_date_precision)
    VALUES ('cl:obligation:000000000000143a', gen_random_uuid(), 'Article 1', 'x', 'direct_duty', ARRAY['operator'], '{"attribute":"a","value":"b"}'::jsonb, gen_random_uuid(), DATE '2027-01-01', 'week');
    RAISE EXCEPTION '0143-due-date-precision: the precision "week" was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  INSERT INTO selfcheck_0143 (obligation_id, instrument_item_id, pinpoint_citation, verbatim_text, binding_position, duty_holder_class, applicability_trigger, capture_id, due_date, due_date_precision)
  VALUES ('cl:obligation:000000000000143b', gen_random_uuid(), 'Article 1', 'x', 'direct_duty', ARRAY['operator'], '{"attribute":"a","value":"b"}'::jsonb, gen_random_uuid(), DATE '2027-01-01', 'year'),
         ('cl:obligation:000000000000143c', gen_random_uuid(), 'Article 2', 'x', 'direct_duty', ARRAY['operator'], '{"attribute":"a","value":"b"}'::jsonb, gen_random_uuid(), DATE '2027-06-01', 'month'),
         ('cl:obligation:000000000000143d', gen_random_uuid(), 'Article 3', 'x', 'direct_duty', ARRAY['operator'], '{"attribute":"a","value":"b"}'::jsonb, gen_random_uuid(), DATE '2027-06-15', 'day');
  INSERT INTO selfcheck_0143 (obligation_id, instrument_item_id, pinpoint_citation, verbatim_text, binding_position, duty_holder_class, applicability_trigger, capture_id)
  VALUES ('cl:obligation:000000000000143e', gen_random_uuid(), 'Article 4', 'x', 'direct_duty', ARRAY['operator'], '{"attribute":"a","value":"b"}'::jsonb, gen_random_uuid());
  IF (SELECT due_date_precision FROM selfcheck_0143 WHERE obligation_id = 'cl:obligation:000000000000143e') <> 'day' THEN
    RAISE EXCEPTION '0143-due-date-precision: an omitted precision is not day';
  END IF;
  IF (SELECT count(*) FROM selfcheck_0143 WHERE due_date_precision IN ('year', 'month', 'day')) <> 4 THEN
    RAISE EXCEPTION '0143-due-date-precision: an allowed precision was not accepted';
  END IF;
  DROP TABLE selfcheck_0143;
  RAISE NOTICE '0143-due-date-precision OK';
END
$$;

COMMIT;
