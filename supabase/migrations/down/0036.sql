-- Down for 0036_recalculation_notices_member_reads: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP POLICY "derived_values_read_member" ON public.derived_values;
DROP VIEW public.recalculation_events;
