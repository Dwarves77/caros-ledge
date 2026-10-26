-- Down for 0137_capture_document_date: the partial index, the two CHECKs and the three columns go (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP INDEX public.agent_run_searches_document_date_idx;
ALTER TABLE public.agent_run_searches DROP CONSTRAINT agent_run_searches_document_date_basis_check, DROP CONSTRAINT agent_run_searches_document_date_method_check;
ALTER TABLE public.agent_run_searches DROP COLUMN document_date, DROP COLUMN document_date_basis, DROP COLUMN document_date_method;
