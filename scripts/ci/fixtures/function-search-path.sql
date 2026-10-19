-- expect: public.planted_invoker()
-- expect: planted_schema.planted_invoker_other()
CREATE FUNCTION public.planted_invoker() RETURNS int LANGUAGE sql AS 'SELECT 1';
CREATE SCHEMA planted_schema;
CREATE FUNCTION planted_schema.planted_invoker_other() RETURNS int LANGUAGE sql AS 'SELECT 1';
