-- Down for 0023_patch_workspace_settings: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.patch_workspace_settings(uuid,text,jsonb);
