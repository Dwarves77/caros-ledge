-- Assertions about the FIXTURE of 0011_data_retier_analysis_bodies_t3.sql, run in the same rolled-back transaction after the file (apply-notes.json "assert"). The data file's own self-check counts the matching hosts off T3 across every source,
-- which on an empty CI database is zero rows and on production is the live registry; it never looked at a source on another host. These do: the four fixture sources on the four hosts moved to T3 with one history entry each,
-- and the fifth, on a host the pattern must not match, did not move at all.
DO $$
DECLARE moved int; entry jsonb;
BEGIN
  SELECT count(*) INTO moved FROM public.sources WHERE id IN ('5a5a5a5a-0000-4000-8000-0000000000b1', '5a5a5a5a-0000-4000-8000-0000000000b2', '5a5a5a5a-0000-4000-8000-0000000000b3', '5a5a5a5a-0000-4000-8000-0000000000b4') AND base_tier = 3;
  IF moved <> 4 THEN RAISE EXCEPTION 'data-0011 assertions: % of the 4 fixture sources on the retiered hosts are at T3', moved; END IF;
  IF (SELECT base_tier FROM public.sources WHERE id = '5a5a5a5a-0000-4000-8000-0000000000b5') <> 2 THEN RAISE EXCEPTION 'data-0011 assertions: the fixture source on another host moved off T2 (the host pattern is too broad)'; END IF;
  IF (SELECT jsonb_array_length(tier_history) FROM public.sources WHERE id = '5a5a5a5a-0000-4000-8000-0000000000b5') <> 0 THEN RAISE EXCEPTION 'data-0011 assertions: the fixture source on another host gained a tier-history entry'; END IF;
  SELECT tier_history -> -1 INTO entry FROM public.sources WHERE id = '5a5a5a5a-0000-4000-8000-0000000000b1';
  IF entry->>'from_tier' <> '2' OR entry->>'to_tier' <> '3' OR entry->>'changed_by' <> 'system' THEN RAISE EXCEPTION 'data-0011 assertions: the history entry is %', entry; END IF;
  RAISE NOTICE 'data-0011 assertions OK';
END $$;
