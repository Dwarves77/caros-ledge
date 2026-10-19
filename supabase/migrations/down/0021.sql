-- Down for 0021_drop_duplicated_partial_indexes: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
CREATE INDEX derived_values_supersedes_idx ON public.derived_values USING btree (supersedes) WHERE (supersedes IS NOT NULL);
CREATE INDEX entities_merged_into_idx ON public.entities USING btree (merged_into) WHERE (merged_into IS NOT NULL);
CREATE INDEX inference_records_supersedes_idx ON public.inference_records USING btree (supersedes) WHERE (supersedes IS NOT NULL);
CREATE INDEX research_assessments_entity_id_idx ON public.research_assessments USING btree (entity_id) WHERE (entity_id IS NOT NULL);
