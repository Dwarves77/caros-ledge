-- Down for 0100: the event table goes first (its read policy calls org_can), then the three functions and the vocabulary table.
DROP TABLE public.admin_events;
DROP FUNCTION public.admin_events_guard();
DROP FUNCTION public.record_admin_event(uuid, text, text, text, text, jsonb);
DROP FUNCTION public.org_can(uuid, text);
DROP FUNCTION public.org_actions(uuid);
DROP TABLE public.org_role_actions;
