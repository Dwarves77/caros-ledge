-- Down for 0069_live_check_provenance_no_replica: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
CREATE OR REPLACE FUNCTION public.live_check_provenance_trigger()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  it uuid; before_ text; after_ text; left_ int;
BEGIN
  BEGIN
    SET LOCAL session_replication_role = replica;
    INSERT INTO public.intelligence_items (title, domain, provenance_status, is_archived) VALUES ('live-check provenance trigger', 1, 'verified', false) RETURNING id INTO it;
    SET LOCAL session_replication_role = origin;
    SELECT provenance_status::text INTO before_ FROM public.intelligence_items WHERE id = it;
    UPDATE public.intelligence_items SET title = 'live-check provenance trigger (touched)' WHERE id = it;
    SELECT provenance_status::text INTO after_ FROM public.intelligence_items WHERE id = it;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'live check rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  SELECT count(*) INTO left_ FROM public.intelligence_items WHERE title LIKE 'live-check provenance trigger%';
  RETURN jsonb_build_object('flipped', before_ = 'verified' AND after_ IS DISTINCT FROM 'verified', 'before', before_, 'after', after_, 'left_behind', left_);
END;
$function$
;
REVOKE ALL ON FUNCTION public.live_check_provenance_trigger() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.live_check_provenance_trigger() TO "service_role";
