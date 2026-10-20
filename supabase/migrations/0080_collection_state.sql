-- 0080 collection state, reuse terms, capture hash, channel and locale (R2c C5, C6, C7, addendum D).
--
-- The collection ladder (declared channel, direct GET under the honest identity, the browser tier, a substitute publisher) ends in one of five states the registry now holds as data, so a page can say what happened to a source:
--   sources.collection_state   unattempted (default) | served | deferred (robots.txt unknown or the host asked for a long gap: tried again later, never denied) | robots_disallowed (the rule text is in collection_detail)
--                              | refused (the direct GET was refused by a wall; the browser tier has not run yet) | access_requested (every channel was tried and refused: the publisher contact is recorded)
--   sources.collection_detail  jsonb object: the last attempt record, each attempt carrying its channel name (api, feed, sitemap, direct, browser, substitute), the robots rule, the substitute host
--   sources.access_requested_at / access_contact   set together with the state access_requested and only then (the CHECK says so); the contact is the one the publisher publishes, null when none is published
--   sources.reuse_terms        the rights verdict of the publisher: open_government | eu_reuse | public_domain | licensed | unknown (default) | prohibited. A span from an unknown or prohibited source is capped (src/core/sources/quotation.ts)
-- pending_first_fetch.status gains `refused`: the capture worker (Edge Function, no browser) hands a walled source to the Actions runner browser tier by leaving the row there. The one-open-row index treats it as open.
-- agent_run_searches gains content_hash (sha256 of the stored text) and capture_channel: the worker idempotency is (final URL, content hash), so a requeued refresh with a changed body captures and an unchanged one reports unchanged.
-- agent_run_searches.number_locale is the BCP-47 language of the captured document (the publisher's declared locale, else the document's lang attribute or Content-Language, else null: never a guess); sources.publisher_locale is the
-- publisher's declared locale the registry holds (null until ruled).
-- Access: no new object; sources and agent_run_searches keep their policies and grants. Not applied to production before the cutover window.
--
-- Reversal: ALTER TABLE public.agent_run_searches DROP COLUMN capture_channel, DROP COLUMN content_hash; restore pending_first_fetch_status_check without 'refused' (valid only while no row is refused);
-- ALTER TABLE public.sources DROP COLUMN collection_state, DROP COLUMN collection_detail, DROP COLUMN access_requested_at, DROP COLUMN access_contact, DROP COLUMN reuse_terms, DROP COLUMN publisher_locale; ALTER TABLE public.agent_run_searches DROP COLUMN number_locale (down/0080.sql does all of it).

-- catalog: column, constraint, index

BEGIN;

ALTER TABLE public.sources
  ADD COLUMN reuse_terms text NOT NULL DEFAULT 'unknown',
  ADD COLUMN collection_state text NOT NULL DEFAULT 'unattempted',
  ADD COLUMN collection_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN access_requested_at timestamptz,
  ADD COLUMN access_contact text,
  ADD COLUMN publisher_locale text,
  ADD CONSTRAINT sources_reuse_terms_check CHECK (reuse_terms = ANY (ARRAY['open_government', 'eu_reuse', 'public_domain', 'licensed', 'unknown', 'prohibited'])),
  ADD CONSTRAINT sources_collection_state_check CHECK (collection_state = ANY (ARRAY['unattempted', 'served', 'deferred', 'robots_disallowed', 'refused', 'access_requested'])),
  ADD CONSTRAINT sources_collection_detail_object_check CHECK (jsonb_typeof(collection_detail) = 'object'),
  ADD CONSTRAINT sources_access_requested_pair_check CHECK ((collection_state = 'access_requested') = (access_requested_at IS NOT NULL)),
  ADD CONSTRAINT sources_publisher_locale_check CHECK (publisher_locale IS NULL OR publisher_locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$');
COMMENT ON COLUMN public.sources.collection_state IS 'Where the collection ladder left this source (migration 0080): unattempted, served, deferred, robots_disallowed, refused (browser tier pending) or access_requested. A page states it in words; collection_detail holds the attempt record.';
COMMENT ON COLUMN public.sources.reuse_terms IS 'The publisher rights verdict (migration 0080): open_government, eu_reuse, public_domain, licensed, unknown or prohibited. Set by the host-class table where the class fixes it, unknown otherwise; an unknown or prohibited source is quoted only up to the configured length, with the attribution the registry holds.';
COMMENT ON COLUMN public.sources.access_contact IS 'The contact the publisher itself publishes for access requests (from its page or robots.txt); null when none is published. Set with collection_state = access_requested.';

ALTER TABLE public.pending_first_fetch DROP CONSTRAINT pending_first_fetch_status_check;
ALTER TABLE public.pending_first_fetch ADD CONSTRAINT pending_first_fetch_status_check CHECK (status = ANY (ARRAY['queued', 'fetching', 'done', 'error', 'skipped', 'refused']));

ALTER TABLE public.agent_run_searches
  ADD COLUMN content_hash text,
  ADD COLUMN capture_channel text,
  ADD COLUMN number_locale text,
  ADD CONSTRAINT agent_run_searches_capture_channel_check CHECK (capture_channel IS NULL OR capture_channel = ANY (ARRAY['api', 'feed', 'sitemap', 'direct', 'browser', 'substitute'])),
  ADD CONSTRAINT agent_run_searches_content_hash_check CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT agent_run_searches_number_locale_check CHECK (number_locale IS NULL OR number_locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$');
CREATE INDEX agent_run_searches_url_hash_idx ON public.agent_run_searches (result_url, content_hash) WHERE search_query = 'capture-worker:first-fetch';
COMMENT ON COLUMN public.agent_run_searches.content_hash IS 'sha256 (hex) of result_content for a capture-worker row (migration 0080). The worker idempotency key is (result_url, content_hash); null on rows captured before it.';
COMMENT ON COLUMN public.agent_run_searches.number_locale IS 'The BCP-47 language of the captured document (migration 0080): the publisher declared locale (sources.publisher_locale), else the document lang attribute or Content-Language, else null. Never a guess.';
COMMENT ON COLUMN public.sources.publisher_locale IS 'The publisher declared locale, BCP-47 (migration 0080); null until ruled.';
COMMENT ON COLUMN public.agent_run_searches.capture_channel IS 'The channel that produced a capture-worker row (migration 0080): api, feed, sitemap, direct, browser or substitute.';

-- Self-check 0080-collection-state, in a fixture that rolls back: THE ATTACK ON THE PAIR: access_requested without a date, and a date without the state, are each refused; THE ATTACK ON THE VOCABULARY: an unknown state, an unknown
-- reuse term and a non-object detail are refused; THE ATTACK ON THE HASH: a hash that is not 64 hex characters and an unknown channel (an archive) are refused; the new queue status is accepted and a made-up one is not; THE ATTACK ON THE LOCALE: a language name and an underscore tag are refused, a BCP-47 tag is kept.
DO $$
DECLARE sid uuid;
BEGIN
  BEGIN
    INSERT INTO public.sources (name, url, base_tier, tier_at_creation) VALUES ('selfcheck 0080', 'https://selfcheck-0080.invalid/a', 2, 2) RETURNING id INTO sid;
    IF (SELECT collection_state FROM public.sources WHERE id = sid) <> 'unattempted' OR (SELECT reuse_terms FROM public.sources WHERE id = sid) <> 'unknown' THEN RAISE EXCEPTION '0080-collection-state: the defaults are wrong'; END IF;
    BEGIN UPDATE public.sources SET collection_state = 'access_requested' WHERE id = sid; RAISE EXCEPTION '0080-collection-state: access_requested was accepted without a date';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.sources SET access_requested_at = now() WHERE id = sid; RAISE EXCEPTION '0080-collection-state: a request date was accepted without the state';
    EXCEPTION WHEN check_violation THEN NULL; END;
    UPDATE public.sources SET collection_state = 'access_requested', access_requested_at = now(), access_contact = NULL WHERE id = sid;
    BEGIN UPDATE public.sources SET collection_state = 'banished' WHERE id = sid; RAISE EXCEPTION '0080-collection-state: an unknown state was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.sources SET reuse_terms = 'free_for_all' WHERE id = sid; RAISE EXCEPTION '0080-collection-state: an unknown reuse term was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.sources SET collection_detail = '[]'::jsonb WHERE id = sid; RAISE EXCEPTION '0080-collection-state: a non-object detail was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.agent_run_searches (search_query, result_url, content_hash) VALUES ('capture-worker:first-fetch', 'https://selfcheck-0080.invalid/a', 'not-a-hash'); RAISE EXCEPTION '0080-collection-state: a malformed hash was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.agent_run_searches (search_query, result_url, capture_channel) VALUES ('capture-worker:first-fetch', 'https://selfcheck-0080.invalid/a', 'wayback'); RAISE EXCEPTION '0080-collection-state: an archive channel was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO public.agent_run_searches (search_query, result_url, number_locale) VALUES ('capture-worker:first-fetch', 'https://selfcheck-0080.invalid/a', 'English'); RAISE EXCEPTION '0080-collection-state: a language name was accepted as a locale';
    EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.sources SET publisher_locale = 'en_GB' WHERE id = sid; RAISE EXCEPTION '0080-collection-state: a malformed publisher locale was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    UPDATE public.sources SET publisher_locale = 'de-AT' WHERE id = sid;
    INSERT INTO public.agent_run_searches (search_query, result_url, content_hash, capture_channel, number_locale) VALUES ('capture-worker:first-fetch', 'https://selfcheck-0080.invalid/a', repeat('a', 64), 'browser', 'pt-BR');
    UPDATE public.sources SET collection_state = 'unattempted', access_requested_at = NULL WHERE id = sid;
    DELETE FROM public.pending_first_fetch WHERE source_id = sid;
    INSERT INTO public.pending_first_fetch (source_id, status) VALUES (sid, 'refused');
    BEGIN UPDATE public.pending_first_fetch SET status = 'lost' WHERE source_id = sid; RAISE EXCEPTION '0080-collection-state: a made-up queue status was accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
    RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = 'selfcheck fixture rolled back';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  RAISE NOTICE '0080-collection-state OK';
END $$;

COMMIT;
