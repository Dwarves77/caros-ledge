-- 0011 DATA migration: OECD, IEA, World Bank and IPCC sources re-tiered to base_tier 3 (P2-S1, owed by register P1-05 sources-a.md
-- section 8 "Rulings" (tier placement; the re-tier migration is P1-11's) and BUILD-PLAN-2026-10-12 ruling 1: T3).
--
-- THIS IS A DATA MIGRATION. TWO-TRACK POLICY: it ships with its consumer, P2-03's tier contract (tier-contract.ts and host-class.ts
-- put these four hosts at T3), and is RUN ONLY AT THE CUTOVER WINDOW, by the operator's executor, never by the CI schema job:
-- scripts/ci/schema-apply.mjs skips every file whose name contains `_data_`. Run it after P2-03 has merged and before the new tree
-- serves production, so a source's stored tier and the code's tier agree from the first request.
--
-- What it changes: sources rows whose url host is, or is a subdomain of, oecd.org, iea.org, worldbank.org or ipcc.ch and whose
-- base_tier is not 3 get base_tier = 3 (the sync trigger moves `tier` with it), and one entry is appended to tier_history
-- (from_tier, to_tier, reason, trust_score_at_change = the row's own trust_score_overall, changed_by 'system'). A row holding a
-- tier_override is re-tiered too: the override is a separate column and keeps its own meaning. effective_tier is recomputed by
-- the app's trust pass from base_tier; it is not written here. No other column changes.
--
-- Idempotent: a second run finds no row with base_tier <> 3 and changes nothing.
-- Reversal: UPDATE sources SET base_tier = 2 WHERE the tier_history last entry reason is the one written below (from_tier says
-- the previous value per row).

-- catalog: none (data migration, not run by the schema job)
-- rollback-test: scripts/ci/fixtures/data-0011-sources.sql

BEGIN;

CREATE TEMP TABLE _retier_t3 ON COMMIT DROP AS
SELECT s.id, s.base_tier AS from_tier, s.trust_score_overall
  FROM public.sources s
 WHERE lower(substring(s.url from '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#]+)')) ~ '(^|\.)(oecd\.org|iea\.org|worldbank\.org|ipcc\.ch)$'
   AND s.base_tier <> 3;

UPDATE public.sources s SET
  base_tier = 3,
  tier_history = s.tier_history || jsonb_build_array(jsonb_build_object(
    'date', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'from_tier', r.from_tier,
    'to_tier', 3,
    'reason', 'BUILD-PLAN ruling 1: OECD, IEA, World Bank and IPCC are analysis bodies, T3 (migration 0011)',
    'trust_score_at_change', r.trust_score_overall,
    'changed_by', 'system'))
  FROM _retier_t3 r
 WHERE s.id = r.id;

-- Self-check 0011-data-retier: no matching source is left off T3, and the tier columns agree.
DO $$
DECLARE n_left int; n_changed int;
BEGIN
  SELECT count(*) INTO n_changed FROM _retier_t3;
  SELECT count(*) INTO n_left FROM public.sources s
   WHERE lower(substring(s.url from '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#]+)')) ~ '(^|\.)(oecd\.org|iea\.org|worldbank\.org|ipcc\.ch)$'
     AND (s.base_tier <> 3 OR s.tier <> 3);
  IF n_left <> 0 THEN RAISE EXCEPTION '0011-data-retier: % matching sources are still off T3', n_left; END IF;
  RAISE NOTICE '0011-data-retier OK (% rows re-tiered)', n_changed;
END $$;

COMMIT;
