-- Down for 0094_item_timelines_date_precision: the column and its constraint go; the rows keep their period-start dates and the tokens in their labels.
ALTER TABLE public.item_timelines DROP COLUMN date_precision;
