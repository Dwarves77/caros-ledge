-- 0074 ledger claim writers (R2b, MASTER I1; register D:1, 2, 3, 4, 21, 38, 46, 144).
--
-- Heal, rehome, the grounder, sectionBrief and erase each changed or deleted claims with their own statements: the tier of an item's own source was stamped on a span cut from another host's capture, source_id and
-- search_result_id moved separately, claim_versions was written by some paths and not others, the version number was read and then written by two statements, and a section delete cascaded its claims away unarchived.
-- This file is the one home of those writes, every one a single call, a single transaction, archive first:
--   ledger_attribution(source, capture, span)        -> (tier, problem): the one rule that ties a FACT to the capture that holds its span. The capture must exist and hold the span (criterion 3's own test);
--                                                       the source must exist, not be suspended, and be registered on the capture's host (or a host of the same registrable family); the TIER is derived here from that
--                                                       source row (override, else base tier), never passed in. With no source the tier is NULL, and only when no registered source sits on the capture's host.
--   ledger_write_claim(item, claim|NULL, row, reason, batch, now) -> add (claim NULL) or change (the prior state goes to claim_versions FIRST, the version number computed under the claim's row lock).
--   ledger_remove_claim(claim, reason, proof, note, now)         -> archive, then delete (a proven erase, a replaced ledger, an orphaned claim).
--   ledger_apply_ops(item, ops, now)                             -> an ordered list of claim writes, removals, section writes and a brief write applied as ONE transaction (heal and rehome: all or nothing).
--   ledger_reconcile_sections(item, sections, now)               -> the sections of a brief by key; the claims of a vanished section are archived before the section goes.
--   ledger_erase_item(item, disposition, merged_into, holder, now) -> the tombstone, every claim archived, then the item, in one transaction.
--   ledger_attribution_violations(item)                          -> the claims whose stored (source, tier, capture) do not resolve to the capture that holds their span (INV-R2b-1's verifier).
-- Executable by service_role only. Not applied to production before the cutover window (data and code ship together, two-track policy).
--
-- Reversal: DROP FUNCTION public.ledger_erase_item(uuid, text, uuid, text, timestamptz), public.ledger_apply_ops(uuid, jsonb, timestamptz), public.ledger_reconcile_sections(uuid, jsonb, timestamptz), public.ledger_remove_claim(uuid, text, jsonb, text, timestamptz),
-- public.ledger_write_claim(uuid, uuid, jsonb, text, text, timestamptz), public.ledger_attribution_violations(uuid), public.ledger_attribution(uuid, uuid, text), public.ledger_hosts_related(text, text), public.ledger_host_of(text).

-- catalog: function

BEGIN;

CREATE FUNCTION public.ledger_host_of(p_url text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT regexp_replace(regexp_replace(regexp_replace(lower(coalesce(substring(p_url from '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)'), '')), '^[^@]*@', ''), ':[0-9]*$', ''), '^www\.', '')
$$;

CREATE FUNCTION public.ledger_hosts_related(p_a text, p_b text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT coalesce(p_a, '') <> '' AND coalesce(p_b, '') <> '' AND (p_a = p_b OR p_a LIKE '%.' || p_b OR p_b LIKE '%.' || p_a)
$$;

CREATE FUNCTION public.ledger_attribution(p_source_id uuid, p_capture_id uuid, p_span text, OUT tier integer, OUT problem text)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  cap record;
  src record;
  chost text;
BEGIN
  tier := NULL;
  problem := NULL;
  IF p_capture_id IS NULL THEN problem := 'fact_missing_capture'; RETURN; END IF;
  IF p_span IS NULL OR btrim(p_span) = '' THEN problem := 'fact_missing_span'; RETURN; END IF;
  SELECT result_url, result_content INTO cap FROM public.agent_run_searches WHERE id = p_capture_id;
  IF NOT FOUND THEN problem := 'capture_missing'; RETURN; END IF;
  IF cap.result_content IS NULL OR position(lower(btrim(p_span)) IN lower(cap.result_content)) = 0 THEN problem := 'span_not_in_capture'; RETURN; END IF;
  chost := public.ledger_host_of(cap.result_url);
  IF p_source_id IS NULL THEN
    IF chost <> '' AND EXISTS (SELECT 1 FROM public.sources s WHERE s.status <> 'suspended' AND s.url ILIKE '%' || chost || '%' AND public.ledger_hosts_related(public.ledger_host_of(s.url), chost)) THEN
      problem := 'source_resolvable';
    END IF;
    RETURN;
  END IF;
  SELECT url, base_tier, tier_override, status INTO src FROM public.sources WHERE id = p_source_id;
  IF NOT FOUND THEN problem := 'source_missing'; RETURN; END IF;
  IF src.status = 'suspended' THEN problem := 'source_suspended'; RETURN; END IF;
  IF NOT public.ledger_hosts_related(public.ledger_host_of(src.url), chost) THEN problem := 'source_host_mismatch'; RETURN; END IF;
  tier := coalesce(src.tier_override, src.base_tier);
END;
$$;

CREATE FUNCTION public.ledger_attribution_violations(p_item_id uuid) RETURNS TABLE(claim_id uuid, reason text)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT c.id,
         coalesce(a.problem, CASE WHEN c.source_tier_at_grounding IS DISTINCT FROM a.tier THEN 'tier_not_the_sources' END)
    FROM public.section_claim_provenance c
    CROSS JOIN LATERAL public.ledger_attribution(c.source_id, c.search_result_id, c.source_span) a
   WHERE c.intelligence_item_id = p_item_id AND c.claim_kind = 'FACT'
     AND (a.problem IS NOT NULL OR c.source_tier_at_grounding IS DISTINCT FROM a.tier)
$$;

CREATE FUNCTION public.ledger_write_claim(p_item_id uuid, p_claim_id uuid, p_row jsonb, p_reason text, p_batch text, p_now timestamptz) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  old public.section_claim_provenance;
  v_text text;
  v_kind text;
  v_span text;
  v_src uuid;
  v_cap uuid;
  v_section uuid;
  v_hold text;
  v_tier integer;
  v_att record;
  v_ver integer;
  v_id uuid;
  v_at timestamptz := coalesce(p_now, now());
BEGIN
  IF p_item_id IS NULL OR p_row IS NULL OR jsonb_typeof(p_row) <> 'object' THEN
    RAISE EXCEPTION 'ledger_write_claim needs an item and a row object' USING ERRCODE = '22023';
  END IF;
  IF p_claim_id IS NOT NULL THEN
    SELECT * INTO old FROM public.section_claim_provenance WHERE id = p_claim_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'claim % not found', p_claim_id USING ERRCODE = 'P0002'; END IF;
    IF old.intelligence_item_id IS DISTINCT FROM p_item_id THEN RAISE EXCEPTION 'claim % belongs to another item', p_claim_id USING ERRCODE = '22023'; END IF;
    IF coalesce(p_reason, 'changed') <> 'changed' THEN RAISE EXCEPTION 'a change is archived as changed, not %', p_reason USING ERRCODE = '22023'; END IF;
  END IF;
  v_text := CASE WHEN p_row ? 'claim_text' THEN p_row ->> 'claim_text' ELSE old.claim_text END;
  v_kind := CASE WHEN p_row ? 'claim_kind' THEN p_row ->> 'claim_kind' ELSE old.claim_kind END;
  v_span := CASE WHEN p_row ? 'source_span' THEN p_row ->> 'source_span' ELSE old.source_span END;
  v_src := CASE WHEN p_row ? 'source_id' THEN (p_row ->> 'source_id')::uuid ELSE old.source_id END;
  v_cap := CASE WHEN p_row ? 'search_result_id' THEN (p_row ->> 'search_result_id')::uuid ELSE old.search_result_id END;
  v_section := CASE WHEN p_row ? 'section_row_id' THEN (p_row ->> 'section_row_id')::uuid ELSE old.section_row_id END;
  v_hold := CASE WHEN p_row ? 'mint_hold_reason' THEN p_row ->> 'mint_hold_reason' ELSE old.mint_hold_reason END;
  IF v_text IS NULL OR btrim(v_text) = '' THEN RAISE EXCEPTION 'a claim needs its text' USING ERRCODE = '22023'; END IF;
  IF v_kind IS NULL THEN RAISE EXCEPTION 'a claim needs its kind' USING ERRCODE = '22023'; END IF;
  IF v_kind = 'FACT' THEN
    SELECT * INTO v_att FROM public.ledger_attribution(v_src, v_cap, v_span);
    IF v_att.problem IS NOT NULL THEN RAISE EXCEPTION 'attribution refused: %', v_att.problem USING ERRCODE = '22023'; END IF;
    v_tier := v_att.tier;
  ELSE
    v_tier := NULL;
  END IF;
  IF p_claim_id IS NOT NULL THEN
    SELECT coalesce(max(version_number), 0) + 1 INTO v_ver FROM public.claim_versions WHERE current_claim_id = p_claim_id;
    INSERT INTO public.claim_versions (current_claim_id, intelligence_item_id, section_row_id, claim_text, claim_kind, source_span, source_id, search_result_id, source_tier_at_grounding, mint_hold_reason, version_number, supersede_reason, inaccuracy_proof, note, superseded_at)
    VALUES (old.id, old.intelligence_item_id, old.section_row_id, old.claim_text, old.claim_kind, old.source_span, old.source_id, old.search_result_id, old.source_tier_at_grounding, old.mint_hold_reason, v_ver, 'changed', NULL, p_batch, v_at);
    UPDATE public.section_claim_provenance
       SET section_row_id = v_section, claim_text = v_text, claim_kind = v_kind, source_span = v_span, source_id = v_src, search_result_id = v_cap, source_tier_at_grounding = v_tier, mint_hold_reason = v_hold
     WHERE id = p_claim_id;
    v_id := p_claim_id;
  ELSE
    INSERT INTO public.section_claim_provenance (intelligence_item_id, section_row_id, claim_text, claim_kind, source_span, source_id, search_result_id, source_tier_at_grounding, mint_hold_reason)
    VALUES (p_item_id, v_section, v_text, v_kind, v_span, v_src, v_cap, v_tier, v_hold)
    RETURNING id INTO v_id;
  END IF;
  RETURN jsonb_build_object('id', v_id, 'version', v_ver, 'tier', v_tier);
END;
$$;

CREATE FUNCTION public.ledger_remove_claim(p_claim_id uuid, p_reason text, p_proof jsonb, p_note text, p_now timestamptz) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  old public.section_claim_provenance;
  v_ver integer;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('proven_inaccurate', 'superseded_by_record_briefs', 'orphaned_no_prose_referent') THEN
    RAISE EXCEPTION 'a claim leaves the ledger only as proven_inaccurate, superseded_by_record_briefs or orphaned_no_prose_referent (got %)', p_reason USING ERRCODE = '22023';
  END IF;
  IF p_reason <> 'superseded_by_record_briefs' AND (p_proof IS NULL OR jsonb_typeof(p_proof) <> 'object' OR coalesce(p_proof ->> 'reason', '') = '') THEN
    RAISE EXCEPTION 'removing a claim as % needs a proof object with a reason', p_reason USING ERRCODE = '22023';
  END IF;
  SELECT * INTO old FROM public.section_claim_provenance WHERE id = p_claim_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'claim % not found', p_claim_id USING ERRCODE = 'P0002'; END IF;
  SELECT coalesce(max(version_number), 0) + 1 INTO v_ver FROM public.claim_versions WHERE current_claim_id = p_claim_id;
  INSERT INTO public.claim_versions (current_claim_id, intelligence_item_id, section_row_id, claim_text, claim_kind, source_span, source_id, search_result_id, source_tier_at_grounding, mint_hold_reason, version_number, supersede_reason, inaccuracy_proof, note, superseded_at)
  VALUES (CASE WHEN p_reason = 'orphaned_no_prose_referent' THEN old.id ELSE NULL END, old.intelligence_item_id, old.section_row_id, old.claim_text, old.claim_kind, old.source_span, old.source_id, old.search_result_id, old.source_tier_at_grounding, old.mint_hold_reason, v_ver, p_reason, p_proof, p_note, coalesce(p_now, now()));
  DELETE FROM public.section_claim_provenance WHERE id = p_claim_id;
  RETURN v_ver;
END;
$$;

CREATE FUNCTION public.ledger_apply_ops(p_item_id uuid, p_ops jsonb, p_now timestamptz) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  o jsonb;
  kind text;
  v_claims integer := 0;
  v_removed integer := 0;
  v_sections integer := 0;
BEGIN
  IF p_item_id IS NULL OR p_ops IS NULL OR jsonb_typeof(p_ops) <> 'array' THEN
    RAISE EXCEPTION 'ledger_apply_ops needs an item and an ops array' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.intelligence_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item % not found', p_item_id USING ERRCODE = 'P0002'; END IF;
  FOR o IN SELECT value FROM jsonb_array_elements(p_ops) LOOP
    kind := o ->> 'op';
    IF kind = 'claim' THEN
      PERFORM public.ledger_write_claim(p_item_id, (o ->> 'claim_id')::uuid, o -> 'row', coalesce(o ->> 'reason', 'changed'), o ->> 'note', p_now);
      v_claims := v_claims + 1;
    ELSIF kind = 'remove' THEN
      PERFORM public.ledger_remove_claim((o ->> 'claim_id')::uuid, o ->> 'reason', o -> 'proof', o ->> 'note', p_now);
      v_removed := v_removed + 1;
    ELSIF kind = 'section_insert' THEN
      INSERT INTO public.intelligence_item_sections (id, item_id, section_key, section_order, content_md, is_conditional)
      VALUES ((o ->> 'id')::uuid, p_item_id, o ->> 'section_key', (o ->> 'section_order')::int, o ->> 'content_md', coalesce((o ->> 'is_conditional')::boolean, false));
      v_sections := v_sections + 1;
    ELSIF kind = 'section_content' THEN
      UPDATE public.intelligence_item_sections SET content_md = o ->> 'content_md' WHERE id = (o ->> 'id')::uuid AND item_id = p_item_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'section % of item % not found', o ->> 'id', p_item_id USING ERRCODE = 'P0002'; END IF;
      v_sections := v_sections + 1;
    ELSIF kind = 'brief' THEN
      UPDATE public.intelligence_items SET full_brief = o ->> 'full_brief' WHERE id = p_item_id;
    ELSE
      RAISE EXCEPTION 'unknown ledger op %', kind USING ERRCODE = '22023';
    END IF;
  END LOOP;
  RETURN jsonb_build_object('claims', v_claims, 'removed', v_removed, 'sections', v_sections);
END;
$$;

CREATE FUNCTION public.ledger_reconcile_sections(p_item_id uuid, p_sections jsonb, p_now timestamptz) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  s record;
  v_keys text[];
  v_removed integer := 0;
  v_archived integer := 0;
  v_updated integer := 0;
  v_inserted integer := 0;
  n integer;
BEGIN
  IF p_item_id IS NULL OR p_sections IS NULL OR jsonb_typeof(p_sections) <> 'array' OR jsonb_array_length(p_sections) = 0 THEN
    RAISE EXCEPTION 'ledger_reconcile_sections needs an item and a non-empty sections array' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.intelligence_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item % not found', p_item_id USING ERRCODE = 'P0002'; END IF;
  SELECT array_agg(e ->> 'section_key') INTO v_keys FROM jsonb_array_elements(p_sections) e;
  IF EXISTS (SELECT 1 FROM unnest(v_keys) k WHERE k IS NULL OR k = '') OR (SELECT count(DISTINCT k) FROM unnest(v_keys) k) <> cardinality(v_keys) THEN
    RAISE EXCEPTION 'every section needs a distinct section_key' USING ERRCODE = '22023';
  END IF;
  FOR s IN SELECT id, section_key FROM public.intelligence_item_sections WHERE item_id = p_item_id AND NOT (section_key = ANY (v_keys)) ORDER BY section_key FOR UPDATE LOOP
    INSERT INTO public.claim_versions (current_claim_id, intelligence_item_id, section_row_id, claim_text, claim_kind, source_span, source_id, search_result_id, source_tier_at_grounding, mint_hold_reason, version_number, supersede_reason, inaccuracy_proof, note, superseded_at)
    SELECT c.id, c.intelligence_item_id, c.section_row_id, c.claim_text, c.claim_kind, c.source_span, c.source_id, c.search_result_id, c.source_tier_at_grounding, c.mint_hold_reason,
           coalesce((SELECT max(version_number) FROM public.claim_versions v WHERE v.current_claim_id = c.id), 0) + 1,
           'orphaned_no_prose_referent', jsonb_build_object('reason', 'section_removed', 'section_key', s.section_key), NULL, coalesce(p_now, now())
      FROM public.section_claim_provenance c WHERE c.section_row_id = s.id;
    GET DIAGNOSTICS n = ROW_COUNT;
    v_archived := v_archived + n;
    DELETE FROM public.intelligence_item_sections WHERE id = s.id;
    v_removed := v_removed + 1;
  END LOOP;
  FOR s IN SELECT e ->> 'section_key' AS section_key, (e ->> 'section_order')::int AS section_order, e ->> 'content_md' AS content_md, coalesce((e ->> 'is_conditional')::boolean, false) AS is_conditional FROM jsonb_array_elements(p_sections) e LOOP
    UPDATE public.intelligence_item_sections SET section_order = s.section_order, content_md = s.content_md, is_conditional = s.is_conditional WHERE item_id = p_item_id AND section_key = s.section_key;
    IF FOUND THEN v_updated := v_updated + 1;
    ELSE
      INSERT INTO public.intelligence_item_sections (item_id, section_key, section_order, content_md, is_conditional) VALUES (p_item_id, s.section_key, s.section_order, s.content_md, s.is_conditional);
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('removed', v_removed, 'claims_archived', v_archived, 'updated', v_updated, 'inserted', v_inserted);
END;
$$;

CREATE FUNCTION public.ledger_erase_item(p_item_id uuid, p_disposition text, p_merged_into uuid, p_holder text, p_now timestamptz) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  it public.intelligence_items;
  v_archived integer;
BEGIN
  IF coalesce(btrim(p_disposition), '') = '' OR coalesce(btrim(p_holder), '') = '' THEN
    RAISE EXCEPTION 'an erase needs a disposition and a holder' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO it FROM public.intelligence_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'item % not found', p_item_id USING ERRCODE = 'P0002'; END IF;
  INSERT INTO public.disposition_ledger (intelligence_item_id, item_key, canonical_instrument_key, title, source_url, archive_reason, disposition, merged_into_item_id, snapshot_pointer, disposition_by, disposition_date)
  VALUES (it.id, it.legacy_id, it.canonical_instrument_key, it.title, it.source_url, it.archive_reason, p_disposition, p_merged_into, it.source_id::text, p_holder, coalesce(p_now, now()));
  INSERT INTO public.claim_versions (current_claim_id, intelligence_item_id, section_row_id, claim_text, claim_kind, source_span, source_id, search_result_id, source_tier_at_grounding, mint_hold_reason, version_number, supersede_reason, inaccuracy_proof, note, superseded_at)
  SELECT c.id, c.intelligence_item_id, c.section_row_id, c.claim_text, c.claim_kind, c.source_span, c.source_id, c.search_result_id, c.source_tier_at_grounding, c.mint_hold_reason,
         coalesce((SELECT max(version_number) FROM public.claim_versions v WHERE v.current_claim_id = c.id), 0) + 1,
         'orphaned_no_prose_referent', jsonb_build_object('reason', 'item_erased', 'disposition', p_disposition), p_holder, coalesce(p_now, now())
    FROM public.section_claim_provenance c WHERE c.intelligence_item_id = it.id;
  GET DIAGNOSTICS v_archived = ROW_COUNT;
  DELETE FROM public.intelligence_items WHERE id = it.id;
  RETURN jsonb_build_object('claims_archived', v_archived);
END;
$$;

REVOKE ALL ON FUNCTION public.ledger_host_of(text), public.ledger_hosts_related(text, text), public.ledger_attribution(uuid, uuid, text), public.ledger_attribution_violations(uuid),
  public.ledger_write_claim(uuid, uuid, jsonb, text, text, timestamptz), public.ledger_remove_claim(uuid, text, jsonb, text, timestamptz), public.ledger_apply_ops(uuid, jsonb, timestamptz),
  public.ledger_reconcile_sections(uuid, jsonb, timestamptz), public.ledger_erase_item(uuid, text, uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ledger_host_of(text), public.ledger_hosts_related(text, text), public.ledger_attribution(uuid, uuid, text), public.ledger_attribution_violations(uuid),
  public.ledger_write_claim(uuid, uuid, jsonb, text, text, timestamptz), public.ledger_remove_claim(uuid, text, jsonb, text, timestamptz), public.ledger_apply_ops(uuid, jsonb, timestamptz),
  public.ledger_reconcile_sections(uuid, jsonb, timestamptz), public.ledger_erase_item(uuid, text, uuid, text, timestamptz) TO service_role;

COMMENT ON FUNCTION public.ledger_write_claim(uuid, uuid, jsonb, text, text, timestamptz) IS 'The one claim writer (R2b 0074): add or change a ledger claim; a FACT is accepted only when its capture holds its span and its source is registered on the capture host, the tier is derived from that source, the prior state is archived first.';

-- Self-check 0074-ledger-writers: real rows as the production-shaped role, rolled back by a sentinel. Attacks: a tier cannot be laundered (a span from a capture on host B with a source registered on host A is refused, a
-- span the capture lacks is refused, a suspended or missing source is refused, an unrated host is accepted only with NO source and only when no registered source sits on it); a change archives the prior state first
-- with the next version number; an INJECTED FAILURE after the archive (a trigger that refuses the update) leaves the claim and claim_versions byte-identical; a removal archives with its proof before the delete (a removal
-- with no proof is refused and keeps the claim); a reconcile archives the claims of a vanished section; an erase writes the tombstone, archives every claim and deletes the item, and an injected failure on the delete
-- leaves all three tables untouched; the verifier lists exactly the claims whose stored tier is not the source's; a client role cannot execute any of them.
DO $$
DECLARE
  v_item uuid := gen_random_uuid(); v_item2 uuid := gen_random_uuid();
  v_src_a uuid := gen_random_uuid(); v_src_b uuid := gen_random_uuid(); v_src_s uuid := gen_random_uuid();
  v_cap_a uuid := gen_random_uuid(); v_cap_b uuid := gen_random_uuid(); v_cap_c uuid := gen_random_uuid();
  v_sec uuid := gen_random_uuid(); v_sec_gone uuid := gen_random_uuid();
  v_sec_new uuid; v_sec3 uuid; r jsonb; v_claim uuid; v_claim2 uuid; n integer; before_cv integer; before_text text; v_msg text; fp text;
BEGIN
  BEGIN
    INSERT INTO public.sources (id, name, url, base_tier, tier_at_creation) VALUES
      (v_src_a, 'selfcheck-0074 a', 'https://www.regulator-0074.invalid/rules', 1, 1),
      (v_src_b, 'selfcheck-0074 b', 'https://news-0074.invalid/', 6, 6);
    INSERT INTO public.sources (id, name, url, base_tier, tier_at_creation, status) VALUES (v_src_s, 'selfcheck-0074 s', 'https://susp-0074.invalid/', 2, 2, 'suspended');
    INSERT INTO public.intelligence_items (id, title, domain, source_id) VALUES (v_item, 'selfcheck 0074', 1, v_src_a), (v_item2, 'selfcheck 0074 two', 1, v_src_a);
    INSERT INTO public.intelligence_item_sections (id, item_id, section_key, section_order, content_md) VALUES (v_sec, v_item, 'keep_0074', 1, 'kept'), (v_sec_gone, v_item, 'gone_0074', 2, 'vanishing');
    INSERT INTO public.agent_run_searches (id, intelligence_item_id, result_url, result_content, result_index) VALUES
      (v_cap_a, v_item, 'https://regulator-0074.invalid/rules/art4', 'Article 4 states that the limit is 91.16 grams per MJ for every ship.', 0),
      (v_cap_b, v_item, 'https://news-0074.invalid/story', 'A trade paper says the fine is EUR 5 per tonne.', 1),
      (v_cap_c, v_item, 'https://nowhere-0074.invalid/page', 'An unregistered host states the cap is 12 percent.', 2);

    -- INV-R2b-3's measure: a fingerprint of every table a ledger function touches (claims, their archive, the sections, the item, its tombstone), compared before and after each injected failure
    CREATE FUNCTION pg_temp.fp_0074(p_item uuid) RETURNS text LANGUAGE sql AS $f$
      SELECT md5(concat_ws('#',
        (SELECT coalesce(string_agg(c::text, '|' ORDER BY c::text), '') FROM public.section_claim_provenance c WHERE c.intelligence_item_id = p_item),
        (SELECT coalesce(string_agg(v::text, '|' ORDER BY v::text), '') FROM public.claim_versions v WHERE v.intelligence_item_id = p_item),
        (SELECT coalesce(string_agg(x::text, '|' ORDER BY x::text), '') FROM public.intelligence_item_sections x WHERE x.item_id = p_item),
        (SELECT coalesce(string_agg(i::text, '|' ORDER BY i::text), '') FROM public.intelligence_items i WHERE i.id = p_item),
        (SELECT coalesce(string_agg(d::text, '|' ORDER BY d::text), '') FROM public.disposition_ledger d WHERE d.intelligence_item_id = p_item))) $f$;

    -- the host helpers
    IF public.ledger_host_of('https://User:pw@WWW.Example.COM:8443/a?b#c') <> 'example.com' THEN RAISE EXCEPTION '0074-ledger-writers: host_of gave %', public.ledger_host_of('https://User:pw@WWW.Example.COM:8443/a?b#c'); END IF;
    IF NOT public.ledger_hosts_related('docs.example.com', 'example.com') OR public.ledger_hosts_related('badexample.com', 'example.com') OR public.ledger_hosts_related('', '') THEN
      RAISE EXCEPTION '0074-ledger-writers: hosts_related is wrong';
    END IF;

    -- attack 1: tier laundering. A span in the news capture, attributed to the regulator source (the item's own), is refused; so are a span the capture lacks, a suspended and a missing source.
    FOR n IN 1..4 LOOP
      BEGIN
        PERFORM public.ledger_write_claim(v_item, NULL, jsonb_build_object('section_row_id', v_sec, 'claim_text', 'x ' || n, 'claim_kind', 'FACT',
          'source_span', CASE n WHEN 1 THEN 'the fine is EUR 5 per tonne' WHEN 2 THEN 'a sentence the capture lacks' WHEN 3 THEN 'the limit is 91.16 grams' ELSE 'the limit is 91.16 grams' END,
          'source_id', CASE n WHEN 1 THEN v_src_a WHEN 2 THEN v_src_a WHEN 3 THEN v_src_s ELSE gen_random_uuid() END,
          'search_result_id', CASE n WHEN 1 THEN v_cap_b ELSE v_cap_a END), 'changed', NULL, now());
        RAISE EXCEPTION '0074-ledger-writers: attack % was accepted', n;
      EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    END LOOP;
    SELECT count(*) INTO n FROM public.section_claim_provenance WHERE intelligence_item_id = v_item;
    IF n <> 0 THEN RAISE EXCEPTION '0074-ledger-writers: % claim(s) were left by refused writes', n; END IF;
    -- an unrated host: no source accepted; a source on a different host refused; a source supplied for a host a registered source covers is required
    r := public.ledger_write_claim(v_item, NULL, jsonb_build_object('section_row_id', v_sec, 'claim_text', 'unrated', 'claim_kind', 'FACT', 'source_span', 'cap is 12 percent', 'source_id', NULL, 'search_result_id', v_cap_c), 'changed', NULL, now());
    IF (r ->> 'tier') IS NOT NULL THEN RAISE EXCEPTION '0074-ledger-writers: an unrated host got a tier'; END IF;
    BEGIN
      PERFORM public.ledger_write_claim(v_item, NULL, jsonb_build_object('claim_text', 'unrated b', 'claim_kind', 'FACT', 'source_span', 'cap is 12 percent', 'source_id', v_src_a, 'search_result_id', v_cap_c), 'changed', NULL, now());
      RAISE EXCEPTION '0074-ledger-writers: a registered source was attached to an unrelated capture';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    BEGIN
      PERFORM public.ledger_write_claim(v_item, NULL, jsonb_build_object('claim_text', 'rated but unsourced', 'claim_kind', 'FACT', 'source_span', 'the limit is 91.16 grams', 'source_id', NULL, 'search_result_id', v_cap_a), 'changed', NULL, now());
      RAISE EXCEPTION '0074-ledger-writers: a FACT on a registered host was written with no source';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

    -- the add: the tier is the source's own (1), not a number anyone passed
    r := public.ledger_write_claim(v_item, NULL, jsonb_build_object('section_row_id', v_sec, 'claim_text', 'The limit is 91.16 grams per MJ', 'claim_kind', 'FACT', 'source_span', 'THE LIMIT IS 91.16 GRAMS PER MJ', 'source_id', v_src_a, 'search_result_id', v_cap_a, 'source_tier_at_grounding', 6), 'changed', NULL, now());
    v_claim := (r ->> 'id')::uuid;
    IF (r ->> 'tier')::int <> 1 OR (SELECT source_tier_at_grounding FROM public.section_claim_provenance WHERE id = v_claim) <> 1 THEN RAISE EXCEPTION '0074-ledger-writers: the stored tier is not the source tier: %', r; END IF;

    -- a change archives the prior state FIRST with the next version number, in the same transaction
    r := public.ledger_write_claim(v_item, v_claim, jsonb_build_object('claim_text', 'The limit is 91.16 grams per MJ (restated)'), 'changed', 'selfcheck batch', now());
    IF (r ->> 'version')::int <> 1 THEN RAISE EXCEPTION '0074-ledger-writers: first archive version is %', r ->> 'version'; END IF;
    r := public.ledger_write_claim(v_item, v_claim, jsonb_build_object('claim_text', 'The limit is 91.16 grams per MJ (restated twice)'), 'changed', NULL, now());
    SELECT count(*), max(version_number), min(claim_text) INTO n, before_cv, before_text FROM public.claim_versions WHERE current_claim_id = v_claim;
    IF n <> 2 OR before_cv <> 2 OR before_text <> 'The limit is 91.16 grams per MJ' THEN RAISE EXCEPTION '0074-ledger-writers: archive rows % / max % / first text %', n, before_cv, before_text; END IF;
    BEGIN
      PERFORM public.ledger_write_claim(v_item2, v_claim, jsonb_build_object('claim_text', 'wrong item'), 'changed', NULL, now());
      RAISE EXCEPTION '0074-ledger-writers: a claim of another item was changed';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

    -- INV-R2b-3: an injected failure AFTER the archive (a trigger refusing the update) leaves the claim and the version table untouched
    CREATE FUNCTION pg_temp.inject_0074() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.claim_text LIKE '%INJECT%' THEN RAISE EXCEPTION 'injected 0074 failure' USING ERRCODE = 'P0042'; END IF; RETURN NEW; END $f$;
    CREATE TRIGGER inject_0074 BEFORE UPDATE OR DELETE ON public.section_claim_provenance FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_0074();
    SELECT count(*) INTO before_cv FROM public.claim_versions WHERE intelligence_item_id = v_item;
    SELECT claim_text INTO before_text FROM public.section_claim_provenance WHERE id = v_claim;
    fp := pg_temp.fp_0074(v_item);
    BEGIN
      PERFORM public.ledger_write_claim(v_item, v_claim, jsonb_build_object('claim_text', 'INJECT this'), 'changed', NULL, now());
      RAISE EXCEPTION '0074-ledger-writers: the injected failure did not fire';
    EXCEPTION WHEN SQLSTATE 'P0042' THEN NULL; END;
    SELECT count(*) INTO n FROM public.claim_versions WHERE intelligence_item_id = v_item;
    IF n <> before_cv OR (SELECT claim_text FROM public.section_claim_provenance WHERE id = v_claim) <> before_text OR pg_temp.fp_0074(v_item) <> fp THEN RAISE EXCEPTION '0074-ledger-writers: a failed change left a partial write (% archive rows, was %)', n, before_cv; END IF;
    DROP TRIGGER inject_0074 ON public.section_claim_provenance;
    DROP FUNCTION pg_temp.inject_0074();

    -- the verifier: a claim whose stored tier is not its source's, and a claim whose span the capture lost, are listed; a clean ledger lists nothing
    IF EXISTS (SELECT 1 FROM public.ledger_attribution_violations(v_item) WHERE claim_id = v_claim) THEN RAISE EXCEPTION '0074-ledger-writers: a clean claim was listed as a violation'; END IF;
    UPDATE public.section_claim_provenance SET source_tier_at_grounding = 6 WHERE id = v_claim;
    IF (SELECT reason FROM public.ledger_attribution_violations(v_item) WHERE claim_id = v_claim) IS DISTINCT FROM 'tier_not_the_sources' THEN RAISE EXCEPTION '0074-ledger-writers: a laundered tier was not listed'; END IF;
    UPDATE public.section_claim_provenance SET source_tier_at_grounding = 1, source_id = v_src_b WHERE id = v_claim;
    IF (SELECT reason FROM public.ledger_attribution_violations(v_item) WHERE claim_id = v_claim) IS DISTINCT FROM 'source_host_mismatch' THEN RAISE EXCEPTION '0074-ledger-writers: a mis-hosted source was not listed'; END IF;
    UPDATE public.section_claim_provenance SET source_id = v_src_a WHERE id = v_claim;

    -- a removal archives with its proof first; one with no proof is refused and keeps the claim
    BEGIN
      PERFORM public.ledger_remove_claim(v_claim, 'proven_inaccurate', NULL, NULL, now());
      RAISE EXCEPTION '0074-ledger-writers: a removal with no proof was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    IF NOT EXISTS (SELECT 1 FROM public.section_claim_provenance WHERE id = v_claim) THEN RAISE EXCEPTION '0074-ledger-writers: a refused removal deleted the claim'; END IF;
    n := public.ledger_remove_claim(v_claim, 'proven_inaccurate', '{"reason":"selfcheck"}'::jsonb, 'note', now());
    IF n <> 3 OR EXISTS (SELECT 1 FROM public.section_claim_provenance WHERE id = v_claim) OR (SELECT inaccuracy_proof ->> 'reason' FROM public.claim_versions WHERE version_number = 3 AND intelligence_item_id = v_item) <> 'selfcheck' THEN
      RAISE EXCEPTION '0074-ledger-writers: the proven erase did not archive then delete (version %)', n;
    END IF;

    -- reconcile: the claim of the vanished section is archived before the section goes; survivors update, new keys insert
    r := public.ledger_write_claim(v_item, NULL, jsonb_build_object('section_row_id', v_sec_gone, 'claim_text', 'a claim of the vanishing section', 'claim_kind', 'ANALYSIS'), 'changed', NULL, now());
    v_claim2 := (r ->> 'id')::uuid;
    r := public.ledger_reconcile_sections(v_item, '[{"section_key":"keep_0074","section_order":1,"content_md":"kept v2","is_conditional":false},{"section_key":"new_0074","section_order":3,"content_md":"new","is_conditional":true}]'::jsonb, now());
    IF r <> '{"removed": 1, "updated": 1, "inserted": 1, "claims_archived": 1}'::jsonb THEN RAISE EXCEPTION '0074-ledger-writers: reconcile gave %', r; END IF;
    IF EXISTS (SELECT 1 FROM public.section_claim_provenance WHERE id = v_claim2) OR NOT EXISTS (SELECT 1 FROM public.claim_versions WHERE current_claim_id = v_claim2 AND supersede_reason = 'orphaned_no_prose_referent' AND inaccuracy_proof ->> 'section_key' = 'gone_0074') THEN
      RAISE EXCEPTION '0074-ledger-writers: the vanished section lost its claim unarchived';
    END IF;
    BEGIN
      PERFORM public.ledger_reconcile_sections(v_item, '[]'::jsonb, now());
      RAISE EXCEPTION '0074-ledger-writers: an empty section list was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;

    -- erase: an injected failure on the delete leaves the tombstone, the archive and the item untouched; then the real erase does all three
    r := public.ledger_write_claim(v_item, NULL, jsonb_build_object('section_row_id', v_sec, 'claim_text', 'survivor', 'claim_kind', 'ANALYSIS'), 'changed', NULL, now());
    v_claim2 := (r ->> 'id')::uuid;

    -- apply_ops: a list is all or nothing. A good section and claim followed by a refused FACT (a span the capture lacks) leave nothing; the good list applies in order (a section, a claim in it, a change that archives, a brief)
    v_sec_new := gen_random_uuid();
    BEGIN
      PERFORM public.ledger_apply_ops(v_item, jsonb_build_array(
        jsonb_build_object('op', 'section_insert', 'id', v_sec_new, 'section_key', 'ops_0074', 'section_order', 9, 'content_md', 'ops'),
        jsonb_build_object('op', 'claim', 'claim_id', NULL, 'row', jsonb_build_object('section_row_id', v_sec_new, 'claim_text', 'good claim', 'claim_kind', 'ANALYSIS')),
        jsonb_build_object('op', 'claim', 'claim_id', NULL, 'row', jsonb_build_object('claim_text', 'bad claim', 'claim_kind', 'FACT', 'source_span', 'not in the capture', 'source_id', v_src_a, 'search_result_id', v_cap_a))), now());
      RAISE EXCEPTION '0074-ledger-writers: an ops list with a refused claim was applied';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    IF EXISTS (SELECT 1 FROM public.intelligence_item_sections WHERE id = v_sec_new) OR EXISTS (SELECT 1 FROM public.section_claim_provenance WHERE claim_text = 'good claim' AND intelligence_item_id = v_item) THEN
      RAISE EXCEPTION '0074-ledger-writers: a refused ops list left a section or a claim behind';
    END IF;
    SELECT count(*) INTO before_cv FROM public.claim_versions WHERE intelligence_item_id = v_item;
    r := public.ledger_apply_ops(v_item, jsonb_build_array(
      jsonb_build_object('op', 'section_insert', 'id', v_sec_new, 'section_key', 'ops_0074', 'section_order', 9, 'content_md', 'ops'),
      jsonb_build_object('op', 'claim', 'claim_id', NULL, 'row', jsonb_build_object('section_row_id', v_sec_new, 'claim_text', 'good claim', 'claim_kind', 'ANALYSIS')),
      jsonb_build_object('op', 'claim', 'claim_id', v_claim2, 'row', jsonb_build_object('claim_text', 'survivor restated')),
      jsonb_build_object('op', 'section_content', 'id', v_sec_new, 'content_md', 'ops v2'),
      jsonb_build_object('op', 'brief', 'full_brief', 'a brief written by the ops')), now());
    IF r <> '{"claims": 2, "removed": 0, "sections": 2}'::jsonb OR (SELECT content_md FROM public.intelligence_item_sections WHERE id = v_sec_new) <> 'ops v2'
       OR (SELECT full_brief FROM public.intelligence_items WHERE id = v_item) <> 'a brief written by the ops' OR (SELECT count(*) FROM public.claim_versions WHERE intelligence_item_id = v_item) <> before_cv + 1 THEN
      RAISE EXCEPTION '0074-ledger-writers: the ops list did not apply as written: %', r;
    END IF;
    BEGIN
      PERFORM public.ledger_apply_ops(v_item, jsonb_build_array(jsonb_build_object('op', 'claim', 'claim_id', v_claim2, 'row', jsonb_build_object('claim_text', 'survivor restated again')), jsonb_build_object('op', 'nonsense')), now());
      RAISE EXCEPTION '0074-ledger-writers: an unknown op was accepted';
    EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
    IF (SELECT claim_text FROM public.section_claim_provenance WHERE id = v_claim2) <> 'survivor restated' OR (SELECT count(*) FROM public.claim_versions WHERE intelligence_item_id = v_item) <> before_cv + 1 THEN
      RAISE EXCEPTION '0074-ledger-writers: a rejected ops list left its first change behind';
    END IF;
    -- INV-R2b-3 on the other functions: an injected failure AFTER the archive (a trigger refusing the delete or the section update) leaves every table touched as it was
    CREATE FUNCTION pg_temp.inject_del_0074() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'injected 0074 delete failure' USING ERRCODE = 'P0045'; END $f$;
    CREATE TRIGGER inject_del_0074 BEFORE DELETE ON public.section_claim_provenance FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_del_0074();
    SELECT count(*) INTO before_cv FROM public.claim_versions WHERE intelligence_item_id = v_item;
    fp := pg_temp.fp_0074(v_item);
    BEGIN
      PERFORM public.ledger_remove_claim(v_claim2, 'proven_inaccurate', '{"reason":"selfcheck"}'::jsonb, NULL, now());
      RAISE EXCEPTION '0074-ledger-writers: the injected delete failure did not fire';
    EXCEPTION WHEN SQLSTATE 'P0045' THEN NULL; END;
    SELECT count(*) INTO n FROM public.claim_versions WHERE intelligence_item_id = v_item;
    IF n <> before_cv OR NOT EXISTS (SELECT 1 FROM public.section_claim_provenance WHERE id = v_claim2) OR pg_temp.fp_0074(v_item) <> fp THEN RAISE EXCEPTION '0074-ledger-writers: a failed removal left an archive row or lost the claim'; END IF;
    DROP TRIGGER inject_del_0074 ON public.section_claim_provenance;
    DROP FUNCTION pg_temp.inject_del_0074();
    v_sec3 := gen_random_uuid();
    INSERT INTO public.intelligence_item_sections (id, item_id, section_key, section_order, content_md) VALUES (v_sec3, v_item, 'doomed_0074', 7, 'doomed');
    PERFORM public.ledger_write_claim(v_item, NULL, jsonb_build_object('section_row_id', v_sec3, 'claim_text', 'claim of a doomed section', 'claim_kind', 'ANALYSIS'), 'changed', NULL, now());
    CREATE FUNCTION pg_temp.inject_sec_0074() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'injected 0074 section failure' USING ERRCODE = 'P0046'; END IF; IF NEW.content_md = 'INJECT' THEN RAISE EXCEPTION 'injected 0074 section failure' USING ERRCODE = 'P0046'; END IF; RETURN NEW; END $f$;
    CREATE TRIGGER inject_sec_0074 BEFORE UPDATE OR DELETE ON public.intelligence_item_sections FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_sec_0074();
    SELECT count(*) INTO before_cv FROM public.claim_versions WHERE intelligence_item_id = v_item;
    fp := pg_temp.fp_0074(v_item);
    BEGIN
      PERFORM public.ledger_reconcile_sections(v_item, '[{"section_key":"keep_0074","section_order":1,"content_md":"kept v3","is_conditional":false}]'::jsonb, now());
      RAISE EXCEPTION '0074-ledger-writers: the injected section failure did not fire on the reconcile';
    EXCEPTION WHEN SQLSTATE 'P0046' THEN NULL; END;
    SELECT count(*) INTO n FROM public.claim_versions WHERE intelligence_item_id = v_item;
    IF n <> before_cv OR NOT EXISTS (SELECT 1 FROM public.intelligence_item_sections WHERE id = v_sec3) OR NOT EXISTS (SELECT 1 FROM public.section_claim_provenance WHERE section_row_id = v_sec3) OR pg_temp.fp_0074(v_item) <> fp THEN
      RAISE EXCEPTION '0074-ledger-writers: a failed reconcile archived a claim it did not remove, or removed a section';
    END IF;
    BEGIN
      PERFORM public.ledger_apply_ops(v_item, jsonb_build_array(jsonb_build_object('op', 'claim', 'claim_id', v_claim2, 'row', jsonb_build_object('claim_text', 'changed by a failing list')), jsonb_build_object('op', 'section_content', 'id', v_sec_new, 'content_md', 'INJECT')), now());
      RAISE EXCEPTION '0074-ledger-writers: the injected section failure did not fire on the ops list';
    EXCEPTION WHEN SQLSTATE 'P0046' THEN NULL; END;
    SELECT count(*) INTO n FROM public.claim_versions WHERE intelligence_item_id = v_item;
    IF n <> before_cv OR (SELECT claim_text FROM public.section_claim_provenance WHERE id = v_claim2) <> 'survivor restated' OR pg_temp.fp_0074(v_item) <> fp THEN RAISE EXCEPTION '0074-ledger-writers: a failed ops list left its first change or its archive row'; END IF;
    DROP TRIGGER inject_sec_0074 ON public.intelligence_item_sections;
    DROP FUNCTION pg_temp.inject_sec_0074();

    CREATE FUNCTION pg_temp.inject_item_0074() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'injected 0074 item failure' USING ERRCODE = 'P0043'; END $f$;
    CREATE TRIGGER inject_item_0074 BEFORE DELETE ON public.intelligence_items FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_item_0074();
    SELECT count(*) INTO before_cv FROM public.claim_versions WHERE intelligence_item_id = v_item;
    fp := pg_temp.fp_0074(v_item);
    BEGIN
      PERFORM public.ledger_erase_item(v_item, 'tombstone_delete_duplicate', NULL, 'selfcheck', now());
      RAISE EXCEPTION '0074-ledger-writers: the injected item failure did not fire';
    EXCEPTION WHEN SQLSTATE 'P0043' THEN NULL; END;
    SELECT count(*) INTO n FROM public.claim_versions WHERE intelligence_item_id = v_item;
    IF n <> before_cv OR EXISTS (SELECT 1 FROM public.disposition_ledger WHERE intelligence_item_id = v_item) OR NOT EXISTS (SELECT 1 FROM public.intelligence_items WHERE id = v_item) OR pg_temp.fp_0074(v_item) <> fp THEN
      RAISE EXCEPTION '0074-ledger-writers: a failed erase left a tombstone or an archive row behind';
    END IF;
    DROP TRIGGER inject_item_0074 ON public.intelligence_items;
    DROP FUNCTION pg_temp.inject_item_0074();
    r := public.ledger_erase_item(v_item, 'tombstone_delete_duplicate', NULL, 'selfcheck', now());
    IF (r ->> 'claims_archived')::int <> 4 OR EXISTS (SELECT 1 FROM public.intelligence_items WHERE id = v_item) OR NOT EXISTS (SELECT 1 FROM public.disposition_ledger WHERE intelligence_item_id = v_item AND disposition_by = 'selfcheck')
       OR NOT EXISTS (SELECT 1 FROM public.claim_versions WHERE intelligence_item_id = v_item AND inaccuracy_proof ->> 'reason' = 'item_erased') THEN
      RAISE EXCEPTION '0074-ledger-writers: the erase did not tombstone, archive and delete: %', r;
    END IF;

    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '0074-ledger-writers: rollback sentinel';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg <> '0074-ledger-writers: rollback sentinel' THEN RAISE; END IF;
  END;
  IF has_function_privilege('anon', 'public.ledger_write_claim(uuid, uuid, jsonb, text, text, timestamptz)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.ledger_write_claim(uuid, uuid, jsonb, text, text, timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ledger_remove_claim(uuid, text, jsonb, text, timestamptz)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.ledger_reconcile_sections(uuid, jsonb, timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ledger_erase_item(uuid, text, uuid, text, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION '0074-ledger-writers: a client role can execute a ledger writer';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.ledger_write_claim(uuid, uuid, jsonb, text, text, timestamptz)', 'EXECUTE') THEN RAISE EXCEPTION '0074-ledger-writers: service_role cannot execute the writer'; END IF;
  RAISE NOTICE '0074-ledger-writers OK';
END $$;

COMMIT;
