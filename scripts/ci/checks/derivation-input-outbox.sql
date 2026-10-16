-- every table derivation_edges admits as an input reaches the outbox: its own propagation trigger, or the feeder's (intelligence_items and section_claim_provenance are fed by item_corrections; inference_records is a DAG node walked by invalidate_dependents, exempt by design)
SELECT t.tbl FROM (
  SELECT m[1] AS tbl FROM pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') m
   WHERE c.conname = 'derivation_edges_from_table_allowed') t
WHERE t.tbl <> 'inference_records'
  AND NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_proc f ON f.oid = g.tgfoid
                   WHERE NOT g.tgisinternal AND g.tgenabled <> 'D' AND f.proname LIKE 'emit_propagation%'
                     AND g.tgrelid = to_regclass(format('public.%I', t.tbl)))
  AND NOT (t.tbl IN ('intelligence_items', 'section_claim_provenance') AND EXISTS (
        SELECT 1 FROM pg_trigger g JOIN pg_proc f ON f.oid = g.tgfoid
         WHERE NOT g.tgisinternal AND g.tgenabled <> 'D' AND f.proname = 'emit_item_correction_event'
           AND g.tgrelid = 'public.item_corrections'::regclass))
ORDER BY 1;
