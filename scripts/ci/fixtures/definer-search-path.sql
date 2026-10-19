-- expect: public.planted_definer()
-- expect: planted_schema.planted_definer_other()
CREATE FUNCTION public.planted_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
CREATE SCHEMA planted_schema;
CREATE FUNCTION planted_schema.planted_definer_other() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
