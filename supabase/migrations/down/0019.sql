-- Down for 0019_shared_rate_limiter: the catalog returns to what it was before the migration (the schema job applies this file in a transaction that rolls back and compares the catalog snapshots).
DROP FUNCTION public.rate_limit_hit(text,integer,integer);
DROP SEQUENCE public.rate_limit_calls_seq;
DROP TABLE public.rate_limit_windows;
