-- Down for 0009_item_corrections_outbox: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP TRIGGER item_corrections_outbox_trg ON public.item_corrections;
DROP FUNCTION public.emit_item_correction_event();
