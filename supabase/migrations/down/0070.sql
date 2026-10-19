-- Down for 0070: the outcome vocabulary without `partial`. A row already written as `partial` becomes `failed` (the older vocabulary has no state between success and failure; the reason column keeps what the run said).
UPDATE public.harness_runs SET outcome = 'failed', reason = coalesce(reason, '') || ' (was partial)' WHERE outcome = 'partial';
ALTER TABLE public.harness_runs DROP CONSTRAINT harness_runs_outcome_check;
ALTER TABLE public.harness_runs ADD CONSTRAINT harness_runs_outcome_check CHECK (outcome IN ('success', 'noop', 'refused', 'failed', 'unknown'));
