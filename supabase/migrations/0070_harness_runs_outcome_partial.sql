-- 0070 harness_runs.outcome gains `partial` (R1b, remediation G7; good-enough audit core register C:7).
--
-- A run whose units did their work and some of them failed was recorded `success` with the failure folded into a reason string nobody read, so the chain proof (src/core/harness/proofs.ts chainProof) read ok whenever no row was
-- `failed`. The ledger vocabulary now carries the state: `partial`. classify() (src/core/harness/outcome.ts) returns it for a run result that says so, chainProof is not ok on it, and THE GATE and the minted-ids proof count a
-- partial mint (the items it did mint exist). The CHECK constraint is the only thing that changes; no row changes.
-- Two-track policy: schema DDL, applied by the Supabase CLI BEFORE the code that writes `partial` is deployed.
--
-- Reversal: supabase/migrations/down/0070.sql (rows already written as `partial` become `failed` with the reason kept, since the older vocabulary has no state between).

-- catalog: constraint

BEGIN;

ALTER TABLE public.harness_runs DROP CONSTRAINT harness_runs_outcome_check;
ALTER TABLE public.harness_runs ADD CONSTRAINT harness_runs_outcome_check CHECK (outcome IN ('success', 'partial', 'noop', 'refused', 'failed', 'unknown'));

-- Self-check 0070-harness-partial: every outcome the code names is accepted by the live constraint, a made-up one is refused by it (and by nothing else: a real row, so no other column can be the cause), and the constraint
-- text names `partial`. The rows are inserted inside a sub-transaction that a sentinel rolls back.
DO $$
DECLARE id uuid := gen_random_uuid(); o text;
BEGIN
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'harness_runs_outcome_check' AND conrelid = 'public.harness_runs'::regclass)) NOT LIKE '%''partial''%' THEN
    RAISE EXCEPTION '0070-harness-partial: the outcome constraint does not name partial';
  END IF;
  BEGIN
    FOREACH o IN ARRAY ARRAY['success', 'partial', 'noop', 'refused', 'failed', 'unknown'] LOOP
      INSERT INTO public.harness_runs (id, family, root_run_id, outcome, started_at, finished_at) VALUES (gen_random_uuid(), 'selfcheck-0070', id, o, now(), now());
    END LOOP;
    BEGIN
      INSERT INTO public.harness_runs (id, family, root_run_id, outcome, started_at, finished_at) VALUES (gen_random_uuid(), 'selfcheck-0070', id, 'half-done', now(), now());
      RAISE EXCEPTION '0070-harness-partial: an outcome outside the vocabulary was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0070-harness-partial OK';
END $$;

COMMIT;
