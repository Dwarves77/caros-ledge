-- Down for 0100: the functions go, then the two tables (their policies and indexes go with them).
DROP FUNCTION public.record_admin_event(uuid, text, text, text, text, jsonb);
DROP FUNCTION public.org_can(uuid, text);
DROP FUNCTION public.org_actions(uuid);
DROP TABLE public.admin_events;
DROP TABLE public.org_role_actions;
