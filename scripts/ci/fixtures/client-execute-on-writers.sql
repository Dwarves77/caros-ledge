CREATE TABLE public.planted_sink (id int);
CREATE FUNCTION public.planted_writer() RETURNS int LANGUAGE plpgsql SET search_path = public, pg_temp AS $f$
BEGIN INSERT INTO public.planted_sink VALUES (1); RETURN 1; END $f$;
GRANT EXECUTE ON FUNCTION public.planted_writer() TO authenticated;
CREATE FUNCTION public.planted_trigger_fn() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $f$
BEGIN RETURN NEW; END $f$;
GRANT EXECUTE ON FUNCTION public.planted_trigger_fn() TO anon;
