-- Down for 0143_obligation_due_date_precision: the precision column and its constraint are dropped; due_date keeps its stored day (a month or year value stays its first-of-period date, read as a day again).
ALTER TABLE public.obligation_objects DROP CONSTRAINT obligation_objects_due_date_precision_values, DROP COLUMN due_date_precision;
