-- 0029 market_series_items (P2-11, owed by register P1-20 market.md sections 6 and 8: the series-to-item attachments lived in a code file that a script rewrote, against rule 1).
--
-- Which market_series key is the figure behind which item's price board. A row is `ratified` only with its item (CHECK), so the board of an item derives only from a series someone attached to it (INV-047). The reader of the market
-- detail page finds the series behind an item here; the ratification writes a row, never a source file.
--   series_key  the full market_series key ("prefix:rest"), the primary key.
--   item_id     the intelligence_items row the series is the figure for; deleting the item deletes the attachment. NULL only while the status is `pending`.
--   status      `pending` or `ratified`.
-- RLS on; signed-in readers (and the service role) select, only the service role writes. Not applied to production before the cutover window; the six ratified rows ship as 0030, a data migration.
--
-- Reversal: DROP TABLE public.market_series_items.

-- catalog: relation, column, constraint, index, policy, acl

BEGIN;

CREATE TABLE public.market_series_items (
  series_key text NOT NULL,
  item_id uuid,
  status text DEFAULT 'pending' NOT NULL,
  CONSTRAINT market_series_items_series_key_format CHECK (series_key ~ '^[a-z0-9]+(?:[:_-][a-z0-9]+)*$'),
  CONSTRAINT market_series_items_status_check CHECK (status IN ('pending', 'ratified')),
  CONSTRAINT market_series_items_ratified_has_item CHECK (status <> 'ratified' OR item_id IS NOT NULL),
  CONSTRAINT market_series_items_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE
);
ALTER TABLE public.market_series_items ADD CONSTRAINT market_series_items_pkey PRIMARY KEY (series_key);
CREATE INDEX market_series_items_item_id_idx ON public.market_series_items (item_id);

COMMENT ON TABLE public.market_series_items IS 'The series behind an item''s price board (P2-11 migration 0029): one row per market_series key, ratified only with its item.';

ALTER TABLE public.market_series_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY market_series_items_read ON public.market_series_items FOR SELECT TO authenticated, service_role USING (true);
REVOKE ALL ON TABLE public.market_series_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.market_series_items TO authenticated;
GRANT ALL ON TABLE public.market_series_items TO service_role;

-- Self-check 0029-market-series-items: attacks on the live constraints, rolled back by a sentinel. A ratified row without an item, a status outside the two, a malformed key and an unknown item are each refused; a row with a
-- real item reads back as written and goes with the item; as `authenticated` the rows are readable and not writable; anon holds nothing.
DO $$
DECLARE it uuid; n int;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.market_series_items'::regclass) THEN RAISE EXCEPTION '0029-market-series-items: RLS is off'; END IF;
  IF has_table_privilege('anon', 'public.market_series_items', 'SELECT') THEN RAISE EXCEPTION '0029-market-series-items: anon can read'; END IF;
  BEGIN
    INSERT INTO public.intelligence_items (title, domain) VALUES ('selfcheck-0029', 4) RETURNING id INTO it;
    BEGIN INSERT INTO public.market_series_items (series_key, status) VALUES ('a:b', 'ratified'); RAISE EXCEPTION '0029-market-series-items: a ratified row with no item was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.market_series_items (series_key, item_id, status) VALUES ('a:b', it, 'approved'); RAISE EXCEPTION '0029-market-series-items: an unknown status was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.market_series_items (series_key, item_id, status) VALUES ('Not A Key', it, 'ratified'); RAISE EXCEPTION '0029-market-series-items: a malformed series key was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.market_series_items (series_key, item_id, status) VALUES ('a:b', gen_random_uuid(), 'ratified'); RAISE EXCEPTION '0029-market-series-items: an unknown item was accepted';
    EXCEPTION WHEN foreign_key_violation THEN NULL; END;
    INSERT INTO public.market_series_items (series_key, item_id, status) VALUES ('a:b', it, 'ratified');
    BEGIN INSERT INTO public.market_series_items (series_key, item_id, status) VALUES ('a:b', it, 'ratified'); RAISE EXCEPTION '0029-market-series-items: a series was attached twice';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    IF (SELECT item_id FROM public.market_series_items WHERE series_key = 'a:b') <> it THEN RAISE EXCEPTION '0029-market-series-items: the row did not read back as written'; END IF;
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO n FROM public.market_series_items WHERE series_key = 'a:b';
    IF n <> 1 THEN RAISE EXCEPTION '0029-market-series-items: authenticated cannot read the attachment'; END IF;
    BEGIN INSERT INTO public.market_series_items (series_key, item_id, status) VALUES ('c:d', it, 'ratified'); RAISE EXCEPTION '0029-market-series-items: authenticated wrote an attachment';
    EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    RESET ROLE;
    DELETE FROM public.intelligence_items WHERE id = it;
    SELECT count(*) INTO n FROM public.market_series_items WHERE series_key = 'a:b';
    IF n <> 0 THEN RAISE EXCEPTION '0029-market-series-items: an attachment outlived its item'; END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0029-market-series-items OK';
END $$;

COMMIT;
