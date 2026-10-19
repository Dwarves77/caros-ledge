-- expect: public.planted_identity.planted_identity_read
CREATE TABLE public.planted_identity (id int, user_id uuid);
ALTER TABLE public.planted_identity ENABLE ROW LEVEL SECURITY;
CREATE POLICY planted_identity_read ON public.planted_identity FOR SELECT USING (user_id = (SELECT auth.uid()));
