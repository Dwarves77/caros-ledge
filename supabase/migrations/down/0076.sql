-- Down for 0076: the staged-patch function goes; intelligence_items is untouched (the application of the same release stops calling it).
DROP FUNCTION public.apply_staged_item_patch(uuid, text, jsonb, jsonb);
