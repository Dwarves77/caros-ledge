-- expect: public.planted_no_rls
-- expect: planted_schema.planted_no_rls_other
CREATE TABLE public.planted_no_rls (id int);
CREATE SCHEMA planted_schema;
CREATE TABLE planted_schema.planted_no_rls_other (id int);
