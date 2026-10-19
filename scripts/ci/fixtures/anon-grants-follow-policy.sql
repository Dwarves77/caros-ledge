-- expect: anon holds INSERT on public.planted_anon_read
-- expect: anon SELECT without an anon policy: public.planted_anon_read
-- expect: anon holds INSERT on planted_schema.planted_other
-- expect: anon SELECT without an anon policy: planted_schema.planted_other
CREATE TABLE public.planted_anon_read (id int);
ALTER TABLE public.planted_anon_read ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.planted_anon_read TO anon;
-- the same defect in a schema the app creates beside public
CREATE SCHEMA planted_schema;
CREATE TABLE planted_schema.planted_other (id int);
ALTER TABLE planted_schema.planted_other ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON planted_schema.planted_other TO anon;
