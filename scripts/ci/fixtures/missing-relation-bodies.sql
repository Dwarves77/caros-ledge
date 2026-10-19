-- expect: public.planted_reads_missing() -> public.planted_table_that_does_not_exist
CREATE FUNCTION public.planted_reads_missing() RETURNS int LANGUAGE plpgsql AS $f$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.planted_table_that_does_not_exist;
  RETURN n;
END $f$;
