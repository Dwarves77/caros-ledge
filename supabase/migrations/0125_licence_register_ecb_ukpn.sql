-- 0125 licence_register_ecb_ukpn: the data_sources rows for the two structured-data producers that fetched under no register entry (ARM-2, notices read 2026-10-24).
--
-- Before: ecb-fx and ukpn-capacity-heatmap named no licence key, so the runner's licence gate (INV-ARM-1) had nothing to check; the ecb row (migration 281) carried a licence text its own blocker called unconfirmed, and the UKPN heatmap had no row.
-- After: both carry the verdict their publisher's own notice gives, read 2026-10-24: the ECB Disclaimer & copyright page (free use provided the information appears accurately and the ECB is cited) and the dataset's catalogue licence field (CC BY 4.0).
-- The rows are rendered from src/core/contracts/data/source-licences.json through renderDataSourceSeedSql, restricted to these two keys; tests/golden/_migration.ts renders this file again and tests/producers/arm2.test.ts compares it byte for byte.
-- Regenerate with GOLDEN_WRITE_MIGRATION=1 npm test. The statement is idempotent (ON CONFLICT DO UPDATE).
-- Access: unchanged.
--
-- Reversal: supabase/migrations/down/0125.sql (deletes the UKPN row and puts the ecb row back as migration 281 wrote it).

-- catalog: none

BEGIN;

INSERT INTO public.data_sources
  (source_key, name, redistribution, embeddable, licence, attribution, url, verified_on, blocker, ask_who, ask_what, substitute)
VALUES
  ('ecb', 'European Central Bank — euro foreign exchange reference rates', 'permitted', true, 'ECB copyright notice (ecb.europa.eu, entire website): free use of the information obtained directly from the website, provided it appears accurately and the ECB is cited as the source', 'Source: European Central Bank', 'https://www.ecb.europa.eu/services/disclaimer/html/index.en.html', '2026-10-24'::date, NULL, NULL, NULL, NULL),
  ('ukpn_ltds_capacity_heatmap', 'UK Power Networks, Long Term Development Statement (LTDS) Capacity Heatmap', 'permitted', true, 'CC BY 4.0', 'Source: UK Power Networks, Long Term Development Statement Capacity Heatmap, CC BY 4.0', 'https://ukpowernetworks.opendatasoft.com/explore/dataset/ukpn-capacity-heatmap/', '2026-10-24'::date, NULL, NULL, NULL, NULL)
ON CONFLICT (source_key) DO UPDATE SET
  name          = EXCLUDED.name,
  redistribution= EXCLUDED.redistribution,
  embeddable    = EXCLUDED.embeddable,
  licence       = EXCLUDED.licence,
  attribution   = EXCLUDED.attribution,
  url           = EXCLUDED.url,
  verified_on   = EXCLUDED.verified_on,
  blocker       = EXCLUDED.blocker,
  ask_who       = EXCLUDED.ask_who,
  ask_what      = EXCLUDED.ask_what,
  substitute    = EXCLUDED.substitute;

-- Self-check 0125-licence-register-ecb-ukpn, in the transaction that wrote the rows: each key is present, permitted and embeddable, carries the day its notice was read and no blocker, and is not doubled.
DO $$
DECLARE
  keys text[] := ARRAY['ecb', 'ukpn_ltds_capacity_heatmap'];
  k text;
  r record;
  v_ukpn text := 'ukpn_ltds_capacity_heatmap';
BEGIN
  FOREACH k IN ARRAY keys LOOP
    SELECT redistribution, embeddable, verified_on, blocker, licence INTO r FROM public.data_sources WHERE source_key = k;
    IF NOT FOUND THEN RAISE EXCEPTION '0125-licence-register-ecb-ukpn: % is missing', k; END IF;
    IF r.redistribution IS DISTINCT FROM 'permitted' OR r.embeddable IS DISTINCT FROM true THEN RAISE EXCEPTION '0125-licence-register-ecb-ukpn: % is not permitted and embeddable', k; END IF;
    IF r.verified_on IS DISTINCT FROM DATE '2026-10-24' OR r.blocker IS NOT NULL THEN RAISE EXCEPTION '0125-licence-register-ecb-ukpn: % does not carry its read date and no blocker', k; END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.data_sources WHERE source_key = ANY (keys)) <> 2 THEN
    RAISE EXCEPTION '0125-licence-register-ecb-ukpn: the 2 register rows are not all present';
  END IF;
  IF (SELECT licence FROM public.data_sources WHERE source_key = v_ukpn) IS DISTINCT FROM 'CC BY 4.0' THEN
    RAISE EXCEPTION '0125-licence-register-ecb-ukpn: the UKPN heatmap licence is not CC BY 4.0';
  END IF;
  RAISE NOTICE '0125-licence-register-ecb-ukpn OK';
END $$;

COMMIT;
