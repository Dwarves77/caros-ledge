-- 0094 item_timelines.date_precision: how exact a milestone date is (R2d, MASTER I7, register flywheel:12).
--
-- The timeline writer stored the PERIOD START for a year, a month, a quarter, a half, "early 2027" or a range (2027 became 2027-01-01) and kept the real precision only in the label text. The list row and the
-- detail timeline then drew "Jan 1, 2027" and a day count to it, and the urgency band was classified from a day nobody wrote. The column says what the date is:
--   day | qualified (a day with a qualifier: "by 30 June 2027")   an exact day: the only precisions a due-date count may be drawn from
--   month | quarter | half | year | segment (early, mid, late) | range   a period start: sorts the row, is shown as a month or a year, and is never counted down to
-- NOT NULL, default 'day' (what the writer stored for an exact date, which carried no token in its label). A row written before the column keeps the period start and its token in the label ("2027 - Entry into
-- force"): the backfill reads the precision back from that token with the same shapes the writer produced. The tokens are parsed once, in this file's function, which lives only in the migration's session.
-- Reversal: ALTER TABLE public.item_timelines DROP COLUMN date_precision.
-- Not applied to production before the cutover window.

-- catalog: column, constraint

BEGIN;

ALTER TABLE public.item_timelines ADD COLUMN date_precision text NOT NULL DEFAULT 'day';
ALTER TABLE public.item_timelines ADD CONSTRAINT item_timelines_date_precision_check CHECK (date_precision = ANY (ARRAY['day', 'qualified', 'month', 'quarter', 'half', 'year', 'segment', 'range']));
COMMENT ON COLUMN public.item_timelines.date_precision IS 'How exact milestone_date is (migration 0094): day or qualified is a real day; month, quarter, half, year, segment and range are a period start that sorts the row and is never counted down to.';

CREATE FUNCTION pg_temp.timeline_precision_of(p_label text) RETURNS text
  LANGUAGE sql IMMUTABLE
  AS $$
  WITH t AS (SELECT lower(substring(p_label from '^(.+?) (?:—|-) ')) AS token),
       q AS (SELECT token, regexp_replace(token, '^(by|from|until|before|after|effective|starting|beginning|end of|deadline) ', '') AS inner_token FROM t WHERE token IS NOT NULL)
  SELECT CASE
           WHEN token ~ ' (to|through|–|—) ' THEN 'range'
           WHEN inner_token ~ '^(early|mid|late)[ -][0-9]{4}$' THEN 'segment'
           WHEN inner_token ~ '^[0-9]{4}$' THEN 'year'
           WHEN inner_token ~ '^q[1-4] [0-9]{4}$' THEN 'quarter'
           WHEN inner_token ~ '^h[12] [0-9]{4}$' THEN 'half'
           WHEN inner_token ~ '^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? [0-9]{4}$' OR inner_token ~ '^[0-9]{4}-[0-9]{1,2}$' THEN 'month'
           WHEN inner_token <> token AND (inner_token ~ '^[0-9]{1,2}(st|nd|rd|th)? [a-z]+\.?,? [0-9]{4}$' OR inner_token ~ '^[a-z]+\.? [0-9]{1,2}(st|nd|rd|th)?,? [0-9]{4}$' OR inner_token ~ '^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$') THEN 'qualified'
         END
    FROM q
$$;

UPDATE public.item_timelines SET date_precision = pg_temp.timeline_precision_of(label) WHERE pg_temp.timeline_precision_of(label) IS NOT NULL;

-- Self-check 0094-item-timelines-date-precision: the column defaults to day and refuses a precision the writer does not produce; the backfill reads each token shape the writer put in a label back to its
-- precision (a year, a month in words and as digits, a quarter, a half, early/mid/late, a range, a qualified day) and leaves an ordinary label alone, even one with a dash in it.
DO $$
DECLARE
  tag text := 'selfcheck-0094'; iid uuid; got text; bad boolean := false; probe record;
BEGIN
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES (tag || ' item', 1, 'verified', false) RETURNING id INTO iid;
    INSERT INTO public.item_timelines (item_id, milestone_date, label) VALUES (iid, '2027-06-30', tag || ' exact');
    SELECT date_precision INTO got FROM public.item_timelines WHERE item_id = iid;
    IF got <> 'day' THEN RAISE EXCEPTION '0094-item-timelines-date-precision: the default is %, expected day', got; END IF;
    BEGIN
      INSERT INTO public.item_timelines (item_id, milestone_date, label, date_precision) VALUES (iid, '2027-01-01', tag || ' made up', 'soon');
    EXCEPTION WHEN check_violation THEN bad := true;
    END;
    IF NOT bad THEN RAISE EXCEPTION '0094-item-timelines-date-precision: a made-up precision was accepted'; END IF;
    FOR probe IN SELECT * FROM (VALUES
      ('2027 — Entry into force', 'year'), ('Q3 2027 — Reporting opens', 'quarter'), ('H2 2027 - Review', 'half'), ('late 2027 — Phase-in', 'segment'), ('Early 2027 — Consultation', 'segment'),
      ('March 2027 — Delegated act', 'month'), ('Mar 2027 - Guidance', 'month'), ('2027-03 — Guidance', 'month'), ('1 January 2027 to 30 June 2027 — Window', 'range'),
      ('by 30 June 2027 — Filing', 'qualified'), ('before 2027 — Filing', 'year'), ('Adopted by the Council - second reading', NULL), ('Entry into force', NULL), ('Rate review — year two', NULL)
    ) AS v(lbl, want) LOOP
      got := pg_temp.timeline_precision_of(probe.lbl);
      IF got IS DISTINCT FROM probe.want THEN RAISE EXCEPTION '0094-item-timelines-date-precision: the label "%" reads as %, expected %', probe.lbl, coalesce(got, 'nothing'), coalesce(probe.want, 'nothing'); END IF;
    END LOOP;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0094-item-timelines-date-precision OK';
END $$;

COMMIT;
