-- 0046 DATA migration: the two committed host verdicts of the old tree into host_verdicts (P2-S4, IMP-054; the batch files host-verdicts-001 and host-verdicts-379 of the old repo's scripts/maintenance/host-verdicts).
--
-- The old registry loader read every committed host-verdicts-NNN.json; the verdicts are rows now (0042), so the two the old tree committed are carried over, host for host, class for class, with their evidence and batch name.
-- Later batch wins per host, and the two hosts differ, so there is nothing to reconcile. Do not edit a row without the old file it came from.
--
-- THIS IS A DATA MIGRATION. TWO-TRACK POLICY: it ships with its consumer (src/core/sources/host-verdicts.ts loadHostVerdicts) and is RUN ONLY AT THE CUTOVER WINDOW, after 0042; the CI schema job never commits it, it runs it inside
-- a rolled-back transaction after the fixture named below (rule 15: the SQL is proven to execute, and the file asserts its own result).
--
-- Idempotent: INSERT ... ON CONFLICT (host) DO NOTHING, so a second run, or a verdict ruled since, is never overwritten.
-- Reversal: DELETE FROM public.host_verdicts WHERE batch_id IN ('host-verdicts-001', 'host-verdicts-379') AND ruled_by = 'session-lane'.

-- catalog: none (data migration, not run by the schema job)
-- rollback-test: scripts/ci/fixtures/data-0046-hosts.sql

BEGIN;

CREATE TEMP TABLE _hv_before ON COMMIT DROP AS SELECT host, class, batch_id FROM public.host_verdicts;

INSERT INTO public.host_verdicts (host, class, reason, batch_id, ruled_by, ruled_at) VALUES
('carbonintensity.org.uk', 'gov', 'Carbon Intensity API site (https://carbonintensity.org.uk/), the API of the National Energy System Operator (NESO). NESO is publicly owned: the UK government completed the purchase of the Electricity System Operator on 2024-10-01. Citation: the NESO About page, https://www.neso.energy/about. Coordinator ruling 2026-10-08 (lane S8-E5); the About page was not fetched by the lane.', 'host-verdicts-001', 'session-lane', '2026-10-08T00:00:00Z'),
('ukpowernetworks.opendatasoft.com', 'company', 'Catalogue metadata of dataset ukpn-capacity-heatmap on this host (fetched 2026-10-08): title ''Long Term Development Statement (LTDS) Capacity Heatmap'', publisher ''UK Power Networks, Company number 3870728'', license ''CC BY 4.0''. The host is the publisher''s own Opendatasoft portal; the publisher is a licensed distribution network operator and a registered company, so the class is company.', 'host-verdicts-379', 'session-lane', '2026-10-08T13:30:00Z')
ON CONFLICT (host) DO NOTHING;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.host_verdicts WHERE host IN ('carbonintensity.org.uk', 'ukpowernetworks.opendatasoft.com')) <> 2 THEN RAISE EXCEPTION '0046: a committed host verdict is missing after the load'; END IF;
  IF EXISTS (SELECT 1 FROM _hv_before b JOIN public.host_verdicts h USING (host) WHERE h.class IS DISTINCT FROM b.class OR h.batch_id IS DISTINCT FROM b.batch_id) THEN RAISE EXCEPTION '0046: a verdict ruled before the load was overwritten'; END IF;
  RAISE NOTICE '0046 OK';
END $$;

COMMIT;
