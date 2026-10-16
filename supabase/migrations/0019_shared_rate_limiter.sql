-- 0019 shared rate limiter (P2-S3, owed by IMPROVEMENTS IMP-011).
--
-- The in-memory window in src/core/http/rate-limit.ts is per server instance; on serverless there are many instances, so a caller's real
-- allowance was 60 requests per minute times the number of warm instances. One Postgres counter shared by all instances fixes that:
--   * rate_limit_windows (key, window_start) holds the count for one fixed window; the primary key is the upsert target.
--   * rate_limit_hit(p_key, p_limit, p_window_seconds) adds one hit to the key's current fixed window (windows are aligned to the epoch, so
--     every instance computes the same window) and returns {allowed, remaining, reset_at}. The upsert is one statement, so concurrent
--     callers cannot lose a hit.
--   * Every 50th call (a sequence, so exactly every 50th across all callers) deletes windows older than one hour, so the table stays small
--     with no scheduled job.
-- service_role only (the limiter runs on the server with the service client): RLS is on with no policy, no client privilege. Not applied
-- to production before the cutover window; until the code that calls it ships nothing reads it.
--
-- Reversal: DROP FUNCTION public.rate_limit_hit(text, int, int); DROP TABLE public.rate_limit_windows; DROP SEQUENCE public.rate_limit_calls_seq.

-- catalog: relation, column, constraint, index, acl, function

BEGIN;

CREATE SEQUENCE public.rate_limit_calls_seq;

CREATE TABLE public.rate_limit_windows (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count int NOT NULL DEFAULT 0,
  CONSTRAINT rate_limit_windows_count_check CHECK (count >= 0)
);
ALTER TABLE public.rate_limit_windows ADD CONSTRAINT rate_limit_windows_pkey PRIMARY KEY (key, window_start);
COMMENT ON TABLE public.rate_limit_windows IS 'One row per rate-limit key and fixed window (P2-S3 migration 0019). Written only by rate_limit_hit; rows older than an hour are deleted by that function on every 50th call.';

ALTER TABLE public.rate_limit_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rate_limit_windows FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.rate_limit_calls_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.rate_limit_windows TO service_role;
GRANT USAGE ON SEQUENCE public.rate_limit_calls_seq TO service_role;

CREATE FUNCTION public.rate_limit_hit(p_key text, p_limit int, p_window_seconds int)
  RETURNS TABLE(allowed boolean, remaining int, reset_at timestamptz)
  LANGUAGE plpgsql SET search_path = public, pg_temp
  AS $$
DECLARE v_start timestamptz; v_count int;
BEGIN
  IF p_key IS NULL OR p_key = '' OR p_limit IS NULL OR p_limit < 1 OR p_window_seconds IS NULL OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'rate_limit_hit needs a key, a limit of at least 1 and a window of at least 1 second' USING ERRCODE = '22023';
  END IF;
  v_start := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  INSERT INTO public.rate_limit_windows AS w (key, window_start, count) VALUES (p_key, v_start, 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = w.count + 1
    RETURNING w.count INTO v_count;
  IF nextval('public.rate_limit_calls_seq') % 50 = 0 THEN
    DELETE FROM public.rate_limit_windows WHERE window_start < now() - interval '1 hour';
  END IF;
  RETURN QUERY SELECT v_count <= p_limit, greatest(p_limit - v_count, 0), v_start + make_interval(secs => p_window_seconds);
END;
$$;
REVOKE ALL ON FUNCTION public.rate_limit_hit(text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(text, int, int) TO service_role;

-- Self-check 0019-rate-limiter: the first `limit` hits in a window are allowed with a falling remaining count and the next is refused; keys
-- are independent; reset_at is the end of the window; a bad argument is refused; the cleanup deletes an old window within 50 calls and
-- keeps the current one; and no client role holds any privilege on the table or the function.
DO $$
DECLARE r record; i int; k text := 'selfcheck-0019-' || clock_timestamp()::text; other text := k || '-other';
BEGIN
  FOR i IN 1..3 LOOP
    SELECT * INTO r FROM public.rate_limit_hit(k, 3, 60);
    IF NOT r.allowed OR r.remaining <> 3 - i THEN RAISE EXCEPTION '0019-rate-limiter: hit % gave allowed=%, remaining=%', i, r.allowed, r.remaining; END IF;
  END LOOP;
  SELECT * INTO r FROM public.rate_limit_hit(k, 3, 60);
  IF r.allowed OR r.remaining <> 0 THEN RAISE EXCEPTION '0019-rate-limiter: the fourth hit was allowed (remaining %)', r.remaining; END IF;
  IF r.reset_at <= now() OR r.reset_at > now() + interval '60 seconds' THEN RAISE EXCEPTION '0019-rate-limiter: reset_at % is not inside the window', r.reset_at; END IF;
  SELECT * INTO r FROM public.rate_limit_hit(other, 3, 60);
  IF NOT r.allowed OR r.remaining <> 2 THEN RAISE EXCEPTION '0019-rate-limiter: keys are not independent'; END IF;
  BEGIN
    PERFORM * FROM public.rate_limit_hit(k, 0, 60);
    RAISE EXCEPTION '0019-rate-limiter: a limit of 0 was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.rate_limit_hit('', 3, 60);
    RAISE EXCEPTION '0019-rate-limiter: an empty key was accepted';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
  INSERT INTO public.rate_limit_windows (key, window_start, count) VALUES (k || '-old', now() - interval '3 hours', 9);
  FOR i IN 1..50 LOOP PERFORM * FROM public.rate_limit_hit(other, 1000, 60); END LOOP;
  IF EXISTS (SELECT 1 FROM public.rate_limit_windows WHERE key = k || '-old') THEN RAISE EXCEPTION '0019-rate-limiter: the cleanup did not delete a three-hour-old window within 50 calls'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.rate_limit_windows WHERE key = k) THEN RAISE EXCEPTION '0019-rate-limiter: the cleanup deleted the current window'; END IF;
  IF has_table_privilege('anon', 'public.rate_limit_windows', 'SELECT') OR has_table_privilege('authenticated', 'public.rate_limit_windows', 'SELECT')
     OR has_function_privilege('anon', 'public.rate_limit_hit(text,int,int)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.rate_limit_hit(text,int,int)', 'EXECUTE') THEN
    RAISE EXCEPTION '0019-rate-limiter: a client role holds a privilege';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.rate_limit_hit(text,int,int)', 'EXECUTE') THEN RAISE EXCEPTION '0019-rate-limiter: service_role cannot call it'; END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rate_limit_windows'::regclass) THEN RAISE EXCEPTION '0019-rate-limiter: RLS is off'; END IF;
  DELETE FROM public.rate_limit_windows WHERE key IN (k, other, k || '-old');
  RAISE NOTICE '0019-rate-limiter OK';
END $$;

COMMIT;
