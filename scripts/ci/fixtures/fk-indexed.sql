CREATE TABLE public.planted_parent (id int PRIMARY KEY);
CREATE TABLE public.planted_child (id int PRIMARY KEY, parent_id int REFERENCES public.planted_parent (id));
