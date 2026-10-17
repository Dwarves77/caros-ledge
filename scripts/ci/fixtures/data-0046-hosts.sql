-- Rollback-test fixture for 0046_data_host_verdicts.sql: a verdict for one of the two hosts ruled before the load (a different class, a later batch) that the data file must not overwrite. Runs inside the job's rolled-back transaction,
-- after 0042 has created the table.
INSERT INTO public.host_verdicts (host, class, reason, batch_id, ruled_by) VALUES ('carbonintensity.org.uk', 'news', 'ruled before the load', 'host-verdicts-500', 'session-lane');
