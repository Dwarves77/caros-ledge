-- IMP-058, the window's duplicate-email query. Read-only and member-safe: it counts, it lists the lower-cased address of each group that has more than one account, and it changes nothing.
-- Run: supabase db query --linked -f scripts/cutover/duplicate-emails.sql -o table
-- No row back: migration 0066 (the unique index on lower(profiles.email)) may run. Any row back: the operator rules (merge the accounts, or leave 0066 unapplied) before it runs.
select lower(email) as email_lower, count(*) as accounts from public.profiles where email is not null group by 1 having count(*) > 1 order by 2 desc, 1;
