-- expect: planted_child (
-- expect: planted_schema.planted_child2 (
CREATE TABLE public.planted_parent (id int PRIMARY KEY);
CREATE TABLE public.planted_child (id int PRIMARY KEY, parent_id int REFERENCES public.planted_parent (id));
CREATE SCHEMA planted_schema;
CREATE TABLE planted_schema.planted_parent2 (id int PRIMARY KEY);
CREATE TABLE planted_schema.planted_child2 (id int PRIMARY KEY, parent_id int REFERENCES planted_schema.planted_parent2 (id));
