CREATE TABLE public.planted_unwrapped (id int, user_id uuid);
ALTER TABLE public.planted_unwrapped ENABLE ROW LEVEL SECURITY;
CREATE POLICY planted_unwrapped_read ON public.planted_unwrapped FOR SELECT TO authenticated USING (user_id = auth.uid());
