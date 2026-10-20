-- 0111 item_obligation_scan: the record that an item's source text has been read for its dated duties (IMPACT-1).
--
-- The connect stage reads each verified item's captures once per extractor and derivation version (extract the forward events, derive the register and the obligation objects) and works the backlog oldest first. An item the reader examined and found
-- NO duty in has no obligation rows, exactly like an item nobody has read; this table is the difference. A backlog that is "every verified item with no obligation object" never drains (the no-duty items come back every turn), and an impact
-- score cannot say 0 ("the source states no duty") from null ("not read yet") without it. One row per item, rewritten when the item is read again (a new extractor or derivation version, or the brief regenerated after the last read).
-- Columns: item_id uuid primary key referencing intelligence_items(id) ON DELETE CASCADE; scanned_at; extractor_version and derivation_version (the versions that read it); events (forward events the item holds after the read),
-- objects (current obligation objects it holds after the read), all non-negative.
-- Access: RLS on. service_role writes (the connect stage). authenticated and anon: nothing (an internal work record; the surfaces read the scores and the obligations, never this).
-- Indexes: the primary key serves the backlog read and the per-item upsert.
--
-- Reversal: down/0111.sql drops the table.

-- catalog: column, relation, constraint, index, acl

BEGIN;

CREATE TABLE public.item_obligation_scan (
  item_id uuid NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  extractor_version text NOT NULL,
  derivation_version text NOT NULL,
  events integer NOT NULL,
  objects integer NOT NULL,
  CONSTRAINT item_obligation_scan_counts_check CHECK (events >= 0 AND objects >= 0),
  CONSTRAINT item_obligation_scan_versions_check CHECK (length(btrim(extractor_version)) > 0 AND length(btrim(derivation_version)) > 0)
);

ALTER TABLE public.item_obligation_scan
  ADD CONSTRAINT item_obligation_scan_pkey PRIMARY KEY (item_id),
  ADD CONSTRAINT item_obligation_scan_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;

COMMENT ON TABLE public.item_obligation_scan IS 'One row per item whose source text the connect stage has read for dated duties (IMPACT-1 migration 0111): when, with which extractor and derivation versions, and what it found. The difference between "read, no duty stated" and "not read yet". Written by the service role only.';

ALTER TABLE public.item_obligation_scan ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.item_obligation_scan FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.item_obligation_scan TO service_role;

-- Self-check 0111-obligation-scan: shape, key, cascade, access, and attacks: negative counts and blank versions are refused; an authenticated and an anon session read nothing and write nothing; deleting the item deletes the row.
DO $$
DECLARE v_item uuid := gen_random_uuid(); n int;
BEGIN
  IF (SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'item_obligation_scan') <> 'derivation_version,events,extractor_version,item_id,objects,scanned_at' THEN
    RAISE EXCEPTION '0111-obligation-scan: unexpected columns';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'item_obligation_scan_pkey') <> 'PRIMARY KEY (item_id)' THEN
    RAISE EXCEPTION '0111-obligation-scan: the primary key is not (item_id)';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.item_obligation_scan'::regclass) THEN
    RAISE EXCEPTION '0111-obligation-scan: RLS is off';
  END IF;
  IF has_table_privilege('anon', 'public.item_obligation_scan', 'SELECT') OR has_table_privilege('authenticated', 'public.item_obligation_scan', 'SELECT')
     OR has_table_privilege('authenticated', 'public.item_obligation_scan', 'INSERT') OR has_table_privilege('anon', 'public.item_obligation_scan', 'INSERT') THEN
    RAISE EXCEPTION '0111-obligation-scan: anon or authenticated has access';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.item_obligation_scan', 'INSERT') THEN
    RAISE EXCEPTION '0111-obligation-scan: service_role cannot write';
  END IF;
  IF (SELECT confdeltype FROM pg_constraint WHERE conname = 'item_obligation_scan_item_id_fkey') <> 'c' THEN
    RAISE EXCEPTION '0111-obligation-scan: the item FK does not cascade';
  END IF;
  BEGIN
    INSERT INTO public.intelligence_items (id, title, domain) VALUES (v_item, 'selfcheck 0111', 1);
    INSERT INTO public.item_obligation_scan (item_id, extractor_version, derivation_version, events, objects) VALUES (v_item, 'e1', 'd1', 1, 1);
    BEGIN
      INSERT INTO public.item_obligation_scan (item_id, extractor_version, derivation_version, events, objects) VALUES (gen_random_uuid(), 'e1', 'd1', 0, 0);
      RAISE EXCEPTION '0111-obligation-scan: a scan row for an item that does not exist was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    UPDATE public.item_obligation_scan SET objects = 0 WHERE item_id = v_item;
    BEGIN
      UPDATE public.item_obligation_scan SET events = -1 WHERE item_id = v_item;
      RAISE EXCEPTION '0111-obligation-scan: a negative count was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      UPDATE public.item_obligation_scan SET derivation_version = '  ' WHERE item_id = v_item;
      RAISE EXCEPTION '0111-obligation-scan: a blank version was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM count(*) FROM public.item_obligation_scan;
      RESET ROLE;
      RAISE EXCEPTION '0111-obligation-scan: an authenticated session read the table';
    EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
    END;
    SET LOCAL ROLE anon;
    BEGIN
      INSERT INTO public.item_obligation_scan (item_id, extractor_version, derivation_version, events, objects) VALUES (v_item, 'e1', 'd1', 0, 0);
      RESET ROLE;
      RAISE EXCEPTION '0111-obligation-scan: an anon session wrote the table';
    EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
    END;
    DELETE FROM public.intelligence_items WHERE id = v_item;
    SELECT count(*) INTO n FROM public.item_obligation_scan WHERE item_id = v_item;
    IF n <> 0 THEN RAISE EXCEPTION '0111-obligation-scan: deleting the item left its scan row'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0111-obligation-scan OK';
END $$;

COMMIT;
