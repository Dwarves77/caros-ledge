-- Down for 0051_moderation_reports_columns: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
ALTER TABLE public.moderation_reports DROP CONSTRAINT moderation_reports_action_check;
ALTER TABLE public.moderation_reports DROP CONSTRAINT moderation_reports_body_length;
ALTER TABLE public.moderation_reports DROP CONSTRAINT moderation_reports_notes_length;
ALTER TABLE public.moderation_reports DROP COLUMN action;
ALTER TABLE public.moderation_reports DROP COLUMN body;
ALTER TABLE public.moderation_reports DROP COLUMN notes;
