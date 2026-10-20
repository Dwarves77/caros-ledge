-- 0082 licence_register_r2g: the data_sources rows for the golden corpus publishers (R2g, notices read 2026-10-20).
--
-- Before: the nine publishers behind the golden corpus had no register entry, so the licence gate refused them as unregistered and public.data_sources, which the factor tables and the item surfaces read for the verdict
-- and the attribution, did not know them. After: one row per publisher host, each carrying the verdict its own legal notice gave, its terms URL, the date read and the attribution text a permitted licence requires.
-- The rows are rendered from src/core/contracts/data/source-licences.json through renderDataSourceSeedSql (src/core/contracts/source-licence.ts), restricted to these nine keys; tests/golden/_migration.ts renders this
-- file again and tests/golden/licence-register.test.ts compares it byte for byte. Never edited by hand; regenerate with GOLDEN_WRITE_MIGRATION=1 npm test. The statement is idempotent (ON CONFLICT DO UPDATE).
-- Access: unchanged. Not applied to production before the cutover window.
--
-- Reversal: supabase/migrations/down/0082.sql (deletes the nine rows).

-- catalog: none

BEGIN;

INSERT INTO public.data_sources
  (source_key, name, redistribution, embeddable, licence, attribution, url, verified_on, blocker, ask_who, ask_what, substitute)
VALUES
  ('ghgprotocol_org', 'GHG Protocol (WRI and WBCSD), ghgprotocol.org', 'prohibited', false, 'Proprietary, owned by GHG Protocol (WRI and WBCSD); Terms of Use last updated February 2023', NULL, 'https://ghgprotocol.org/terms-use', '2026-10-20'::date, 'The site Terms of Use bar reproduction, derivative works and any public or commercial use of GHG Protocol Content; the only carve-out names two other publications under CC BY 4.0, not the Scope 3 technical guidance chapters. The same Terms bar robots, spiders and scrapers.', NULL, NULL, NULL),
  ('ecotransit_org', 'EcoTransIT World (IVE mbH), ecotransit.org', 'prohibited', false, 'All rights reserved; German copyright (site imprint), prior written consent required', NULL, 'https://www.ecotransit.org/en/imprint/', '2026-10-20'::date, 'The imprint reserves German copyright and requires prior written consent for any duplication, processing, distribution or utilisation beyond the scope of copyright law; no reuse licence is granted. The Methodology Report adds that use or reproduction of data, diagrams or formulas needs express written permission.', NULL, NULL, NULL),
  ('consilium_europa_eu', 'Council of the EU document register, consilium.europa.eu', 'unverified', false, NULL, NULL, NULL, '2026-10-20'::date, 'The Council''s legal notice could not be read on 2026-10-20: www.consilium.europa.eu answered HTTP 403 with a browser-check page (Enable JavaScript and cookies to continue) for the legal notice, the copyright page, the home page and robots.txt. The challenge was not bypassed. data.consilium.europa.eu serves the PDF (HTTP 200) but carries no notice of its own: the document has no copyright statement and the host root returns an empty page.', NULL, NULL, NULL),
  ('ec_climate_europa_eu', 'European Commission, DG Climate Action (climate.ec.europa.eu)', 'permitted', true, 'CC BY 4.0 (Decision 2011/833/EU)', 'Source: European Commission, DG Climate Action. © European Union, reused under Decision 2011/833/EU (CC BY 4.0); changes indicated.', 'https://commission.europa.eu/legal-notice_en', '2026-10-20'::date, NULL, NULL, NULL, NULL),
  ('ec_taxation_customs_europa_eu', 'European Commission, DG Taxation and Customs Union (taxation-customs.ec.europa.eu)', 'permitted', true, 'CC BY 4.0 (Decision 2011/833/EU), excluding third-party licensed data inside the document', 'Source: European Commission, DG Taxation and Customs Union. © European Union, reused under Decision 2011/833/EU (CC BY 4.0); changes indicated.', 'https://commission.europa.eu/legal-notice_en', '2026-10-20'::date, NULL, NULL, NULL, NULL),
  ('mardep_gov_hk', 'Hong Kong Marine Department (mardep.gov.hk)', 'prohibited', false, 'Hong Kong SAR Government copyright notice: non-commercial re-dissemination with acknowledgement only', NULL, 'https://www.mardep.gov.hk/en/important-notices/index.html', '2026-10-20'::date, 'Re-dissemination is allowed for non-commercial use only; commercial reproduction, adaptation, distribution or dissemination is prohibited without prior written authorization from the Marine Department. Caro''s Ledge is a commercial product.', NULL, NULL, NULL),
  ('icao_int', 'ICAO (icao.int)', 'prohibited', false, 'Proprietary, © ICAO; personal, non-commercial use only (site Terms and Conditions)', NULL, 'https://www.icao.int/terms-and-conditions', '2026-10-20'::date, 'The site Terms and Conditions permit download and copying for the user''s personal, non-commercial use, with no right to resell or redistribute or to compile or create derivative works. The Copyright Notice (https://www.icao.int/copyright-notice) reserves all rights and requires written permission from ICAO.', NULL, NULL, NULL),
  ('mcga_gov_uk', 'UK Maritime and Coastguard Agency on GOV.UK (gov.uk)', 'permitted', true, 'OGL v3.0', 'Contains public sector information licensed under the Open Government Licence v3.0.', 'https://www.gov.uk/help/terms-conditions', '2026-10-20'::date, NULL, NULL, NULL, NULL),
  ('cbp_gov', 'U.S. Customs and Border Protection (cbp.gov)', 'permitted', true, 'Public domain per the CBP copyright notice (unless a copyright is indicated)', 'Source: U.S. Customs and Border Protection.', 'https://www.cbp.gov/site-policy-notices/copyright-notice', '2026-10-20'::date, NULL, NULL, NULL, NULL)
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

-- Self-check 0082-licence-register-r2g, in the transaction that wrote the rows: each of the nine keys is present with exactly the verdict the register gives it, and no key is missing or doubled.
DO $$
DECLARE
  keys text[] := ARRAY['ghgprotocol_org', 'ecotransit_org', 'consilium_europa_eu', 'ec_climate_europa_eu', 'ec_taxation_customs_europa_eu', 'mardep_gov_hk', 'icao_int', 'mcga_gov_uk', 'cbp_gov'];
  verdicts text[] := ARRAY['prohibited', 'prohibited', 'unverified', 'permitted', 'permitted', 'prohibited', 'prohibited', 'permitted', 'permitted'];
  i int;
  v text;
BEGIN
  FOR i IN 1..array_length(keys, 1) LOOP
    SELECT redistribution INTO v FROM public.data_sources WHERE source_key = keys[i];
    IF v IS DISTINCT FROM verdicts[i] THEN
      RAISE EXCEPTION '0082-licence-register-r2g: % is % in data_sources, the register says %', keys[i], v, verdicts[i];
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.data_sources WHERE source_key = ANY (keys)) <> 9 THEN
    RAISE EXCEPTION '0082-licence-register-r2g: the 9 register rows are not all present';
  END IF;
  RAISE NOTICE '0082-licence-register-r2g OK';
END $$;

COMMIT;
