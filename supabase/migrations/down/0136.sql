-- Down for 0136_connect_2_pr_b_edges_objects_signposts: the signposts that track no assessment go (the column cannot be NOT NULL again while they stand), the cycle guard returns to walking every relation, and the six obligation_objects columns, the two entity_relations
-- columns and their checks are dropped (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DELETE FROM public.signposts WHERE assessment_id IS NULL;
ALTER TABLE public.signposts DROP CONSTRAINT signposts_tracks_something_check;
ALTER TABLE public.signposts ALTER COLUMN assessment_id SET NOT NULL;
ALTER TABLE public.obligation_objects
  DROP CONSTRAINT obligation_objects_in_force_window_check, DROP CONSTRAINT obligation_objects_basis_is_object_check, DROP CONSTRAINT obligation_objects_basis_with_method_check,
  DROP CONSTRAINT obligation_objects_mandated_nonnegative_check, DROP CONSTRAINT obligation_objects_mandated_pair_check;
ALTER TABLE public.obligation_objects DROP COLUMN basis, DROP COLUMN method_version, DROP COLUMN in_force_end, DROP COLUMN mandated_unit, DROP COLUMN mandated_quantity, DROP COLUMN due_date;
CREATE OR REPLACE FUNCTION public.entity_relations_refuse_cycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('entity_relations_cycle', 0));

  IF NEW.parent_entity_id = NEW.child_entity_id THEN
    RAISE EXCEPTION 'entity_relations: % cannot be its own parent', NEW.parent_entity_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    WITH RECURSIVE ancestors(entity_id) AS (
      SELECT NEW.parent_entity_id
      UNION
      SELECT r.parent_entity_id
        FROM public.entity_relations r
        JOIN ancestors a ON r.child_entity_id = a.entity_id
       WHERE NOT (TG_OP = 'UPDATE'
                  AND r.parent_entity_id = OLD.parent_entity_id
                  AND r.child_entity_id = OLD.child_entity_id
                  AND r.relation = OLD.relation)
    )
    SELECT 1 FROM ancestors WHERE entity_id = NEW.child_entity_id
  ) THEN
    RAISE EXCEPTION 'entity_relations: % as the child of % would make the child an ancestor of its own parent (a cycle)',
      NEW.child_entity_id, NEW.parent_entity_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $function$;
ALTER TABLE public.entity_relations DROP CONSTRAINT entity_relations_basis_is_object_check, DROP CONSTRAINT entity_relations_basis_with_method_check;
ALTER TABLE public.entity_relations DROP COLUMN basis, DROP COLUMN method_version;
