CREATE TABLE public.planted_anon_write (id int);
ALTER TABLE public.planted_anon_write ENABLE ROW LEVEL SECURITY;
CREATE POLICY planted_anon_insert ON public.planted_anon_write FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY planted_public_update ON public.planted_anon_write FOR UPDATE TO public USING (true);
