-- Down for 0064_host_worklist: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TRIGGER host_verdicts_clears_worklist ON public.host_verdicts;
DROP FUNCTION public.host_verdicts_clear_worklist();
DROP FUNCTION public.record_host_worklist(text,text,text);
DROP TABLE public.host_worklist;
