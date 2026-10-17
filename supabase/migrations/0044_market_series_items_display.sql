-- 0044 market_series_items display fields (P2-S4, IMP-084 follow-up: the producers read the table, not the code file).
--
-- The code file src/features/market/producers/data/series-item-map.json carried three more fields per attachment than market_series_items (0029) holds: cadence_days (the interval to the next release, 7 for every EU Oil
-- Bulletin series), context_line (the line under the figure) and severity_tone (its tone). The published-price-statistics producer derives next_release_at, context_line and severity_tone from them, so reading the table
-- instead of the file loses those three unless the table carries them. They are added here, nullable, with the same bounds the file's schema had (cadence a positive number of days; tone one of the five the producer
-- writes). The six existing attachments get cadence_days = 7 from 0045 (a data migration, run after 0030).
--
-- Not applied to production before the cutover window.
--
-- Reversal: ALTER TABLE public.market_series_items DROP COLUMN cadence_days, DROP COLUMN context_line, DROP COLUMN severity_tone.

-- catalog: column, constraint

BEGIN;

ALTER TABLE public.market_series_items
  ADD COLUMN cadence_days int,
  ADD COLUMN context_line text,
  ADD COLUMN severity_tone text,
  ADD CONSTRAINT market_series_items_cadence_days_check CHECK (cadence_days IS NULL OR cadence_days > 0),
  ADD CONSTRAINT market_series_items_severity_tone_check CHECK (severity_tone IS NULL OR severity_tone IN ('critical', 'high', 'moderate', 'low', 'neutral'));

-- Self-check 0044-market-series-display: attacks in a fixture that rolls back: a zero or negative cadence and a tone outside the five are refused; a row with none of the three reads back null; a row with all three
-- reads back as written; the signed-in role reads the new columns and still cannot write them.
DO $$
DECLARE it uuid; c int; t text; l text; n int;
BEGIN
  BEGIN
    INSERT INTO public.intelligence_items (title, domain) VALUES ('selfcheck-0044', 4) RETURNING id INTO it;
    BEGIN INSERT INTO public.market_series_items (series_key, item_id, status, cadence_days) VALUES ('a:zero', it, 'ratified', 0); RAISE EXCEPTION '0044-market-series-display: a zero cadence was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.market_series_items (series_key, item_id, status, cadence_days) VALUES ('a:neg', it, 'ratified', -7); RAISE EXCEPTION '0044-market-series-display: a negative cadence was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.market_series_items (series_key, item_id, status, severity_tone) VALUES ('a:tone', it, 'ratified', 'urgent'); RAISE EXCEPTION '0044-market-series-display: a tone outside the five was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    INSERT INTO public.market_series_items (series_key, item_id, status) VALUES ('a:bare', it, 'ratified');
    SELECT cadence_days, severity_tone, context_line INTO c, t, l FROM public.market_series_items WHERE series_key = 'a:bare';
    IF c IS NOT NULL OR t IS NOT NULL OR l IS NOT NULL THEN RAISE EXCEPTION '0044-market-series-display: a row with none of the fields did not read back null'; END IF;
    INSERT INTO public.market_series_items (series_key, item_id, status, cadence_days, context_line, severity_tone) VALUES ('a:full', it, 'ratified', 7, 'weekly pump price', 'moderate');
    SELECT cadence_days, severity_tone, context_line INTO c, t, l FROM public.market_series_items WHERE series_key = 'a:full';
    IF c <> 7 OR t <> 'moderate' OR l <> 'weekly pump price' THEN RAISE EXCEPTION '0044-market-series-display: the fields did not read back as written'; END IF;
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO n FROM public.market_series_items WHERE series_key = 'a:full' AND cadence_days = 7;
    IF n <> 1 THEN RESET ROLE; RAISE EXCEPTION '0044-market-series-display: authenticated cannot read the new columns'; END IF;
    BEGIN UPDATE public.market_series_items SET cadence_days = 1 WHERE series_key = 'a:full'; RESET ROLE; RAISE EXCEPTION '0044-market-series-display: authenticated wrote a new column';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0044-market-series-display OK';
END $$;

COMMIT;
