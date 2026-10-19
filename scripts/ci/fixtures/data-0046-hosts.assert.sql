-- Assertions about the FIXTURE of 0046_data_host_verdicts.sql, run in the same rolled-back transaction after the file (apply-notes.json "assert"). The data file's own self-check counted the two hosts across the whole table and
-- compared the pre-ruled rows through a temp table; these name the rows: the verdict ruled before the load keeps its class and batch, and the other host takes the class the file writes.
DO $$
BEGIN
  IF (SELECT class || '|' || batch_id FROM public.host_verdicts WHERE host = 'carbonintensity.org.uk') IS DISTINCT FROM 'news|host-verdicts-500' THEN RAISE EXCEPTION 'data-0046 assertions: the verdict ruled before the load was overwritten'; END IF;
  IF (SELECT class || '|' || batch_id FROM public.host_verdicts WHERE host = 'ukpowernetworks.opendatasoft.com') IS DISTINCT FROM 'company|host-verdicts-379' THEN RAISE EXCEPTION 'data-0046 assertions: the second host did not take its committed verdict'; END IF;
  RAISE NOTICE 'data-0046 assertions OK';
END $$;
