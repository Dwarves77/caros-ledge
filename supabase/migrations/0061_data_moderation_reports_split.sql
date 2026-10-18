-- 0061 DATA migration: split the encoded `reason` of existing moderation_reports rows into reason, body, action and notes (P2-16, owed by register P1-23 community-b.md section 3 rank 2; the columns are 0051).
--
-- The old routes stored `<reason>`, `<reason>|<body>` and, once resolved, `<...>||action=<a>;notes=<n>` in the one text column. This reads each such row once and writes the parts where they belong; the old action names map to the
-- new vocabulary (remove_post to remove, warn_user to warn, mute_user to mute, ban_user to ban, dismiss to dismiss). A row that is already split (no `|` in its reason) is not touched, so a second run changes nothing.
--
-- THIS IS A DATA MIGRATION. TWO-TRACK POLICY: it ships with its consumer (the moderation queue, which reads the columns) and is RUN ONLY AT THE CUTOVER WINDOW, after 0051; the CI schema job never runs it for real, it runs it in a
-- rolled-back transaction after the fixture named below (rule 15: the SQL is proven to execute).
--
-- Reversal: none needed; the pieces can be re-joined with the old encoding if ever required.

-- catalog: none (data migration, not run by the schema job)
-- rollback-test: scripts/ci/fixtures/data-0061-moderation-reports.sql

BEGIN;

WITH parts AS (
  SELECT r.id,
         CASE WHEN strpos(r.reason, '||') > 0 THEN left(r.reason, strpos(r.reason, '||') - 1) ELSE r.reason END AS head,
         CASE WHEN strpos(r.reason, '||') > 0 THEN substr(r.reason, strpos(r.reason, '||') + 2) ELSE '' END AS tail
    FROM public.moderation_reports r
   WHERE r.reason LIKE '%|%' AND r.body IS NULL AND r.action IS NULL AND r.notes IS NULL
)
UPDATE public.moderation_reports m
   SET reason = CASE WHEN strpos(p.head, '|') > 0 THEN left(p.head, strpos(p.head, '|') - 1) ELSE p.head END,
       body = CASE WHEN strpos(p.head, '|') > 0 THEN nullif(left(substr(p.head, strpos(p.head, '|') + 1), 2000), '') END,
       action = CASE substring(p.tail from '^action=([a-z_]+)') WHEN 'dismiss' THEN 'dismiss' WHEN 'remove_post' THEN 'remove' WHEN 'warn_user' THEN 'warn' WHEN 'mute_user' THEN 'mute' WHEN 'ban_user' THEN 'ban' END,
       notes = nullif(left(substring(p.tail from ';notes=(.*)$'), 1000), '')
  FROM parts p
 WHERE m.id = p.id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.moderation_reports WHERE reason LIKE '%|%') THEN RAISE EXCEPTION '0061: a report still carries an encoded reason'; END IF;
  RAISE NOTICE '0061-moderation-split OK';
END $$;

COMMIT;
