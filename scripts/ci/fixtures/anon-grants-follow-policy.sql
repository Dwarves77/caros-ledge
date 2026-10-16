CREATE TABLE public.planted_anon_read (id int);
ALTER TABLE public.planted_anon_read ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.planted_anon_read TO anon;
