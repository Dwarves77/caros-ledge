-- Down for 0122_digest_tables: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots). The switch and the leases existed before 0122 and stay.
DROP TABLE public.admin_opportunity_findings;
DROP TABLE public.brief_reviews;
