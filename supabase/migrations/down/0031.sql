-- Down for 0031_member_detail_reads: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP POLICY "census_worklist_read_member" ON public.census_worklist;
DROP POLICY "inference_records_read_member" ON public.inference_records;
DROP POLICY "intelligence_item_citations_read_member" ON public.intelligence_item_citations;
DROP POLICY "section_claim_provenance_read_member" ON public.section_claim_provenance;
DROP POLICY "source_bias_tags_read_member" ON public.source_bias_tags;
DROP VIEW public.fact_suppressions;
