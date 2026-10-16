CREATE TABLE public.planted_owner (id int PRIMARY KEY);
CREATE TABLE public.planted_notnull_child (id int PRIMARY KEY, owner_id int NOT NULL REFERENCES public.planted_owner (id) ON DELETE SET NULL);
CREATE TABLE public.planted_check_child (id int PRIMARY KEY, kind text, owner_id int REFERENCES public.planted_owner (id) ON DELETE SET NULL,
  CONSTRAINT planted_needs_owner CHECK (kind <> 'owned' OR owner_id IS NOT NULL));
