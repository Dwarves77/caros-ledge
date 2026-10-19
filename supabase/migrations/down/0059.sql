-- Down for 0059_community_notification_counts: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.community_notification_counts();
