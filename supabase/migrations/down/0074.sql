-- Down for 0074: the ledger functions go; the claim and archive tables, the sections and every row are untouched (the application of the same release stops calling them).
DROP FUNCTION public.ledger_erase_item(uuid, text, uuid, text, timestamptz);
DROP FUNCTION public.ledger_apply_ops(uuid, jsonb, timestamptz);
DROP FUNCTION public.ledger_reconcile_sections(uuid, jsonb, timestamptz);
DROP FUNCTION public.ledger_remove_claim(uuid, text, jsonb, text, timestamptz);
DROP FUNCTION public.ledger_write_claim(uuid, uuid, jsonb, text, text, timestamptz);
DROP FUNCTION public.ledger_attribution_violations(uuid);
DROP FUNCTION public.ledger_attribution(uuid, uuid, text);
DROP FUNCTION public.ledger_hosts_related(text, text);
DROP FUNCTION public.ledger_host_of(text);
