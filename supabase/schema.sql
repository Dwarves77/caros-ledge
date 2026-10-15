--
-- PostgreSQL database dump
--


-- Dumped from database version 15.14
-- Dumped by pg_dump version 15.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: entity_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.entity_kind AS ENUM (
    'corridor',
    'node',
    'jurisdiction',
    'organisation',
    'asset',
    'instrument',
    'obligation',
    'method',
    'technology',
    'signpost',
    'person',
    'material'
);


--
-- Name: provenance_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.provenance_status AS ENUM (
    'unverified',
    'verified',
    'pending_human_verify',
    'quarantined'
);


--
-- Name: validation_result; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.validation_result AS (
	valid boolean,
	failures jsonb,
	recommended_status public.provenance_status,
	warnings jsonb
);


--
-- Name: _assert_org_membership(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._assert_org_membership(p_org_id uuid) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required' USING ERRCODE = '22023';
  END IF;
  -- Service role bypasses (admin-side server processes call these RPCs
  -- against any org_id; the membership check is for end-user paths).
  IF auth.role() = 'service_role' THEN
    RETURN;
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.org_memberships m
    WHERE m.org_id = p_org_id
      AND m.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of org %', p_org_id USING ERRCODE = '42501';
  END IF;
END;
$$;


--
-- Name: FUNCTION _assert_org_membership(p_org_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public._assert_org_membership(p_org_id uuid) IS 'Workspace authorization gate. RAISE EXCEPTION if auth.uid() is not a member of p_org_id. Service role bypasses. Called by every page-data RPC and by org_watchlist policies.';


--
-- Name: _classify_jurisdiction_token(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._classify_jurisdiction_token(token text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $_$
DECLARE
  t TEXT;
BEGIN
  IF token IS NULL THEN RETURN 'unparseable'; END IF;
  t := upper(btrim(token));
  IF t = '' THEN RETURN 'unparseable'; END IF;

  -- Continents go to pending_jurisdiction_review. CARIBBEAN and AMERICAS
  -- moved to region_bucket per SQL review MED #2/#3: CARIBBEAN is a
  -- region of North America, not a continent; AMERICAS spans two
  -- continents. Both still route to pending_jurisdiction_review, just
  -- under a more accurate taxonomy bucket.
  IF t IN (
    'ASIA','EUROPE','AFRICA','NORTH AMERICA','SOUTH AMERICA','OCEANIA','ANTARCTICA'
  ) THEN RETURN 'continent'; END IF;

  IF t IN (
    'LATAM','LATIN AMERICA','LATIN_AMERICA','MEAF','MIDDLE EAST','MIDDLE EAST AND AFRICA','NORTH_AMERICA','SOUTH_AMERICA','ASIA PACIFIC','ASIA_PACIFIC','ASIA-PACIFIC','APAC','EMEA','EMEAS','ANZ','PACIFIC RIM','SUBSAHARAN AFRICA','EASTERN EUROPE','WESTERN EUROPE','CENTRAL ASIA','SOUTHEAST ASIA','SOUTH ASIA','EAST ASIA','MENA','NORDIC','BALKANS','CARIBBEAN','AMERICAS','EAST_ASIA_PACIFIC','EUROPE_CENTRAL_ASIA','LATIN_AMERICA_CARIBBEAN','MIDDLE_EAST_NORTH_AFRICA','SOUTH_ASIA'
  ) THEN RETURN 'region_bucket'; END IF;

  IF t IN (
    'DEVELOPING_COUNTRIES','DEVELOPING COUNTRIES','ASIAN_DEVELOPMENT_BANK_MEMBERS','ASIAN DEVELOPMENT BANK MEMBERS','G7','G20','BRICS','UN_MEMBER_STATES','EU_MEMBER_STATES','EU MEMBER STATES','BALTIC_REGION','BALTIC REGION','NORTHEAST_REGION','NORTHEAST REGION','MERCOSUR','COMMONWEALTH','EEA','OECD_MEMBER_STATES','OECD MEMBER STATES','EASA_MEMBER_STATES','EASA MEMBER STATES','UN MEMBER STATES','IEA MEMBER STATES','IMO MEMBER STATES','IMO_MEMBER_STATES','SMALL_ISLAND_DEVELOPING_STATES','MULTIPLE STATES','MULTI-STATE','MULTI-JURISDICTIONAL','ALL US STATES','EUROPEAN UNION MEMBER STATES','MULTI_NATIONAL','EUROPEAN_UNION'
  ) THEN RETURN 'undefined_group'; END IF;

  -- Hydrological / natural features go to ingest_rejections.
  IF t ~ '(WATERSHED|RIVER|BASIN|LAKE|GULF|SEA|STRAIT|OCEAN|HARBOR|HARBOUR|VALLEY|MOUNTAIN|FJORD|DELTA)' THEN
    RETURN 'non_geographic';
  END IF;

  -- Agency / org names go to ingest_rejections.
  IF t ~ '(MINISTRY|AUTHORITY|AGENCY|COMMISSION|DEPARTMENT|OFFICE OF|PARLIAMENT|DOB|EPA|CARB|NMA|SDIR|CCC|UNFCCC|UNCTAD|MARITIME ADMINISTRATION|AVIATION ADMINISTRATION|SENATE|HOUSE OF|GOV\.|CONGRESS|COUNCIL|COURT|REGULATOR|BUREAU|BOARD|ASSEMBLY)' THEN
    RETURN 'institutional';
  END IF;

  -- Sub-jurisdictional county-level fragments go to ingest_rejections.
  IF t ~ 'COUNTY$' OR t ~ '^[A-Z ]+\.\s*[A-Z]+' THEN
    RETURN 'below_granularity';
  END IF;

  -- Default: unparseable (operator triages from ingest_rejections).
  RETURN 'unparseable';
END;
$_$;


--
-- Name: FUNCTION _classify_jurisdiction_token(token text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public._classify_jurisdiction_token(token text) IS 'Classify a jurisdiction token that did not match the CASE table. Returns one of: continent / region_bucket / undefined_group (routes to pending_jurisdiction_review); non_geographic / institutional / below_granularity / unparseable (routes to ingest_rejections). Used by the BEFORE INSERT/UPDATE trigger in migration 082.';


--
-- Name: _derive_jurisdiction_iso_from_canonical(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._derive_jurisdiction_iso_from_canonical(canonical_jurisdictions text[]) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $_$
  SELECT COALESCE(
    (
      SELECT array_agg(iso ORDER BY iso)
      FROM (
        SELECT DISTINCT
          CASE
            WHEN tok ~ '^[A-Z]{2}$' THEN tok
            WHEN tok ~ '^[A-Z]{2}-[A-Z0-9]{1,4}$' THEN split_part(tok, '-', 1)
            ELSE NULL
          END AS iso
        FROM unnest(COALESCE(canonical_jurisdictions, ARRAY[]::TEXT[])) AS tok
      ) AS derived
      WHERE iso IS NOT NULL
    ),
    ARRAY[]::TEXT[]
  );
$_$;


--
-- Name: FUNCTION _derive_jurisdiction_iso_from_canonical(canonical_jurisdictions text[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public._derive_jurisdiction_iso_from_canonical(canonical_jurisdictions text[]) IS 'Derive an ISO 3166-1 alpha-2 country code array from a canonical jurisdictions array produced by _normalize_jurisdictions. Alpha-2 tokens (US, CA, GB) pass through; subdivision tokens (US-PA, CA-ON, GB-ENG, US-NYC, AU-NSW) contribute the parent alpha-2 via split_part. Free-text canonical (EU, GLOBAL, IMO, ICAO, OECD, ASEAN) is filtered out because those are not ISO 3166-1 entities. Result is sorted and deduped via DISTINCT. Used by _intelligence_items_normalize_jurisdictions as the derive step that closes OBS-24 / Critical #1 (trigger semantic gap leaving 362 rows with empty jurisdiction_iso despite parseable canonical jurisdictions).';


--
-- Name: _guard_source_archive(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._guard_source_archive() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
begin
  if NEW.is_archived is true
     and NEW.archive_reason = any (array[
       'reclassified_to_source','source_not_item','institutional_source',
       'non_regulatory_source','portal_artifact'
     ])
  then
    if not exists (
      select 1 from sources s
      where s.status = 'active'
        and _url_host(s.url) = _url_host(NEW.source_url)
    ) then
      raise exception
        'source-registration invariant: cannot archive item % AS a source (reason=%) without a registered active source for host %',
        NEW.id, NEW.archive_reason, _url_host(NEW.source_url)
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end;
$$;


--
-- Name: _intelligence_items_normalize_jurisdictions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._intelligence_items_normalize_jurisdictions() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  norm_jur RECORD;
  norm_iso RECORD;
  t TEXT;
  classification TEXT;
  derived TEXT[];
BEGIN
  IF NEW.jurisdictions IS NOT NULL THEN
    SELECT * INTO norm_jur
      FROM public._normalize_jurisdictions(NEW.jurisdictions);
    NEW.jurisdictions := norm_jur.canonical;

    FOREACH t IN ARRAY norm_jur.rejected LOOP
      classification := public._classify_jurisdiction_token(t);
      IF classification IN ('continent', 'region_bucket', 'undefined_group') THEN
        INSERT INTO public.pending_jurisdiction_review
          (intelligence_item_id, current_value, flagged_reason, source_column)
        VALUES (NEW.id, t, classification, 'jurisdictions')
        ON CONFLICT (intelligence_item_id, current_value, source_column) WHERE resolved_at IS NULL DO NOTHING;
      ELSE
        INSERT INTO public.ingest_rejections
          (raw_value, rejection_reason, source_url, source_id)
        VALUES (t, classification, NEW.source_url, NEW.source_id);
      END IF;
    END LOOP;
  END IF;

  IF NEW.jurisdiction_iso IS NOT NULL THEN
    SELECT * INTO norm_iso
      FROM public._normalize_jurisdictions(NEW.jurisdiction_iso);
    NEW.jurisdiction_iso := norm_iso.canonical;

    FOREACH t IN ARRAY norm_iso.rejected LOOP
      classification := public._classify_jurisdiction_token(t);
      IF classification IN ('continent', 'region_bucket', 'undefined_group') THEN
        INSERT INTO public.pending_jurisdiction_review
          (intelligence_item_id, current_value, flagged_reason, source_column)
        VALUES (NEW.id, t, classification, 'jurisdiction_iso')
        ON CONFLICT (intelligence_item_id, current_value, source_column) WHERE resolved_at IS NULL DO NOTHING;
      ELSE
        INSERT INTO public.ingest_rejections
          (raw_value, rejection_reason, source_url, source_id)
        VALUES (t, classification, NEW.source_url, NEW.source_id);
      END IF;
    END LOOP;
  END IF;

  -- Migration 083: derive jurisdiction_iso from canonical jurisdictions
  -- when the column is empty. Defensive merge preserves operator-curated
  -- values (per Critical #1 audit recommendation). Closes OBS-24.
  IF NEW.jurisdictions IS NOT NULL
     AND (NEW.jurisdiction_iso IS NULL OR cardinality(NEW.jurisdiction_iso) = 0)
  THEN
    derived := public._derive_jurisdiction_iso_from_canonical(NEW.jurisdictions);
    IF cardinality(derived) > 0 THEN
      NEW.jurisdiction_iso := derived;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION _intelligence_items_normalize_jurisdictions(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public._intelligence_items_normalize_jurisdictions() IS 'BEFORE INSERT OR UPDATE trigger on intelligence_items. Normalizes jurisdictions and jurisdiction_iso via _normalize_jurisdictions(...) and routes any rejected tokens via _classify_jurisdiction_token: continent/region_bucket/undefined_group -> pending_jurisdiction_review; non_geographic/institutional/below_granularity/unparseable -> ingest_rejections. Migration 083 added a derive step: when jurisdiction_iso is empty, derive parent ISO 3166-1 alpha-2 codes from the canonical jurisdictions array via _derive_jurisdiction_iso_from_canonical. Defensive merge preserves operator-curated jurisdiction_iso values. Closes OBS-24 / Critical #1. Marked SECURITY DEFINER so it can write to the queue tables when the calling user lacks INSERT permission via RLS.';


--
-- Name: _normalize_jurisdictions(text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._normalize_jurisdictions(input text[]) RETURNS TABLE(canonical text[], rejected text[])
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $_$
DECLARE
  el           TEXT;
  parts        TEXT[];
  part         TEXT;
  key          TEXT;
  mapped       TEXT;
  canon_acc    TEXT[] := ARRAY[]::TEXT[];
  reject_acc   TEXT[] := ARRAY[]::TEXT[];
  i            INT;
  is_composite BOOLEAN;
BEGIN
  IF input IS NULL THEN
    canonical := ARRAY[]::TEXT[];
    rejected  := ARRAY[]::TEXT[];
    RETURN NEXT;
    RETURN;
  END IF;

  FOREACH el IN ARRAY input LOOP
    IF el IS NULL THEN CONTINUE; END IF;
    parts := regexp_split_to_array(el, '[,;|]');
    is_composite := array_length(parts, 1) > 1;

    FOR i IN 1 .. coalesce(array_length(parts, 1), 0) LOOP
      part := btrim(parts[i]);
      IF part = '' THEN CONTINUE; END IF;

      key := lower(part);
      mapped := NULL;

      -- US state 2-letter code disambiguation (unchanged from 072)
      IF is_composite AND i > 1 AND length(key) = 2 AND key ~ '^[a-z]{2}$' THEN
        mapped := CASE key
          WHEN 'al' THEN 'US-AL' WHEN 'ak' THEN 'US-AK' WHEN 'az' THEN 'US-AZ'
          WHEN 'ar' THEN 'US-AR' WHEN 'ca' THEN 'US-CA' WHEN 'co' THEN 'US-CO'
          WHEN 'ct' THEN 'US-CT' WHEN 'de' THEN 'US-DE' WHEN 'fl' THEN 'US-FL'
          WHEN 'ga' THEN 'US-GA' WHEN 'hi' THEN 'US-HI' WHEN 'id' THEN 'US-ID'
          WHEN 'il' THEN 'US-IL' WHEN 'in' THEN 'US-IN' WHEN 'ia' THEN 'US-IA'
          WHEN 'ks' THEN 'US-KS' WHEN 'ky' THEN 'US-KY' WHEN 'la' THEN 'US-LA'
          WHEN 'me' THEN 'US-ME' WHEN 'md' THEN 'US-MD' WHEN 'ma' THEN 'US-MA'
          WHEN 'mi' THEN 'US-MI' WHEN 'mn' THEN 'US-MN' WHEN 'ms' THEN 'US-MS'
          WHEN 'mo' THEN 'US-MO' WHEN 'mt' THEN 'US-MT' WHEN 'ne' THEN 'US-NE'
          WHEN 'nv' THEN 'US-NV' WHEN 'nh' THEN 'US-NH' WHEN 'nj' THEN 'US-NJ'
          WHEN 'nm' THEN 'US-NM' WHEN 'ny' THEN 'US-NY' WHEN 'nc' THEN 'US-NC'
          WHEN 'nd' THEN 'US-ND' WHEN 'oh' THEN 'US-OH' WHEN 'ok' THEN 'US-OK'
          WHEN 'or' THEN 'US-OR' WHEN 'pa' THEN 'US-PA' WHEN 'ri' THEN 'US-RI'
          WHEN 'sc' THEN 'US-SC' WHEN 'sd' THEN 'US-SD' WHEN 'tn' THEN 'US-TN'
          WHEN 'tx' THEN 'US-TX' WHEN 'ut' THEN 'US-UT' WHEN 'vt' THEN 'US-VT'
          WHEN 'va' THEN 'US-VA' WHEN 'wa' THEN 'US-WA' WHEN 'wv' THEN 'US-WV'
          WHEN 'wi' THEN 'US-WI' WHEN 'wy' THEN 'US-WY'
          ELSE NULL
        END;
      END IF;

      IF mapped IS NULL THEN
        mapped := CASE key
          -- ─── Existing 072 mappings (preserved verbatim) ───────────────
          WHEN 'us' THEN 'US'
          WHEN 'usa' THEN 'US'
          WHEN 'u.s.a' THEN 'US'        -- LOW #1: periods-with-spaces variant
          WHEN 'u.s.a.' THEN 'US'       -- LOW #1: periods-with-spaces variant
          WHEN 'united states' THEN 'US'
          WHEN 'united states of america' THEN 'US'
          WHEN 'eu' THEN 'EU'
          WHEN 'european union' THEN 'EU'
          WHEN 'eu-27' THEN 'EU'
          WHEN 'uk' THEN 'GB'
          WHEN 'united kingdom' THEN 'GB'
          WHEN 'great britain' THEN 'GB'
          WHEN 'global' THEN 'GLOBAL'
          WHEN 'international' THEN 'GLOBAL'
          WHEN 'worldwide' THEN 'GLOBAL'
          WHEN 'singapore' THEN 'SG'
          WHEN 'hong kong' THEN 'HK'
          WHEN 'japan' THEN 'JP'
          WHEN 'south korea' THEN 'KR'
          WHEN 'korea' THEN 'KR'
          WHEN 'china' THEN 'CN'
          WHEN 'china (prc)' THEN 'CN'
          WHEN 'prc' THEN 'CN'
          WHEN 'canada' THEN 'CA'
          WHEN 'australia' THEN 'AU'
          WHEN 'imo' THEN 'IMO'
          WHEN 'icao' THEN 'ICAO'
          WHEN 'germany' THEN 'DE'
          WHEN 'france' THEN 'FR'
          WHEN 'italy' THEN 'IT'
          WHEN 'spain' THEN 'ES'
          WHEN 'netherlands' THEN 'NL'
          WHEN 'belgium' THEN 'BE'
          WHEN 'switzerland' THEN 'CH'
          WHEN 'sweden' THEN 'SE'
          WHEN 'norway' THEN 'NO'
          WHEN 'denmark' THEN 'DK'
          WHEN 'finland' THEN 'FI'
          WHEN 'ireland' THEN 'IE'
          WHEN 'portugal' THEN 'PT'
          WHEN 'austria' THEN 'AT'
          WHEN 'poland' THEN 'PL'
          WHEN 'india' THEN 'IN'
          WHEN 'brazil' THEN 'BR'
          WHEN 'mexico' THEN 'MX'
          WHEN 'argentina' THEN 'AR'
          WHEN 'chile' THEN 'CL'
          WHEN 'colombia' THEN 'CO'
          WHEN 'peru' THEN 'PE'
          WHEN 'south africa' THEN 'ZA'
          WHEN 'united arab emirates' THEN 'AE'
          WHEN 'uae' THEN 'AE'
          WHEN 'saudi arabia' THEN 'SA'
          WHEN 'turkey' THEN 'TR'
          WHEN 'indonesia' THEN 'ID'
          WHEN 'thailand' THEN 'TH'
          WHEN 'vietnam' THEN 'VN'
          WHEN 'malaysia' THEN 'MY'
          WHEN 'philippines' THEN 'PH'
          WHEN 'new zealand' THEN 'NZ'
          WHEN 'lithuania' THEN 'LT'
          WHEN 'iran' THEN 'IR'
          WHEN 'kenya' THEN 'KE'
          WHEN 'croatia' THEN 'HR'
          WHEN 'puerto rico' THEN 'PR'
          -- US state names (preserved from 072)
          WHEN 'alabama' THEN 'US-AL'
          WHEN 'alaska' THEN 'US-AK'
          WHEN 'arizona' THEN 'US-AZ'
          WHEN 'arkansas' THEN 'US-AR'
          WHEN 'california' THEN 'US-CA'
          WHEN 'colorado' THEN 'US-CO'
          WHEN 'connecticut' THEN 'US-CT'
          WHEN 'delaware' THEN 'US-DE'
          WHEN 'florida' THEN 'US-FL'
          WHEN 'georgia' THEN 'US-GA'
          WHEN 'hawaii' THEN 'US-HI'
          WHEN 'idaho' THEN 'US-ID'
          WHEN 'illinois' THEN 'US-IL'
          WHEN 'indiana' THEN 'US-IN'
          WHEN 'iowa' THEN 'US-IA'
          WHEN 'kansas' THEN 'US-KS'
          WHEN 'kentucky' THEN 'US-KY'
          WHEN 'louisiana' THEN 'US-LA'
          WHEN 'maine' THEN 'US-ME'
          WHEN 'maryland' THEN 'US-MD'
          WHEN 'massachusetts' THEN 'US-MA'
          WHEN 'michigan' THEN 'US-MI'
          WHEN 'minnesota' THEN 'US-MN'
          WHEN 'mississippi' THEN 'US-MS'
          WHEN 'missouri' THEN 'US-MO'
          WHEN 'montana' THEN 'US-MT'
          WHEN 'nebraska' THEN 'US-NE'
          WHEN 'nevada' THEN 'US-NV'
          WHEN 'new hampshire' THEN 'US-NH'
          WHEN 'new jersey' THEN 'US-NJ'
          WHEN 'new mexico' THEN 'US-NM'
          WHEN 'new york' THEN 'US-NY'
          WHEN 'north carolina' THEN 'US-NC'
          WHEN 'north dakota' THEN 'US-ND'
          WHEN 'ohio' THEN 'US-OH'
          WHEN 'oklahoma' THEN 'US-OK'
          WHEN 'oregon' THEN 'US-OR'
          WHEN 'pennsylvania' THEN 'US-PA'
          WHEN 'rhode island' THEN 'US-RI'
          WHEN 'south carolina' THEN 'US-SC'
          WHEN 'south dakota' THEN 'US-SD'
          WHEN 'tennessee' THEN 'US-TN'
          WHEN 'texas' THEN 'US-TX'
          WHEN 'utah' THEN 'US-UT'
          WHEN 'vermont' THEN 'US-VT'
          WHEN 'virginia' THEN 'US-VA'
          WHEN 'washington' THEN 'US-WA'
          WHEN 'washington state' THEN 'US-WA'
          WHEN 'west virginia' THEN 'US-WV'
          WHEN 'wisconsin' THEN 'US-WI'
          WHEN 'wyoming' THEN 'US-WY'
          WHEN 'england' THEN 'GB-ENG'
          WHEN 'scotland' THEN 'GB-SCT'
          WHEN 'wales' THEN 'GB-WLS'
          WHEN 'northern ireland' THEN 'GB-NIR'
          WHEN 'northern_ireland' THEN 'GB-NIR'

          -- ─── NEW: Operator-approved additions (Phase 3 + ICAO/OECD/ASEAN) ──

          -- US federal variants (decision 4 carryforward, all collapse to US)
          WHEN 'federal' THEN 'US'
          WHEN 'united_states' THEN 'US'
          WHEN 'us_federal' THEN 'US'
          WHEN 'united states federal' THEN 'US'
          WHEN 'united states - federal' THEN 'US'
          WHEN 'us federal' THEN 'US'

          -- State variants (collapse to ISO 3166-2)
          WHEN 'new york state' THEN 'US-NY'
          WHEN 'new_york_state' THEN 'US-NY'
          WHEN 'new york city' THEN 'US-NYC'    -- platform extension per operator decision 1
          WHEN 'new_york_city' THEN 'US-NYC'
          WHEN 'nyc' THEN 'US-NYC'

          -- Long-tail cities mapped to country/state parent (operator decision 6)
          WHEN 'los angeles' THEN 'US-LAX'      -- platform extension
          WHEN 'san francisco' THEN 'US-CA'
          WHEN 'san_francisco' THEN 'US-CA'
          WHEN 'boston' THEN 'US-MA'
          WHEN 'chicago' THEN 'US-IL'
          WHEN 'philadelphia' THEN 'US-PA'
          WHEN 'houston' THEN 'US-TX'
          WHEN 'biloxi' THEN 'US-MS'
          WHEN 'bay st. louis' THEN 'US-MS'
          WHEN 'albuquerque' THEN 'US-NM'
          WHEN 'atlanta' THEN 'US-GA'
          WHEN 'tucson' THEN 'US-AZ'
          WHEN 'phoenix' THEN 'US-AZ'
          WHEN 'sacramento' THEN 'US-CA'
          WHEN 'oakland' THEN 'US-CA'
          WHEN 'reno' THEN 'US-NV'
          WHEN 'las vegas' THEN 'US-NV'
          WHEN 'seattle' THEN 'US-WA'
          WHEN 'portland' THEN 'US-OR'
          WHEN 'denver' THEN 'US-CO'
          WHEN 'miami' THEN 'US-FL'
          WHEN 'dallas' THEN 'US-TX'
          WHEN 'detroit' THEN 'US-MI'
          WHEN 'baltimore' THEN 'US-MD'
          WHEN 'pittsburgh' THEN 'US-PA'
          WHEN 'memphis' THEN 'US-TN'
          WHEN 'nashville' THEN 'US-TN'
          WHEN 'newark' THEN 'US-NJ'
          -- NYC five boroughs all collapse to US-NYC per SQL review HIGH #1.
          -- NYC's regulatory frame (LL97, LL84, LL97 enforcement) applies
          -- to all five boroughs uniformly; routing them to US-NY fragments
          -- NYC-municipal content across two jurisdictions.
          WHEN 'brooklyn' THEN 'US-NYC'
          WHEN 'manhattan' THEN 'US-NYC'
          WHEN 'queens' THEN 'US-NYC'
          WHEN 'bronx' THEN 'US-NYC'
          WHEN 'the bronx' THEN 'US-NYC'
          WHEN 'staten island' THEN 'US-NYC'
          WHEN 'staten_island' THEN 'US-NYC'
          WHEN 'buffalo' THEN 'US-NY'
          WHEN 'rochester' THEN 'US-NY'
          WHEN 'san diego' THEN 'US-CA'
          WHEN 'san jose' THEN 'US-CA'
          WHEN 'berkeley' THEN 'US-CA'
          WHEN 'richmond' THEN 'US-VA'
          WHEN 'washington dc' THEN 'US-DC'
          WHEN 'district of columbia' THEN 'US-DC'
          WHEN 'antwerp' THEN 'BE'
          WHEN 'bruges' THEN 'BE'
          WHEN 'brussels' THEN 'BE'
          WHEN 'diest' THEN 'BE'
          WHEN 'london' THEN 'GB-ENG'
          WHEN 'paris' THEN 'FR'
          WHEN 'berlin' THEN 'DE'
          WHEN 'munich' THEN 'DE'
          WHEN 'hamburg' THEN 'DE'
          WHEN 'barcelona' THEN 'ES'
          WHEN 'milan' THEN 'IT'
          WHEN 'tokyo' THEN 'JP'
          WHEN 'osaka' THEN 'JP'
          WHEN 'seoul' THEN 'KR'
          WHEN 'shanghai' THEN 'CN'
          WHEN 'beijing' THEN 'CN'
          WHEN 'mumbai' THEN 'IN'
          WHEN 'delhi' THEN 'IN'
          WHEN 'sao paulo' THEN 'BR'
          WHEN 'rio de janeiro' THEN 'BR'
          WHEN 'buenos aires' THEN 'AR'
          WHEN 'mexico city' THEN 'MX'
          WHEN 'dubai' THEN 'AE'
          WHEN 'abu dhabi' THEN 'AE'
          WHEN 'riyadh' THEN 'SA'
          WHEN 'johannesburg' THEN 'ZA'
          WHEN 'cape town' THEN 'ZA'
          WHEN 'sydney' THEN 'AU'
          WHEN 'melbourne' THEN 'AU'
          WHEN 'brisbane' THEN 'AU'
          WHEN 'auckland' THEN 'NZ'
          WHEN 'wellington' THEN 'NZ'

          -- Country names not in 072
          WHEN 'bangladesh' THEN 'BD'
          WHEN 'bulgaria' THEN 'BG'
          WHEN 'cyprus' THEN 'CY'
          WHEN 'czech republic' THEN 'CZ'
          WHEN 'czech_republic' THEN 'CZ'
          WHEN 'czechia' THEN 'CZ'
          WHEN 'democratic republic of the congo' THEN 'CD'
          WHEN 'drc' THEN 'CD'
          WHEN 'egypt' THEN 'EG'
          WHEN 'estonia' THEN 'EE'
          WHEN 'ethiopia' THEN 'ET'
          WHEN 'guam' THEN 'US-GU'
          WHEN 'hungary' THEN 'HU'
          WHEN 'iceland' THEN 'IS'
          WHEN 'israel' THEN 'IL'
          WHEN 'latvia' THEN 'LV'
          WHEN 'luxembourg' THEN 'LU'
          WHEN 'malta' THEN 'MT'
          WHEN 'morocco' THEN 'MA'
          WHEN 'nigeria' THEN 'NG'
          WHEN 'pakistan' THEN 'PK'
          WHEN 'qatar' THEN 'QA'
          WHEN 'republic of korea' THEN 'KR'
          WHEN 'romania' THEN 'RO'
          WHEN 'serbia' THEN 'RS'
          WHEN 'slovakia' THEN 'SK'
          WHEN 'slovenia' THEN 'SI'
          WHEN 'taiwan' THEN 'TW'
          WHEN 'ukraine' THEN 'UA'
          WHEN 'united_kingdom' THEN 'GB'
          WHEN 'american samoa' THEN 'US-AS'
          WHEN 'bonaire' THEN 'BQ'

          -- Canadian provinces (ISO 3166-2)
          WHEN 'alberta' THEN 'CA-AB'
          WHEN 'british columbia' THEN 'CA-BC'
          WHEN 'manitoba' THEN 'CA-MB'
          WHEN 'new brunswick' THEN 'CA-NB'
          WHEN 'newfoundland and labrador' THEN 'CA-NL'
          WHEN 'nova scotia' THEN 'CA-NS'
          WHEN 'northwest territories' THEN 'CA-NT'
          WHEN 'nunavut' THEN 'CA-NU'
          WHEN 'ontario' THEN 'CA-ON'
          WHEN 'prince edward island' THEN 'CA-PE'
          WHEN 'quebec' THEN 'CA-QC'
          WHEN 'saskatchewan' THEN 'CA-SK'
          WHEN 'yukon' THEN 'CA-YT'
          WHEN 'montreal' THEN 'CA-QC'
          WHEN 'toronto' THEN 'CA-ON'
          WHEN 'vancouver' THEN 'CA-BC'

          -- Australian states (ISO 3166-2)
          WHEN 'new south wales' THEN 'AU-NSW'
          WHEN 'nsw' THEN 'AU-NSW'
          WHEN 'queensland' THEN 'AU-QLD'
          WHEN 'qld' THEN 'AU-QLD'
          WHEN 'victoria' THEN 'AU-VIC'
          WHEN 'vic' THEN 'AU-VIC'
          WHEN 'south australia' THEN 'AU-SA'
          WHEN 'western australia' THEN 'AU-WA'
          WHEN 'tasmania' THEN 'AU-TAS'
          WHEN 'northern territory' THEN 'AU-NT'
          WHEN 'australian capital territory' THEN 'AU-ACT'
          WHEN 'act' THEN 'AU-ACT'

          -- New canonical free-text (operator decision 4 + ICAO addition)
          WHEN 'oecd' THEN 'OECD'
          WHEN 'asean' THEN 'ASEAN'
          WHEN 'icao member states (193)' THEN 'ICAO'

          ELSE NULL
        END;
      END IF;

      -- Standalone bare uppercase 2-letter codes (unchanged from 072)
      IF mapped IS NULL AND length(part) = 2 AND part ~ '^[A-Z]{2}$' THEN
        mapped := part;
      END IF;
      -- Pass-through canonical ISO 3166-2 codes (widened to 4-char subdiv
      -- so US-NYC, US-LAX, AU-NSW, AU-ACT, AU-QLD pass through cleanly)
      IF mapped IS NULL AND part ~ '^[A-Z]{2}-[A-Z0-9]{1,4}$' THEN
        mapped := part;
      END IF;

      IF mapped IS NOT NULL THEN
        IF NOT (mapped = ANY(canon_acc)) THEN
          canon_acc := array_append(canon_acc, mapped);
        END IF;
      ELSE
        -- CHANGED from 072: previously ELSE preserved-uppercased into
        -- result. Now ELSE surfaces the unmapped token via the
        -- `rejected` array. The migration 082 trigger reads `rejected`
        -- and routes per _classify_jurisdiction_token to either
        -- ingest_rejections or pending_jurisdiction_review.
        --
        -- In the 4a-only window (migration 081 ships docs, migration
        -- 082 is Phase 4b), the trigger function from migration 072
        -- (recreated below) discards `rejected` silently because the
        -- target tables don't exist yet. This is acceptable: ingest
        -- is paused during the migration window, so no new tokens
        -- need routing until migration 082 wires it.
        IF NOT (part = ANY(reject_acc)) THEN
          reject_acc := array_append(reject_acc, part);
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  SELECT array_agg(x ORDER BY x) INTO canon_acc FROM unnest(canon_acc) AS x;
  IF canon_acc IS NULL THEN
    canon_acc := ARRAY[]::TEXT[];
  END IF;
  SELECT array_agg(x ORDER BY x) INTO reject_acc FROM unnest(reject_acc) AS x;
  IF reject_acc IS NULL THEN
    reject_acc := ARRAY[]::TEXT[];
  END IF;

  canonical := canon_acc;
  rejected  := reject_acc;
  RETURN NEXT;
END;
$_$;


--
-- Name: FUNCTION _normalize_jurisdictions(input text[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public._normalize_jurisdictions(input text[]) IS 'Normalize a jurisdiction TEXT[]: split on [,;|], trim, map to canonical ISO 3166-1/2 codes or free-text canonical (EU/GLOBAL/IMO/ICAO/OECD/ASEAN). Returns TABLE(canonical TEXT[], rejected TEXT[]): canonical holds the mapped values (sorted, deduped); rejected holds tokens the CASE did not map. Migration 080 extended the CASE to ~250 entries and CHANGED the ELSE branch: unmapped tokens are surfaced to the caller via the rejected array (previously preserved uppercased into result). The trigger in migration 082 reads rejected and routes per _classify_jurisdiction_token to ingest_rejections (RC-7 fragments) or pending_jurisdiction_review (continents, region buckets, undefined groups). The 4a-only trigger (recreated from migration 072) discards rejected silently because the target tables ship in 082.';


--
-- Name: _url_host(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._url_host(u text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  select regexp_replace(
           lower(split_part(regexp_replace(coalesce(u, ''), '^[a-z]+://', '', 'i'), '/', 1)),
           '^www\.', ''
         );
$$;


--
-- Name: _workspace_active_items(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._workspace_active_items(p_org_id uuid) RETURNS TABLE(id uuid, legacy_id text, title text, summary text, what_is_it text, why_matters text, key_data text[], operational_impact text, open_questions text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, reasoning text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, archive_reason text, archive_note text, archived_date date, replaced_by uuid, version_history jsonb, created_at timestamp with time zone, updated_at timestamp with time zone, region_tags text[], topic_tags text[], vertical_tags text[], full_brief text, urgency_tier text, format_type text, last_regenerated_at timestamp with time zone, regeneration_skill_version text, sources_used uuid[], operational_scenario_tags text[], compliance_object_tags text[], related_items uuid[], intersection_summary text, jurisdiction_iso text[], agent_integrity_flag boolean, agent_integrity_phrase text, agent_integrity_flagged_at timestamp with time zone, agent_integrity_resolved_at timestamp with time zone, agent_integrity_resolved_by uuid, pipeline_stage text, hidden_reason text, effective_priority text, effective_archived boolean, item_grade text, cost_mechanism text, penalty_range text, enforcement_body text, requirement_trajectory jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.summary, ii.what_is_it, ii.why_matters,
    ii.key_data, ii.operational_impact, ii.open_questions, ii.tags, ii.domain,
    ii.category, ii.item_type, ii.source_id, ii.source_url, ii.jurisdictions,
    ii.transport_modes, ii.verticals, ii.status, ii.severity, ii.confidence,
    ii.priority, ii.reasoning, ii.entry_into_force, ii.compliance_deadline,
    ii.next_review_date, ii.added_date, ii.last_verified, ii.is_archived,
    ii.archive_reason, ii.archive_note, ii.archived_date, ii.replaced_by,
    ii.version_history, ii.created_at, ii.updated_at,
    ii.region_tags, ii.topic_tags, ii.vertical_tags,
    ii.full_brief, ii.urgency_tier, ii.format_type, ii.last_regenerated_at,
    ii.regeneration_skill_version, ii.sources_used,
    ii.operational_scenario_tags, ii.compliance_object_tags,
    ii.related_items, ii.intersection_summary, ii.jurisdiction_iso,
    ii.agent_integrity_flag, ii.agent_integrity_phrase,
    ii.agent_integrity_flagged_at, ii.agent_integrity_resolved_at,
    ii.agent_integrity_resolved_by, ii.pipeline_stage, ii.hidden_reason,
    COALESCE(wo.priority_override, ii.priority)::text AS effective_priority,
    COALESCE(wo.is_archived, ii.is_archived)         AS effective_archived,
    ii.item_grade,
    ii.cost_mechanism, ii.penalty_range, ii.enforcement_body, ii.requirement_trajectory
  FROM public.intelligence_items ii
  LEFT JOIN public.workspace_item_overrides wo
    ON  wo.item_id = ii.id
    AND wo.org_id  = p_org_id
  WHERE NOT COALESCE(wo.is_archived, ii.is_archived)
    AND ii.provenance_status = 'verified';   -- Sprint 4 task 1.10: customer read gate (ADDED)
END;
$$;


--
-- Name: accept_invitation(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_invitation(p_token text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_invitation public.org_invitations;
  v_caller_id  uuid;
  v_caller_email text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT lower(u.email) INTO v_caller_email
  FROM auth.users u WHERE u.id = v_caller_id;
  IF v_caller_email IS NULL THEN
    RAISE EXCEPTION 'Caller email not found' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_invitation
  FROM public.org_invitations
  WHERE token = p_token
  FOR UPDATE;

  IF v_invitation IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is %', v_invitation.status USING ERRCODE = '22023';
  END IF;
  IF v_invitation.expires_at <= now() THEN
    UPDATE public.org_invitations SET status = 'expired' WHERE id = v_invitation.id;
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;
  IF v_invitation.invited_email <> v_caller_email THEN
    RAISE EXCEPTION 'Invitation is for a different email' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.org_member_bans b
    WHERE b.org_id = v_invitation.org_id
      AND b.user_id = v_caller_id
  ) THEN
    RAISE EXCEPTION 'This account is banned from the workspace' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.org_memberships (org_id, user_id, role)
  VALUES (v_invitation.org_id, v_caller_id, v_invitation.proposed_role)
  ON CONFLICT (org_id, user_id) DO UPDATE
    SET role = EXCLUDED.role
    WHERE (org_memberships.role = 'viewer' AND EXCLUDED.role IN ('member', 'admin'))
       OR (org_memberships.role = 'member' AND EXCLUDED.role = 'admin');

  UPDATE public.org_invitations
  SET status = 'accepted',
      accepted_at = now(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_invitation.id;

  RETURN v_invitation.org_id;
END;
$$;


--
-- Name: FUNCTION accept_invitation(p_token text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.accept_invitation(p_token text) IS 'Accept an org invitation by token. Requires the caller email match invited_email. Inserts org_memberships row + flips invitation status to accepted. Returns org_id on success; raises with state-appropriate errcode otherwise.';


--
-- Name: acquire_funded_pass_lock(text, text, integer, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.acquire_funded_pass_lock(p_key text, p_label text, p_pid integer, p_host text, p_worklist text, p_stale_seconds integer DEFAULT 300) RETURNS TABLE(acquired boolean, takeover boolean, cur_label text, cur_pid integer, cur_heartbeat timestamp with time zone)
    LANGUAGE plpgsql
    AS $$
begin
  insert into public.funded_pass_runlock (lock_key, holder_label, holder_pid, holder_host, worklist_ref, acquired_at, heartbeat_at)
  values (p_key, p_label, p_pid, p_host, p_worklist, now(), now())
  on conflict (lock_key) do nothing;
  if found then
    acquired := true; takeover := false; cur_label := p_label; cur_pid := p_pid; cur_heartbeat := now();
    return next; return;
  end if;
  update public.funded_pass_runlock
     set holder_label = p_label, holder_pid = p_pid, holder_host = p_host,
         worklist_ref = p_worklist, acquired_at = now(), heartbeat_at = now()
   where lock_key = p_key and heartbeat_at < now() - make_interval(secs => p_stale_seconds);
  if found then
    acquired := true; takeover := true; cur_label := p_label; cur_pid := p_pid; cur_heartbeat := now();
    return next; return;
  end if;
  select holder_label, holder_pid, heartbeat_at into cur_label, cur_pid, cur_heartbeat
    from public.funded_pass_runlock where lock_key = p_key;
  acquired := false; takeover := false;
  return next;
end; $$;


--
-- Name: acquire_mutation_lease(uuid, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.acquire_mutation_lease(p_item uuid, p_holder text, p_lane text DEFAULT NULL::text, p_stale_seconds integer DEFAULT 300) RETURNS TABLE(acquired boolean, takeover boolean, cur_holder text, cur_heartbeat timestamp with time zone)
    LANGUAGE plpgsql
    AS $$
begin
  insert into public.mutation_leases (intelligence_item_id, holder, lane, acquired_at, heartbeat_at)
  values (p_item, p_holder, p_lane, now(), now())
  on conflict (intelligence_item_id) do nothing;
  if found then
    acquired := true; takeover := false; cur_holder := p_holder; cur_heartbeat := now();
    return next; return;
  end if;
  update public.mutation_leases
     set holder = p_holder, lane = p_lane, acquired_at = now(), heartbeat_at = now()
   where intelligence_item_id = p_item
     and heartbeat_at < now() - make_interval(secs => p_stale_seconds);
  if found then
    acquired := true; takeover := true; cur_holder := p_holder; cur_heartbeat := now();
    return next; return;
  end if;
  select holder, heartbeat_at into cur_holder, cur_heartbeat
    from public.mutation_leases where intelligence_item_id = p_item;
  acquired := false; takeover := false;
  return next;
end;
$$;


--
-- Name: admin_attention_counts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_attention_counts() RETURNS TABLE(provisional_sources_pending integer, staged_updates_pending integer, staged_updates_materialization_failed integer, integrity_flags_unresolved integer, platform_integrity_flags_open integer, source_attribution_mismatches integer, auto_approved_awaiting_spotcheck integer, coverage_gaps_critical integer, total integer)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  WITH counts AS (
    SELECT
      (SELECT COUNT(*)::INT FROM provisional_sources
        WHERE status IN ('pending_review', 'needs_more_data')) AS provisional_sources_pending,
      (SELECT COUNT(*)::INT FROM staged_updates WHERE status = 'pending') AS staged_updates_pending,
      (SELECT COUNT(*)::INT FROM staged_updates
        WHERE status = 'approved'
          AND materialized_at IS NULL
          AND materialization_error IS NOT NULL) AS staged_updates_materialization_failed,
      (SELECT COUNT(*)::INT FROM intelligence_items
        WHERE agent_integrity_flag = TRUE
          AND agent_integrity_resolved_at IS NULL) AS integrity_flags_unresolved,
      (SELECT COUNT(*)::INT FROM integrity_flags
        WHERE status IN ('open', 'in_review')) AS platform_integrity_flags_open,
      0 AS source_attribution_mismatches,
      (SELECT COUNT(*)::INT FROM sources
        WHERE created_at > NOW() - INTERVAL '7 days'
          AND COALESCE(spotchecked, FALSE) = FALSE) AS auto_approved_awaiting_spotcheck,
      0 AS coverage_gaps_critical
  )
  SELECT
    provisional_sources_pending,
    staged_updates_pending,
    staged_updates_materialization_failed,
    integrity_flags_unresolved,
    platform_integrity_flags_open,
    source_attribution_mismatches,
    auto_approved_awaiting_spotcheck,
    coverage_gaps_critical,
    (provisional_sources_pending
     + staged_updates_pending
     + staged_updates_materialization_failed
     + integrity_flags_unresolved
     + platform_integrity_flags_open
     + source_attribution_mismatches
     + auto_approved_awaiting_spotcheck
     + coverage_gaps_critical) AS total
  FROM counts;
$$;


--
-- Name: FUNCTION admin_attention_counts(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.admin_attention_counts() IS 'Aggregated admin-attention counts (migration 036, +platform_integrity_flags_open in 140, provisional queue population corrected in 314). provisional_sources_pending counts status IN (pending_review, needs_more_data) - the SAME population fetchProvisionalSources renders and src/lib/admin/provisional-review-queue.ts names.';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: system_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_state (
    id boolean DEFAULT true NOT NULL,
    global_processing_paused boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scrape_cadence text DEFAULT 'off'::text NOT NULL,
    scrape_start_date date,
    judgement_drain text DEFAULT 'off'::text NOT NULL,
    CONSTRAINT system_state_id_check CHECK ((id = true)),
    CONSTRAINT system_state_judgement_drain_chk CHECK ((judgement_drain = ANY (ARRAY['off'::text, 'on'::text]))),
    CONSTRAINT system_state_scrape_cadence_chk CHECK ((scrape_cadence = ANY (ARRAY['off'::text, 'weekly'::text, 'monthly'::text])))
);


--
-- Name: TABLE system_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.system_state IS 'Singleton table for application-wide flags. Enforced as a singleton by BOOLEAN PRIMARY KEY DEFAULT true CHECK
  (id = true) — only one row can ever exist.';


--
-- Name: COLUMN system_state.scrape_cadence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.system_state.scrape_cadence IS 'Global scrape cadence (off|weekly|monthly). SINGLE source of truth for when the whole system scrapes; per-source update_frequency retired. off = hold (default/current state).';


--
-- Name: COLUMN system_state.scrape_start_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.system_state.scrape_start_date IS 'Anchor date: the first scrape day AND the recurrence phase. weekly => that weekday; monthly => that day-of-month (clamped on short months). Before this date nothing runs ("paused until started").';


--
-- Name: COLUMN system_state.judgement_drain; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.system_state.judgement_drain IS 'Kill switch of the scheduled judgement drain session (off|on, default off). Written ONLY through admin_set_judgement_drain (marker app.judgement_drain_writer); guard_judgement_drain_writer bounces any other change and logs authorized ones to system_state_flag_audit. The drain also halts on an open fleet-budget-halt row and on global_processing_paused.';


--
-- Name: admin_set_judgement_drain(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_judgement_drain(p_actor text, p_state text) RETURNS public.system_state
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE r public.system_state;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('off', 'on') THEN
    RAISE EXCEPTION 'admin_set_judgement_drain: p_state must be off or on, got %', coalesce(p_state, 'NULL');
  END IF;
  PERFORM set_config('app.judgement_drain_writer', coalesce(nullif(p_actor, ''), 'admin-pause-route'), true);
  UPDATE public.system_state SET judgement_drain = p_state, updated_at = now()
   WHERE id = true
   RETURNING * INTO r;
  RETURN r;
END; $$;


--
-- Name: FUNCTION admin_set_judgement_drain(p_actor text, p_state text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.admin_set_judgement_drain(p_actor text, p_state text) IS 'The ONE sanctioned writer of system_state.judgement_drain (lane G6-DRAIN, migration 354): validates off|on, declares the transaction-local marker app.judgement_drain_writer, updates, returns the row. Called by the admin pause-global route via supabase.rpc.';


--
-- Name: admin_set_pause_state(text, boolean, text, date, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_set_pause_state(p_actor text, p_paused boolean DEFAULT NULL::boolean, p_cadence text DEFAULT NULL::text, p_start_date date DEFAULT NULL::date, p_clear_start boolean DEFAULT false) RETURNS public.system_state
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE r public.system_state;
BEGIN
  PERFORM set_config('app.pause_flag_writer', coalesce(nullif(p_actor, ''), 'admin-pause-route'), true);
  UPDATE public.system_state SET
    global_processing_paused = COALESCE(p_paused, global_processing_paused),
    scrape_cadence           = COALESCE(p_cadence, scrape_cadence),
    scrape_start_date        = CASE WHEN p_clear_start THEN NULL
                                    WHEN p_start_date IS NOT NULL THEN p_start_date
                                    ELSE scrape_start_date END,
    updated_at = now()
  WHERE id = true
  RETURNING * INTO r;
  RETURN r;
END; $$;


--
-- Name: agent_run_searches_set_result_chars(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.agent_run_searches_set_result_chars() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.result_chars := length(NEW.result_content);
  RETURN NEW;
END;
$$;


--
-- Name: assert_acyclic(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_acyclic() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_hit boolean;
BEGIN
  IF NEW.from_table IN ('derived_values', 'inference_records') THEN
    WITH RECURSIVE reach(node_table, node_id) AS (
      SELECT NEW.to_table, NEW.to_value_id::text
      UNION
      SELECT e.to_table, e.to_value_id::text
      FROM public.derivation_edges e
      JOIN reach r ON e.from_table = r.node_table AND e.from_pk = r.node_id
    )
    SELECT true INTO v_hit
    FROM reach r
    WHERE r.node_table = NEW.from_table AND r.node_id = NEW.from_pk
    LIMIT 1;
    IF v_hit THEN
      RAISE EXCEPTION 'assert_acyclic: edge (%,%) -> (%,%) would close a cycle',
        NEW.from_table, NEW.from_pk, NEW.to_table, NEW.to_value_id;
    END IF;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: FUNCTION assert_acyclic(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.assert_acyclic() IS 'Migration 339: polymorphic rewrite of migration 285''s derived_values-only acyclic guard. Engages when the new edge''s input is itself a DAG node kind (derived_values OR inference_records).';


--
-- Name: assert_statutory_purity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assert_statutory_purity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  bad_estimate boolean;
  bad_derived  boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.inputs) AS ref
    WHERE (ref->>'table') = 'estimated_values'
      AND EXISTS (
        SELECT 1 FROM public.estimated_values ev
        WHERE ev.entity_id = (ref->>'pk') OR ev.estimate_id::text = (ref->>'pk')
      )
  ) INTO bad_estimate;
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.inputs) AS ref
    JOIN public.derived_values dv ON dv.value_id::text = (ref->>'pk')
    WHERE (ref->>'table') = 'derived_values'
      AND dv.derivation IN ('modelled', 'estimated', 'interpolated')
  ) INTO bad_derived;
  IF bad_estimate OR bad_derived THEN
    RAISE EXCEPTION
      'statutory computation % (entity %) depends on a non-contractable input (an estimated_values row, '
      'or a derived_values row whose derivation is modelled/estimated/interpolated) — spec 08 §4 Layer 3',
      NEW.computation_id, NEW.entity_id;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: FUNCTION assert_statutory_purity(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.assert_statutory_purity() IS 'Spec 08 §4 Layer 3: a statutory computation whose input graph touches an estimate fails to insert. Inspects NEW.inputs directly (statutory_computations is a terminal figure, never a to_value_id in derivation_edges). An estimated_values input may be addressed by estimate_id (the PK) or by entity_id (pre-amendment shape); both are refused.';


--
-- Name: backfill_market_series_entity(text, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.backfill_market_series_entity(p_entity_id text, p_ids uuid[]) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_entity_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.entities e WHERE e.entity_id = p_entity_id) THEN
    RAISE EXCEPTION 'backfill_market_series_entity: unknown entity %', coalesce(p_entity_id, 'NULL');
  END IF;
  PERFORM set_config('app.outbox_backfill_writer', 'market_series', true);
  UPDATE public.market_series SET entity_id = p_entity_id
   WHERE id = ANY(coalesce(p_ids, ARRAY[]::uuid[])) AND entity_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('app.outbox_backfill_writer', '', true);
  RETURN v_n;
END; $$;


--
-- Name: FUNCTION backfill_market_series_entity(p_entity_id text, p_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.backfill_market_series_entity(p_entity_id text, p_ids uuid[]) IS 'The one sanctioned writer of a market_series entity backfill (migration 373): refuses an entity id with no entities row, stamps only rows whose entity_id IS NULL, declares the transaction-local marker app.outbox_backfill_writer = market_series so the outbox trigger skips emission for these rows, clears the marker, returns the row count. service_role only.';


--
-- Name: bucket_value(numeric, text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bucket_value(p_value numeric, p_scheme text, p_multiplier numeric DEFAULT 1) RETURNS numeric
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE
  step numeric;
  m numeric := greatest(coalesce(p_multiplier, 1), 1);
BEGIN
  IF p_value IS NULL THEN RETURN NULL; END IF;
  IF p_scheme ~ '^(pct|abs):[0-9]+(\.[0-9]+)?$' THEN
    step := substring(p_scheme from 5)::numeric * m;
    IF step <= 0 THEN RETURN NULL; END IF;
    RETURN round(p_value / step) * step;
  ELSIF p_scheme = 'log2' THEN
    IF p_value <= 0 THEN RETURN 0; END IF;
    RETURN power(2, floor(log(2, p_value) / m) * m);
  ELSE
    RETURN NULL;
  END IF;
END $_$;


--
-- Name: bucket_width_multiplier(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bucket_width_multiplier(p_n integer, p_k_min integer) RETURNS numeric
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT greatest(1, ceil((2.0 * p_k_min) / greatest(p_n, 1)));
$$;


--
-- Name: canonicalize_citation_url(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.canonicalize_citation_url(u text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $_$
  SELECT regexp_replace(                                -- ONE combined trailing-junk strip: slash + dots +
    regexp_replace(                                     -- punct, so `…/path/.*` (after marker strip `…/path/.`)
      regexp_replace(lower(btrim(u)), '[*`]+$', ''),    -- fully normalizes to `…/path`. strip trailing markers,
      '^(https?://)www\.', '\1'                         -- then leading www., then the combined trailing class.
    ),
    '[/.,;:]+$', ''
  );
$_$;


--
-- Name: capture_worker_fetch(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.capture_worker_fetch(queue_ids uuid[]) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  req_id bigint;
  v_key  text;
BEGIN
  IF queue_ids IS NULL OR array_length(queue_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'capture_worker_fetch: queue_ids must be a non-empty uuid array';
  END IF;
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'capture_worker_anon_key';
  IF v_key IS NULL THEN
    RAISE EXCEPTION 'capture_worker_fetch: vault secret capture_worker_anon_key is missing — restore it before invoking (migration 256)';
  END IF;
  SELECT net.http_post(
    url := 'https://kwrsbpiseruzbfwjpvsp.supabase.co/functions/v1/capture-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := jsonb_build_object('queue_ids', to_jsonb(queue_ids)),
    timeout_milliseconds := 90000
  ) INTO req_id;
  RETURN req_id;
END;
$$;


--
-- Name: FUNCTION capture_worker_fetch(queue_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.capture_worker_fetch(queue_ids uuid[]) IS 'Invokes the capture-worker edge function via pg_net for the given pending_first_fetch ids. Returns the net._http_response request id to poll. Operator-authorized infrastructure (2026-08-01); replaces the in-prompt net.http_post recipe.';


--
-- Name: census_worklist_guarded_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.census_worklist_guarded_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  rank_old integer;
  rank_new integer;
BEGIN
  IF NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.document_url IS DISTINCT FROM OLD.document_url
     OR NEW.lane IS DISTINCT FROM OLD.lane
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'census_worklist identity columns (source_id, document_url, lane, created_by, created_at) are immutable after insert';
  END IF;

  IF NEW.enumeration_status IS DISTINCT FROM OLD.enumeration_status THEN
    rank_old := CASE OLD.enumeration_status
      WHEN 'discovered' THEN 1 WHEN 'classified' THEN 2 WHEN 'dry_run_complete' THEN 3
      WHEN 'reconciled' THEN 4 WHEN 'flagged' THEN 0 END;
    rank_new := CASE NEW.enumeration_status
      WHEN 'discovered' THEN 1 WHEN 'classified' THEN 2 WHEN 'dry_run_complete' THEN 3
      WHEN 'reconciled' THEN 4 WHEN 'flagged' THEN 0 END;

    IF NEW.enumeration_status = 'flagged' THEN
      NULL; -- flaggable from any rank
    ELSIF OLD.enumeration_status = 'flagged' AND NEW.enumeration_status = 'discovered' THEN
      NULL; -- the one reset path: producing lane re-submits a corrected row
    ELSIF rank_new > rank_old THEN
      NULL; -- forward progress through the ladder
    ELSE
      RAISE EXCEPTION 'census_worklist enumeration_status must move forward (discovered -> classified -> dry_run_complete -> reconciled), or to/from flagged: got % -> %', OLD.enumeration_status, NEW.enumeration_status;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;


--
-- Name: census_worklist_no_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.census_worklist_no_delete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'census_worklist is APPEND-ONLY: DELETE is forbidden (gap-census data layer, 2026-07-19)';
END;
$$;


--
-- Name: cl_corridor_field(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cl_corridor_field(v text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE WHEN v IS NULL THEN 'N#'
              ELSE octet_length(v)::text || '#' || v END;
$$;


--
-- Name: cl_corridor_id(text, text, text, integer, text, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cl_corridor_id(p_origin text, p_dest text, p_mode text, p_leg_ordinal integer DEFAULT NULL::integer, p_routing_key text DEFAULT NULL::text, p_via text[] DEFAULT '{}'::text[]) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT 'cl:corridor:' || left(encode(digest(
      'v1'
      || cl_corridor_field(upper(btrim(p_origin, E' 	
')))
      || cl_corridor_field(upper(btrim(p_dest, E' 	
')))
      || cl_corridor_field(lower(btrim(p_mode, E' 	
')))
      || cl_corridor_field(p_leg_ordinal::text)
      || cl_corridor_field(lower(btrim(p_routing_key, E' 	
')))
      || cl_corridor_field(coalesce(array_length(p_via, 1), 0)::text)
      || coalesce((SELECT string_agg(cl_corridor_field(upper(btrim(x, E' 	
'))), '' ORDER BY ord)
                     FROM unnest(p_via) WITH ORDINALITY AS t(x, ord)), '')
    , 'sha256'), 'hex'), 16);
$$;


--
-- Name: community_groups_owner_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.community_groups_owner_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF public.is_sanctioned_writer('public.community_groups'::regclass) THEN
    RETURN NEW;
  END IF;
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id THEN
    IF OLD.owner_user_id IS NULL OR OLD.owner_user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'community_groups_owner_guard: only the current owner may transfer a group; current_user=%', current_user
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION community_groups_owner_guard(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.community_groups_owner_guard() IS 'SEC-3b (migration 370). BEFORE UPDATE guard on public.community_groups for callers other than service_role, postgres, supabase_admin or the table owner: owner_user_id changes only when the caller is the current owner. A group moderator or admin (user_is_group_admin) cannot transfer ownership to themselves.';


--
-- Name: community_identity(uuid[], text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.community_identity(p_ids uuid[], p_query text DEFAULT NULL::text) RETURNS TABLE(user_id uuid, display_name text, company_name text, job_title text, region text, avatar_url text, verified boolean, anonymous boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  WITH q AS (
    SELECT nullif(btrim(p_query), '') AS term,
           replace(replace(replace(nullif(btrim(p_query), ''), '\', '\\'), '%', '\%'), '_', '\_') AS esc
  ),
  base AS (
    SELECT p.id AS id,
           nullif(btrim(coalesce(nullif(btrim(p.full_name), ''), p.display_name)), '') AS nm,
           regexp_replace(coalesce(nullif(btrim(p.full_name), ''), p.display_name, ''), '\s+', ' ', 'g') AS nn,
           coalesce(
             (SELECT o.name FROM public.organizations o WHERE o.id = p.org_id),
             (SELECT o2.name
                FROM public.org_memberships m
                JOIN public.organizations o2 ON o2.id = m.org_id
               WHERE m.user_id = p.id
               ORDER BY m.created_at, m.id
               LIMIT 1)
           ) AS co,
           p.job_title AS jt,
           coalesce(c.region, nullif(array_to_string(p.region, ', '), '')) AS rg,
           p.avatar_url AS av,
           coalesce(c.verified, false) AS vf,
           coalesce(c.default_anonymous, false) AS anon
      FROM public.profiles p
      LEFT JOIN public.community_member_profiles c ON c.user_id = p.id
     WHERE auth.uid() IS NOT NULL
  )
  SELECT b.id,
         (CASE WHEN b.anon THEN NULL ELSE b.nm END)::text,
         (CASE WHEN b.anon THEN NULL ELSE b.co END)::text,
         b.jt::text,
         b.rg::text,
         (CASE WHEN b.anon THEN NULL ELSE b.av END)::text,
         b.vf,
         b.anon
    FROM base b
    CROSS JOIN q
   WHERE (q.term IS NULL AND p_ids IS NOT NULL AND b.id = ANY ((p_ids)[1:200]))
      OR (q.term IS NOT NULL
          AND length(q.term) >= 2
          AND NOT b.anon
          AND (b.nn ILIKE (q.esc || '%')
               OR b.nn ILIKE ('% ' || q.esc || '%'))
          AND (p_ids IS NULL OR b.id = ANY ((p_ids)[1:200])))
   ORDER BY (CASE WHEN b.anon THEN NULL ELSE b.nm END) NULLS LAST, b.id
   LIMIT (CASE WHEN nullif(btrim(p_query), '') IS NULL THEN 200 ELSE 25 END)
$$;


--
-- Name: FUNCTION community_identity(p_ids uuid[], p_query text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.community_identity(p_ids uuid[], p_query text) IS 'SEC-5 (migration 372). Cross-organisation Community identity under spec 07 R8.7: name, company, job title, region, avatar, verified, anonymous. The per-user half of R8.7 is applied here (default_anonymous withholds display_name, company_name and avatar_url, verified stays); the per-post half is applied by the routes. p_ids: up to 200 ids. p_query: matches the start of any whitespace-separated token of the shown name, at least two characters, wildcards escaped, at most 25 rows, never matches a default-anonymous member. Never returns email or is_platform_admin. SECURITY DEFINER, search_path pinned, EXECUTE to authenticated and service_role only.';


--
-- Name: community_member_profiles_verification_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.community_member_profiles_verification_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF public.is_sanctioned_writer('public.community_member_profiles'::regclass) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.verified            IS DISTINCT FROM OLD.verified
       OR NEW.verified_at         IS DISTINCT FROM OLD.verified_at
       OR NEW.verification_method IS DISTINCT FROM OLD.verification_method
       OR NEW.organisation_key    IS DISTINCT FROM OLD.organisation_key THEN
      RAISE EXCEPTION 'community_member_profiles_verification_guard: verified, verified_at, verification_method and organisation_key are writable only by service_role or the table owner; current_user=%', current_user
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.verified IS TRUE
     OR NEW.verified_at IS NOT NULL
     OR NEW.verification_method IS NOT NULL
     OR NEW.organisation_key IS NOT NULL THEN
    RAISE EXCEPTION 'community_member_profiles_verification_guard: a new community_member_profiles row may not set verified, verified_at, verification_method or organisation_key; only service_role or the table owner may; current_user=%', current_user
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION community_member_profiles_verification_guard(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.community_member_profiles_verification_guard() IS 'SEC-3b (migration 370). BEFORE INSERT OR UPDATE guard on public.community_member_profiles: raises 42501 when a caller other than service_role, postgres, supabase_admin or the table owner changes verified, verified_at, verification_method or organisation_key (or inserts a row carrying one). The verification route uses the service-role client. Layer 2 behind the column grants.';


--
-- Name: community_post_signoff_requests_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.community_post_signoff_requests_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF public.is_sanctioned_writer('public.community_post_signoff_requests'::regclass) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'community_post_signoff_requests_guard: a new sign-off request starts as pending; current_user=%', current_user
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.post_id IS DISTINCT FROM OLD.post_id THEN
    RAISE EXCEPTION 'community_post_signoff_requests_guard: requested_by and post_id of a request never change; current_user=%', current_user
      USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('signed_off', 'declined') THEN
    IF v_actor IS NULL OR v_actor = OLD.requested_by OR NEW.verifier_id IS NOT DISTINCT FROM OLD.requested_by THEN
      RAISE EXCEPTION 'community_post_signoff_requests_guard: the verifier of a request cannot be its requester; current_user=%', current_user
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION community_post_signoff_requests_guard(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.community_post_signoff_requests_guard() IS 'SEC-3b (migration 370). BEFORE INSERT OR UPDATE guard on public.community_post_signoff_requests for callers other than service_role, postgres, supabase_admin or the table owner: a new request starts as pending, requested_by and post_id never change, and a decision (a move to signed_off or declined) is refused when the caller or the recorded verifier is the requester.';


--
-- Name: community_posts_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.community_posts_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF public.is_sanctioned_writer('public.community_posts'::regclass) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.signed_off_at IS NOT NULL OR NEW.signed_off_by IS NOT NULL THEN
      RAISE EXCEPTION 'community_posts_guard: signed_off_at and signed_off_by are written only by the sign-off decision (service_role); current_user=%', current_user
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.signed_off_at IS DISTINCT FROM OLD.signed_off_at OR NEW.signed_off_by IS DISTINCT FROM OLD.signed_off_by THEN
    RAISE EXCEPTION 'community_posts_guard: signed_off_at and signed_off_by are written only by the sign-off decision (service_role); current_user=%', current_user
      USING ERRCODE = '42501';
  END IF;
  IF NEW.author_user_id IS DISTINCT FROM OLD.author_user_id THEN
    RAISE EXCEPTION 'community_posts_guard: the author of a post never changes; current_user=%', current_user
      USING ERRCODE = '42501';
  END IF;
  IF NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    IF v_actor IS NULL
       OR NOT public.user_is_group_admin(OLD.group_id, v_actor)
       OR NOT public.user_is_group_admin(NEW.group_id, v_actor) THEN
      RAISE EXCEPTION 'community_posts_guard: a post moves between groups only when the caller is a moderator or admin of both; current_user=%', current_user
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION community_posts_guard(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.community_posts_guard() IS 'SEC-3b (migration 370). BEFORE INSERT OR UPDATE guard on public.community_posts for callers other than service_role, postgres, supabase_admin or the table owner: signed_off_at and signed_off_by never change (the sign-off decide route stamps them with the service-role client), the author never changes, and group_id changes only when the caller is a moderator or admin (user_is_group_admin) of BOTH groups. Layer 2 behind the column grants.';


--
-- Name: community_region_counts(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.community_region_counts(p_privacy text DEFAULT NULL::text) RETURNS TABLE(region text, count bigint)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  -- security invoker means the caller's RLS policies on community_groups
  -- apply, so this RPC sees exactly the groups the caller can SELECT
  -- (public groups + private groups they belong to). No service-role
  -- escape — same reachability surface as the 8-query loop it replaces.
  select g.region::text as region, count(*)::bigint as count
  from community_groups g
  where (p_privacy is null or g.privacy = p_privacy)
  group by g.region;
$$;


--
-- Name: FUNCTION community_region_counts(p_privacy text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.community_region_counts(p_privacy text) IS 'Returns per-region group counts visible to the caller via RLS. Replaces the per-page 8-region head-count loop in /community* pages (PERF-AUDIT.md fix #3). Optional p_privacy filter narrows to public or private groups when set; null returns the full visible set.';


--
-- Name: coverage_matrix(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.coverage_matrix() RETURNS TABLE(jurisdiction_iso text, item_type text, item_count integer, source_count integer, most_recent_item_at timestamp with time zone, oldest_item_at timestamp with time zone, has_critical boolean)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  WITH item_pivot AS (
    SELECT
      ji AS jurisdiction_iso,
      item_type,
      COUNT(*) AS item_count,
      MAX(created_at) AS most_recent_item_at,
      MIN(created_at) AS oldest_item_at,
      BOOL_OR(priority = 'CRITICAL') AS has_critical
    FROM intelligence_items
    CROSS JOIN LATERAL UNNEST(jurisdiction_iso) AS ji
    GROUP BY ji, item_type
  ),
  source_pivot AS (
    SELECT
      ji AS jurisdiction_iso,
      COUNT(*) AS source_count
    FROM sources
    CROSS JOIN LATERAL UNNEST(jurisdiction_iso) AS ji
    WHERE status = 'active'
    GROUP BY ji
  )
  SELECT
    COALESCE(i.jurisdiction_iso, s.jurisdiction_iso) AS jurisdiction_iso,
    COALESCE(i.item_type, '__no_items__') AS item_type,
    COALESCE(i.item_count, 0)::INT,
    COALESCE(s.source_count, 0)::INT,
    i.most_recent_item_at,
    i.oldest_item_at,
    COALESCE(i.has_critical, FALSE)
  FROM item_pivot i
  FULL OUTER JOIN source_pivot s ON i.jurisdiction_iso = s.jurisdiction_iso;
$$;


--
-- Name: FUNCTION coverage_matrix(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.coverage_matrix() IS 'W2.D: Pivot of intelligence_items and active sources by jurisdiction_iso x item_type. STABLE; safe for repeated calls. Used by /admin coverage matrix sub-tab. Items / sources with empty jurisdiction_iso arrays are excluded from the result (no rows are produced for them) — this is the documented behavior; populate the array via the W4 backfill or manual edit to surface the row.';


--
-- Name: create_item_correction(uuid, text, text, text, jsonb, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_item_correction(p_item_id uuid, p_target_kind text, p_target_ref text, p_op text, p_value jsonb, p_reason text, p_created_by uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_id         uuid;
  v_ref        text := btrim(p_target_ref);
  v_claim_text text;
  v_res        public.validation_result;
  v_target     uuid;
  v_rel        text;
BEGIN
  IF p_created_by IS NULL THEN
    RAISE EXCEPTION 'correction_actor_required: created_by is required';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'correction_reason_required: a reason is required';
  END IF;

  INSERT INTO public.item_corrections (item_id, target_kind, target_ref, op, value, reason, created_by)
  VALUES (p_item_id, p_target_kind, v_ref, p_op, p_value, btrim(p_reason), p_created_by)
  RETURNING id INTO v_id;

  IF p_target_kind = 'tag' THEN
    UPDATE public.intelligence_items SET topic_tags = topic_tags WHERE id = p_item_id;
  ELSIF p_target_kind = 'full_brief' THEN
    UPDATE public.intelligence_items SET full_brief = full_brief WHERE id = p_item_id;
  ELSIF p_target_kind = 'section_text' THEN
    UPDATE public.intelligence_item_sections SET content_md = content_md
     WHERE item_id = p_item_id AND section_key = v_ref;
  ELSIF p_target_kind = 'fact' AND p_op = 'replace' THEN
    UPDATE public.section_claim_provenance SET claim_text = claim_text
     WHERE id = v_ref::uuid
    RETURNING claim_text INTO v_claim_text;
    v_res := public.validate_item_provenance(p_item_id);
    IF v_res.failures IS NOT NULL AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_res.failures) f
       WHERE f ->> 'reason' IN ('fact_missing_source_span', 'fact_span_not_in_source')
         AND f ->> 'claim' = v_claim_text
    ) THEN
      RAISE EXCEPTION 'correction_fact_failed_validation: validate_item_provenance rejects the corrected claim on item %', p_item_id;
    END IF;
  ELSIF p_target_kind = 'connection' THEN
    v_target := v_ref::uuid;
    IF p_op = 'remove' THEN
      DELETE FROM public.item_cross_references
       WHERE (source_item_id = p_item_id AND target_item_id = v_target)
          OR (source_item_id = v_target AND target_item_id = p_item_id);
    ELSE
      v_rel := COALESCE(NULLIF(p_value ->> 'relationship', ''), 'related');
      INSERT INTO public.item_cross_references (source_item_id, target_item_id, relationship, origin, basis, score)
      SELECT pairs.a, pairs.b, v_rel, 'manual',
             jsonb_build_array(jsonb_build_object('signal', 'admin_correction', 'detail', btrim(p_reason), 'weight', 1)),
             1
        FROM (VALUES (p_item_id, v_target), (v_target, p_item_id)) AS pairs(a, b)
      ON CONFLICT (source_item_id, target_item_id) DO UPDATE
         SET relationship = EXCLUDED.relationship,
             origin = 'manual',
             basis = EXCLUDED.basis,
             score = EXCLUDED.score;
    END IF;
  END IF;

  RETURN v_id;
END;
$$;


--
-- Name: create_org_for_self(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_org_for_self(p_org_name text, p_org_slug text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_caller_id uuid;
  v_org_id    uuid;
  v_slug      text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_org_name IS NULL OR length(trim(p_org_name)) = 0 THEN
    RAISE EXCEPTION 'Org name is required' USING ERRCODE = '22023';
  END IF;
  IF length(p_org_name) > 200 THEN
    RAISE EXCEPTION 'Org name too long' USING ERRCODE = '22023';
  END IF;

  -- Slug: caller-provided or derived from the name. Lowercase, hyphenated,
  -- with a short random suffix to avoid collisions.
  v_slug := COALESCE(
    nullif(trim(p_org_slug), ''),
    regexp_replace(lower(trim(p_org_name)), '[^a-z0-9]+', '-', 'g')
  );
  v_slug := substring(v_slug from 1 for 40);
  v_slug := trim(both '-' from v_slug);
  IF v_slug IS NULL OR v_slug = '' THEN
    v_slug := 'org';
  END IF;
  -- Append 6 hex chars for uniqueness.
  v_slug := v_slug || '-' || encode(gen_random_bytes(3), 'hex');

  -- Insert org. The org_write_service RLS policy restricts public INSERT
  -- to service_role; this DEFINER fn bypasses that.
  INSERT INTO public.organizations (name, slug, plan)
  VALUES (trim(p_org_name), v_slug, 'free')
  RETURNING id INTO v_org_id;

  -- Owner membership.
  INSERT INTO public.org_memberships (org_id, user_id, role)
  VALUES (v_org_id, v_caller_id, 'owner');

  -- Seed default workspace_settings. (sector_profile defaults to {} per
  -- the column default; the user runs onboarding to populate it.)
  INSERT INTO public.workspace_settings (org_id)
  VALUES (v_org_id);

  RETURN v_org_id;
END;
$$;


--
-- Name: FUNCTION create_org_for_self(p_org_name text, p_org_slug text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_org_for_self(p_org_name text, p_org_slug text) IS 'Self-service org creation. Caller becomes owner, default workspace_settings seeded. Slug auto-derived if not provided. Used by the "Create your own workspace" path on the no-workspace landing page.';


--
-- Name: decline_invitation(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.decline_invitation(p_token text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_invitation public.org_invitations;
  v_caller_id  uuid;
  v_caller_email text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT lower(u.email) INTO v_caller_email
  FROM auth.users u WHERE u.id = v_caller_id;

  SELECT * INTO v_invitation
  FROM public.org_invitations
  WHERE token = p_token
  FOR UPDATE;

  IF v_invitation IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_invitation.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is %', v_invitation.status USING ERRCODE = '22023';
  END IF;
  IF v_invitation.invited_email <> COALESCE(v_caller_email, '') THEN
    RAISE EXCEPTION 'Invitation is for a different email' USING ERRCODE = '42501';
  END IF;

  UPDATE public.org_invitations
  SET status = 'declined',
      declined_at = now()
  WHERE id = v_invitation.id;
END;
$$;


--
-- Name: FUNCTION decline_invitation(p_token text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.decline_invitation(p_token text) IS 'Decline an org invitation by token. Requires caller email match. Flips invitation status to declined.';


--
-- Name: derive_canonical_instrument_key(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.derive_canonical_instrument_key(p_instr text, p_src_url text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  m     text[];
  v_map text;
BEGIN
  -- (1) CELEX token in instrument_identifier, WITH optional OJ sequence suffix '(NN)'
  m := regexp_match(COALESCE(p_instr, ''), '([1-9][0-9]{4}[A-Z][0-9]{4})\(([0-9]{1,2})\)');
  IF m IS NOT NULL THEN RETURN upper(m[1]) || '(' || lpad(m[2], 2, '0') || ')'; END IF;
  m := regexp_match(COALESCE(p_instr, ''), '([1-9][0-9]{4}[A-Z][0-9]{4})');
  IF m IS NOT NULL THEN RETURN upper(m[1]); END IF;

  -- (2) ELI relative path in instrument_identifier
  m := regexp_match(COALESCE(p_instr, ''), '^eli/(reg|dir|dec)/([0-9]{4})/([0-9]+)');
  IF m IS NOT NULL THEN
    v_map := CASE m[1] WHEN 'reg' THEN 'R' WHEN 'dir' THEN 'L' WHEN 'dec' THEN 'D' END;
    RETURN '3' || m[2] || v_map || lpad(m[3], 4, '0');
  END IF;

  -- (3) CELEX token in source_url, WITH optional suffix — parens may be literal or URL-encoded %28/%29
  m := regexp_match(COALESCE(p_src_url, ''), 'CELEX(?::|%3[Aa])?([1-9][0-9]{4}[A-Z][0-9]{4})(?:\(|%28)([0-9]{1,2})(?:\)|%29)');
  IF m IS NOT NULL THEN RETURN upper(m[1]) || '(' || lpad(m[2], 2, '0') || ')'; END IF;
  m := regexp_match(COALESCE(p_src_url, ''), 'CELEX(?::|%3[Aa])?([1-9][0-9]{4}[A-Z][0-9]{4})');
  IF m IS NOT NULL THEN RETURN upper(m[1]); END IF;

  -- (4) ELI path in source_url
  m := regexp_match(COALESCE(p_src_url, ''), '/eli/(reg|dir|dec)/([0-9]{4})/([0-9]+)');
  IF m IS NOT NULL THEN
    v_map := CASE m[1] WHEN 'reg' THEN 'R' WHEN 'dir' THEN 'L' WHEN 'dec' THEN 'D' END;
    RETURN '3' || m[2] || v_map || lpad(m[3], 4, '0');
  END IF;

  RETURN NULL;
END;
$$;


--
-- Name: derive_source_category(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.derive_source_category(p_role text, p_name text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  SELECT CASE
    -- Name-based exceptions (apply first; precedence over role default) — from migration 084.
    WHEN lower(p_name) LIKE '%imo%' OR lower(p_name) LIKE '%icao%' THEN 'regulatory'
    WHEN lower(p_name) LIKE '%freightwaves%'
      OR lower(p_name) LIKE '%loadstar%'
      OR lower(p_name) LIKE '%greenbiz%'
      OR lower(p_name) LIKE '%environmental finance%'
      OR lower(p_name) LIKE '%splash247%'
      OR lower(p_name) LIKE '%supply chain digital%'
      OR lower(p_name) LIKE '%edie%'
      OR lower(p_name) LIKE '%reuters sustainable business%'
      OR lower(p_name) LIKE '%carbon trust%'
      OR lower(p_name) LIKE '%project drawdown%'
      THEN 'research'
    -- Role-based defaults — from migration 084.
    WHEN p_role IN ('primary_legal_authority', 'standards_body', 'government_press') THEN 'regulatory'
    WHEN p_role IN ('intergovernmental_body', 'academic_research') THEN 'research'
    WHEN p_role IN ('trade_press', 'industry_data_provider', 'vendor_corporate', 'industry_association') THEN 'market_news'
    WHEN p_role = 'statistical_data_agency' THEN 'operational_data'
    ELSE NULL
  END
$$;


--
-- Name: derive_source_intelligence_types(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.derive_source_intelligence_types(p_category text) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  SELECT CASE p_category
    WHEN 'regulatory'       THEN ARRAY['regulation']
    WHEN 'research'         THEN ARRAY['research']
    WHEN 'market_news'      THEN ARRAY['market_intel']
    WHEN 'operational_data' THEN ARRAY['operational_data']
    ELSE ARRAY[]::text[]
  END
$$;


--
-- Name: effective_confidence(numeric, timestamp with time zone, integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.effective_confidence(base numeric, asserted_at timestamp with time zone, half_life_days integer, now_ts timestamp with time zone) RETURNS numeric
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN half_life_days IS NULL THEN base
    ELSE round(base * power(0.5, extract(epoch FROM (now_ts - asserted_at)) / (half_life_days * 86400.0)), 3)
  END;
$$;


--
-- Name: FUNCTION effective_confidence(base numeric, asserted_at timestamp with time zone, half_life_days integer, now_ts timestamp with time zone); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.effective_confidence(base numeric, asserted_at timestamp with time zone, half_life_days integer, now_ts timestamp with time zone) IS 'Spec 08 §3.2''s decay formula, byte-identical, with the one addition the spec''s own SQL block leaves implicit in prose: a NULL half_life_days returns base unchanged (no decay). Mirrored in JS by src/lib/propagation/effective-confidence.mjs, proven to agree on fixtures.';


--
-- Name: emission_factors_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.emission_factors_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'emission_factors is append-only: supersede the row instead of deleting it (factor_id=%)', OLD.factor_id;
  END IF;
  -- Only the supersession columns may move. Comparing the rest as a whole row means a column added later
  -- is protected by default rather than by remembering to extend this list.
  IF (to_jsonb(NEW) - 'superseded_by' - 'valid_to') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_by' - 'valid_to') THEN
    RAISE EXCEPTION 'emission_factors is append-only: only superseded_by and valid_to may change (factor_id=%)', OLD.factor_id;
  END IF;
  RETURN NEW;
END $$;


--
-- Name: emit_propagation_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.emit_propagation_event() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_new       jsonb;
  v_old       jsonb;
  v_pk_col    text := TG_ARGV[0];
  v_kind      text;
  v_row_pk    text;
  v_entity_id text;
BEGIN
  IF coalesce(current_setting('app.outbox_backfill_writer', true), '') = TG_TABLE_NAME THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_old := NULL;
    v_kind := 'insert';
  ELSIF TG_OP = 'DELETE' THEN
    v_new := NULL;
    v_old := to_jsonb(OLD);
    v_kind := 'delete';
  ELSE
    v_new := to_jsonb(NEW);
    v_old := to_jsonb(OLD);
    IF (v_new - 'updated_at') IS NOT DISTINCT FROM (v_old - 'updated_at') THEN
      RETURN NEW;
    END IF;
    IF (v_old ? 'superseded_by') AND (v_old->>'superseded_by') IS NULL AND (v_new->>'superseded_by') IS NOT NULL THEN
      v_kind := 'supersede';
    ELSE
      v_kind := 'update';
    END IF;
  END IF;

  v_row_pk := coalesce(v_new->>v_pk_col, v_old->>v_pk_col);
  v_entity_id := coalesce(v_new->>'entity_id', v_old->>'entity_id');

  IF v_entity_id IS NULL AND TG_NARGS >= 2 THEN
    v_entity_id := coalesce(v_new->>TG_ARGV[1], v_old->>TG_ARGV[1]);
    IF v_entity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.entities e WHERE e.entity_id = v_entity_id) THEN
      v_entity_id := NULL;
    END IF;
  END IF;

  INSERT INTO public.propagation_events (table_name, row_pk, entity_id, change_kind, old_row, new_row)
  VALUES (TG_TABLE_NAME, v_row_pk, v_entity_id, v_kind, v_old, v_new);

  RETURN NEW;
END $$;


--
-- Name: FUNCTION emit_propagation_event(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.emit_propagation_event() IS 'The outbox writer (spec 08 section 2.2 Part 1). ONE INSERT, no recursion. TG_ARGV[0] names the primary-key column. Optional TG_ARGV[1] (migration 352) names a column that holds an entity id, used when the row has no entity_id column of its own and only when an entities row exists for the value (propagation_events.entity_id is an FK). A transaction-local app.outbox_backfill_writer marker equal to TG_TABLE_NAME (migration 373, set only by backfill_market_series_entity) skips emission for a declared backfill. Attached AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW on every propagation source table.';


--
-- Name: emit_propagation_events_for_region(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.emit_propagation_events_for_region() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_new        jsonb;
  v_old        jsonb;
  v_pk_col     text := TG_ARGV[0];
  v_region_col text := TG_ARGV[1];
  v_kind       text;
  v_row_pk     text;
  v_region_new uuid;
  v_region_old uuid;
  r            record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW);
    v_old := NULL;
    v_kind := 'insert';
  ELSIF TG_OP = 'DELETE' THEN
    v_new := NULL;
    v_old := to_jsonb(OLD);
    v_kind := 'delete';
  ELSE
    v_new := to_jsonb(NEW);
    v_old := to_jsonb(OLD);
    IF (v_new - 'updated_at') IS NOT DISTINCT FROM (v_old - 'updated_at') THEN
      RETURN NEW;
    END IF;
    IF (v_old ? 'superseded_by') AND (v_old->>'superseded_by') IS NULL AND (v_new->>'superseded_by') IS NOT NULL THEN
      v_kind := 'supersede';
    ELSE
      v_kind := 'update';
    END IF;
  END IF;

  v_row_pk := coalesce(v_new->>v_pk_col, v_old->>v_pk_col);
  v_region_new := (v_new->>v_region_col)::uuid;
  v_region_old := (v_old->>v_region_col)::uuid;

  FOR r IN
    SELECT DISTINCT er.entity_id
      FROM public.entity_refs er
     WHERE er.ref_table = 'regions'
       AND er.role = 'jurisdiction'
       AND er.ref_id IN (v_region_new, v_region_old)
     ORDER BY er.entity_id
  LOOP
    INSERT INTO public.propagation_events (table_name, row_pk, entity_id, change_kind, old_row, new_row)
    VALUES (TG_TABLE_NAME, v_row_pk, r.entity_id, v_kind, v_old, v_new);
  END LOOP;

  RETURN NEW;
END $$;


--
-- Name: FUNCTION emit_propagation_events_for_region(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.emit_propagation_events_for_region() IS 'Outbox writer for a table whose rows belong to a region (migration 373). Same classification and INSERT as emit_propagation_event(); the entity is each jurisdiction entity of the row''s region (entity_refs, ref_table regions, role jurisdiction), one outbox row per entity, none when the region has no ref. TG_ARGV[0] is the primary-key column, TG_ARGV[1] the region id column. Invoker rights, search_path pinned.';


--
-- Name: enqueue_corpus_turn_request(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_corpus_turn_request() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_reason text;
BEGIN
  IF NEW.is_archived OR NEW.provenance_status <> 'verified' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_reason := 'inserted';
  ELSIF (OLD.is_archived IS DISTINCT FROM NEW.is_archived) THEN
    v_reason := 'unarchived';
  ELSIF (OLD.provenance_status IS DISTINCT FROM NEW.provenance_status) THEN
    v_reason := 'verified';
  ELSIF (OLD.operational_scenario_tags IS DISTINCT FROM NEW.operational_scenario_tags
      OR OLD.compliance_object_tags   IS DISTINCT FROM NEW.compliance_object_tags
      OR OLD.topic_tags               IS DISTINCT FROM NEW.topic_tags) THEN
    v_reason := 'tags_applied';
  ELSE
    v_reason := 'updated';
  END IF;

  INSERT INTO public.corpus_turn_requests (intelligence_item_id, reason)
  VALUES (NEW.id, v_reason)
  ON CONFLICT (intelligence_item_id) WHERE consumed_at IS NULL DO NOTHING;

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION enqueue_corpus_turn_request(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.enqueue_corpus_turn_request() IS 'Migration 277. AFTER INSERT OR UPDATE OF (provenance_status, is_archived, operational_scenario_tags, compliance_object_tags, topic_tags) ON intelligence_items. Skips archived/not-verified rows; otherwise inserts one open corpus_turn_requests row per item (ON CONFLICT DO NOTHING against the partial-unique open-request index), reason derived from which tracked column actually changed. Deliberately carries no pg_trigger_depth() guard — see this migration''s header for why mirroring migration 115''s guard here would silently drop the nested set_provenance_status-cascade case this migration exists to catch.';


--
-- Name: enqueue_pending_first_fetch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_pending_first_fetch() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  has_existing_item BOOLEAN;
BEGIN
  -- Eligibility gate: only active, unpaused, auto-run-enabled sources.
  IF NEW.status IS DISTINCT FROM 'active' THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.processing_paused, FALSE) = TRUE THEN
    RETURN NEW;
  END IF;
  IF COALESCE(NEW.auto_run_enabled, FALSE) = FALSE THEN
    RETURN NEW;
  END IF;

  -- For UPDATE: require a real flip on auto_run_enabled. Re-saves of
  -- unrelated columns must not enqueue.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.auto_run_enabled IS NOT DISTINCT FROM NEW.auto_run_enabled THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Skip if an intelligence_items row already references this source.
  -- Sources that already have ingestion history flow through the
  -- existing periodic check-sources worker, not the first-fetch queue.
  SELECT EXISTS (
    SELECT 1 FROM intelligence_items WHERE source_id = NEW.id LIMIT 1
  ) INTO has_existing_item;

  IF has_existing_item THEN
    RETURN NEW;
  END IF;

  -- Enqueue. The partial unique index on (source_id) WHERE status NOT
  -- IN ('done', 'skipped') keeps duplicates out, so use ON CONFLICT
  -- DO NOTHING to make the trigger safe under concurrent flips.
  INSERT INTO pending_first_fetch (source_id, status)
  VALUES (NEW.id, 'queued')
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION enqueue_pending_first_fetch(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.enqueue_pending_first_fetch() IS 'Trigger function for sources INSERT/UPDATE OF auto_run_enabled. Inserts pending_first_fetch row when source becomes eligible AND no intelligence_items row already exists. Wave 1b foundation.';


--
-- Name: entity_aliases_refuse_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.entity_aliases_refuse_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  RAISE EXCEPTION 'entity_aliases is insert-only: % is refused; a correction is a new row with a later asserted_at', TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;


--
-- Name: FUNCTION entity_aliases_refuse_change(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.entity_aliases_refuse_change() IS 'Refuses UPDATE, DELETE and TRUNCATE on entity_aliases (aliases are evidence, never edited). SECURITY INVOKER, search_path pinned. Migration 377.';


--
-- Name: entity_relations_refuse_cycle(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.entity_relations_refuse_cycle() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('entity_relations_cycle', 0));

  IF NEW.parent_entity_id = NEW.child_entity_id THEN
    RAISE EXCEPTION 'entity_relations: % cannot be its own parent', NEW.parent_entity_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    WITH RECURSIVE ancestors(entity_id) AS (
      SELECT NEW.parent_entity_id
      UNION
      SELECT r.parent_entity_id
        FROM public.entity_relations r
        JOIN ancestors a ON r.child_entity_id = a.entity_id
       WHERE NOT (TG_OP = 'UPDATE'
                  AND r.parent_entity_id = OLD.parent_entity_id
                  AND r.child_entity_id = OLD.child_entity_id
                  AND r.relation = OLD.relation)
    )
    SELECT 1 FROM ancestors WHERE entity_id = NEW.child_entity_id
  ) THEN
    RAISE EXCEPTION 'entity_relations: % as the child of % would make the child an ancestor of its own parent (a cycle)',
      NEW.child_entity_id, NEW.parent_entity_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;


--
-- Name: FUNCTION entity_relations_refuse_cycle(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.entity_relations_refuse_cycle() IS 'Refuses an entity_relations row whose child is already an ancestor of its parent (or is the parent). SECURITY INVOKER, search_path pinned. Migration 377.';


--
-- Name: gate_a_health(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.gate_a_health() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT CASE
    WHEN c.computed_at IS NULL THEN
      jsonb_build_object('error', 'gate_a_health cache empty; refresh has never run')
    WHEN c.computed_at < now() - interval '30 minutes' THEN
      jsonb_build_object('error', 'gate_a_health cache stale since ' || c.computed_at::text)
    ELSE c.payload || jsonb_build_object('computed_at', c.computed_at)
  END
  FROM (SELECT payload, computed_at FROM public.gate_a_health_cache WHERE singleton) c
  RIGHT JOIN (SELECT 1) one ON true;
$$;


--
-- Name: gate_a_health_compute(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.gate_a_health_compute() RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT jsonb_build_object(
    'invariant_violations', (
      SELECT count(*)::int FROM public.intelligence_items i
        JOIN public.item_gate_a_state g ON g.intelligence_item_id = i.id
       WHERE i.provenance_status='verified' AND coalesce(i.full_brief,'')<>'' AND g.orphan_count>0),
    'briefless_verified', (
      SELECT count(*)::int FROM public.intelligence_items
       WHERE provenance_status='verified' AND coalesce(full_brief,'')=''),
    'no_gatestate_verified', (
      SELECT count(*)::int FROM public.intelligence_items i
       WHERE i.provenance_status='verified' AND coalesce(i.full_brief,'')<>''
         AND NOT EXISTS (SELECT 1 FROM public.item_gate_a_state g WHERE g.intelligence_item_id=i.id)),
    'verified_failing_revalidation', (
      SELECT count(*)::int FROM public.intelligence_items i
       WHERE i.provenance_status='verified' AND NOT (public.validate_item_provenance(i.id)).valid),
    'verified_gen_ver_null_info', (
      SELECT count(*)::int FROM public.intelligence_items
       WHERE provenance_status='verified' AND regeneration_skill_version IS NULL)
  );
$$;


--
-- Name: gate_a_health_refresh(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.gate_a_health_refresh() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.gate_a_health_cache AS c (singleton, payload, computed_at)
  VALUES (true, public.gate_a_health_compute(), now())
  ON CONFLICT (singleton)
  DO UPDATE SET payload = EXCLUDED.payload, computed_at = EXCLUDED.computed_at;
END;
$$;


--
-- Name: get_all_surface_counts(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_all_surface_counts(p_org_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public._assert_org_membership(p_org_id);

  WITH scope AS (
    SELECT
      surface_of(ii.item_type, ii.domain) AS surface,
      (ii.provenance_status = 'verified')  AS is_verified
    FROM intelligence_items ii
    LEFT JOIN workspace_item_overrides wo
      ON  wo.item_id = ii.id
      AND wo.org_id  = p_org_id
    WHERE NOT COALESCE(wo.is_archived, ii.is_archived)
  ),
  per_surface AS (
    SELECT surface,
           COUNT(*) FILTER (WHERE is_verified)::int AS verified,
           COUNT(*)::int                           AS total
    FROM scope
    GROUP BY surface
  ),
  surfaces(s) AS (
    VALUES ('regulations'), ('market'), ('operations'), ('research'), ('uncategorized')
  ),
  filled AS (
    SELECT surfaces.s AS surface,
           COALESCE(ps.verified, 0) AS verified,
           COALESCE(ps.total, 0)    AS total
    FROM surfaces
    LEFT JOIN per_surface ps ON ps.surface = surfaces.s
  )
  SELECT
    jsonb_object_agg(
      filled.surface,
      jsonb_build_object('verified', filled.verified, 'total', filled.total)
    )
    || jsonb_build_object(
         'total',
         jsonb_build_object(
           'verified', (SELECT COALESCE(SUM(verified), 0)::int FROM filled),
           'total',    (SELECT COALESCE(SUM(total), 0)::int    FROM filled)
         )
       )
  INTO v_result
  FROM filled;

  RETURN v_result;
END;
$$;


--
-- Name: FUNCTION get_all_surface_counts(p_org_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_all_surface_counts(p_org_id uuid) IS 'One-scan {verified,total} per customer surface + grand total, for the dashboard rail. Active rows with the workspace override overlay applied. Customer rail consumes .verified (ruling 1); admin rail renders both. uncategorized is a defect signal (binding 4), never a customer surface. Membership gate (migration 361): _assert_org_membership(p_org_id) raises for a non-member, an unauthenticated caller or a NULL org; the service role bypasses a membership check.';


--
-- Name: get_market_intel_items(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_market_intel_items(p_org_id uuid) RETURNS TABLE(id uuid, legacy_id text, title text, summary text, what_is_it text, why_matters text, key_data text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, signal_band text, trajectory_points jsonb, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, what_it_changes text, conversion_trigger text, cross_references text, effective_priority text, effective_archived boolean, jurisdiction_iso text[], item_grade text, cost_mechanism text, penalty_range text, enforcement_body text, requirement_trajectory jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.summary, ii.what_is_it, ii.why_matters,
    ii.key_data, ii.tags, ii.domain, ii.category, ii.item_type, ii.source_id,
    ii.source_url, ii.jurisdictions, ii.transport_modes, ii.verticals, ii.status,
    ii.severity, ii.signal_band, ii.trajectory_points, ii.confidence, ii.priority,
    ii.entry_into_force, ii.compliance_deadline, ii.next_review_date, ii.added_date,
    ii.last_verified, ii.is_archived, ii.what_it_changes, ii.conversion_trigger,
    ii.cross_references,
    COALESCE(wo.priority_override, ii.priority) AS effective_priority,
    COALESCE(wo.is_archived, ii.is_archived)    AS effective_archived,
    ii.jurisdiction_iso,
    ii.item_grade,
    ii.cost_mechanism, ii.penalty_range, ii.enforcement_body, ii.requirement_trajectory
  FROM public.intelligence_items ii
  JOIN public.sources s ON s.id = ii.source_id
  LEFT JOIN public.workspace_item_overrides wo ON wo.item_id = ii.id AND wo.org_id = p_org_id
  WHERE NOT COALESCE(wo.is_archived, ii.is_archived)
    AND ii.provenance_status = 'verified'
    AND public.surface_of(ii.item_type, ii.domain) = 'market'
  ORDER BY
    CASE COALESCE(wo.priority_override, ii.priority)
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC, ii.id ASC;
END;
$$;


--
-- Name: get_market_intel_items_public(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_market_intel_items_public() RETURNS TABLE(id uuid, legacy_id text, title text, summary text, what_is_it text, why_matters text, key_data text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, signal_band text, trajectory_points jsonb, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, what_it_changes text, conversion_trigger text, cross_references text, effective_priority text, effective_archived boolean, jurisdiction_iso text[], item_grade text, cost_mechanism text, penalty_range text, enforcement_body text, requirement_trajectory jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.summary, ii.what_is_it, ii.why_matters,
    ii.key_data, ii.tags, ii.domain, ii.category, ii.item_type, ii.source_id,
    ii.source_url, ii.jurisdictions, ii.transport_modes, ii.verticals, ii.status,
    ii.severity, ii.signal_band, ii.trajectory_points, ii.confidence, ii.priority,
    ii.entry_into_force, ii.compliance_deadline, ii.next_review_date, ii.added_date,
    ii.last_verified, ii.is_archived, ii.what_it_changes, ii.conversion_trigger,
    ii.cross_references,
    ii.priority::text   AS effective_priority,
    ii.is_archived        AS effective_archived,
    ii.jurisdiction_iso,
    ii.item_grade,
    ii.cost_mechanism, ii.penalty_range, ii.enforcement_body, ii.requirement_trajectory
  FROM public.intelligence_items ii
  JOIN public.sources s ON s.id = ii.source_id
  WHERE NOT ii.is_archived
    AND ii.provenance_status = 'verified'
    AND public.surface_of(ii.item_type, ii.domain) = 'market'
  ORDER BY
    CASE ii.priority
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC, ii.id ASC;
END;
$$;


--
-- Name: get_operations_items_public(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_operations_items_public() RETURNS TABLE(id uuid, legacy_id text, title text, summary text, what_is_it text, why_matters text, key_data text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, effective_priority text, effective_archived boolean, jurisdiction_iso text[], item_grade text, cost_mechanism text, penalty_range text, enforcement_body text, requirement_trajectory jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.summary, ii.what_is_it, ii.why_matters,
    ii.key_data, ii.tags, ii.domain, ii.category, ii.item_type,
    ii.source_id, ii.source_url, ii.jurisdictions, ii.transport_modes,
    ii.verticals, ii.status, ii.severity, ii.confidence, ii.priority,
    ii.entry_into_force, ii.compliance_deadline, ii.next_review_date,
    ii.added_date, ii.last_verified, ii.is_archived,
    ii.priority::text   AS effective_priority,
    ii.is_archived        AS effective_archived,
    ii.jurisdiction_iso,
    ii.item_grade,
    ii.cost_mechanism, ii.penalty_range, ii.enforcement_body, ii.requirement_trajectory
  FROM public.intelligence_items ii
  JOIN public.sources s ON s.id = ii.source_id
  WHERE NOT ii.is_archived
    AND ii.provenance_status = 'verified'
    AND public.surface_of(ii.item_type, ii.domain) = 'operations'
  ORDER BY
    CASE ii.priority
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC, ii.id ASC;
END;
$$;


--
-- Name: get_research_items_public(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_research_items_public() RETURNS TABLE(id uuid, legacy_id text, title text, summary text, what_is_it text, why_matters text, key_data text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, what_it_changes text, does_not_resolve text, effective_priority text, effective_archived boolean, jurisdiction_iso text[], item_grade text, cost_mechanism text, penalty_range text, enforcement_body text, requirement_trajectory jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.summary, ii.what_is_it, ii.why_matters,
    ii.key_data, ii.tags, ii.domain, ii.category, ii.item_type,
    ii.source_id, ii.source_url, ii.jurisdictions, ii.transport_modes,
    ii.verticals, ii.status, ii.severity, ii.confidence, ii.priority,
    ii.entry_into_force, ii.compliance_deadline, ii.next_review_date,
    ii.added_date, ii.last_verified, ii.is_archived,
    ii.what_it_changes, ii.does_not_resolve,
    ii.priority::text   AS effective_priority,
    ii.is_archived        AS effective_archived,
    ii.jurisdiction_iso,
    ii.item_grade,
    ii.cost_mechanism, ii.penalty_range, ii.enforcement_body, ii.requirement_trajectory
  FROM public.intelligence_items ii
  JOIN public.sources s ON s.id = ii.source_id
  WHERE NOT ii.is_archived
    AND ii.provenance_status = 'verified'
    AND public.surface_of(ii.item_type, ii.domain) = 'research'
  ORDER BY
    CASE ii.priority
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC, ii.id ASC;
END;
$$;


--
-- Name: get_research_source_coverage(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_research_source_coverage() RETURNS TABLE(transport_mode text, jurisdiction_iso text, source_count integer)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT
    tm AS transport_mode,
    ji AS jurisdiction_iso,
    COUNT(*)::INT AS source_count
  FROM public.sources
  CROSS JOIN LATERAL UNNEST(transport_modes) AS tm
  CROSS JOIN LATERAL UNNEST(jurisdiction_iso) AS ji
  WHERE category = 'research'
    AND status = 'active'
  GROUP BY tm, ji;
$$;


--
-- Name: FUNCTION get_research_source_coverage(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_research_source_coverage() IS 'Build 8.5: pivot of active Research-bound sources (sources.category=research, status=active) by (transport_mode x jurisdiction_iso). One row per (mode, jurisdiction) cell with source_count; cells with zero sources are omitted (the UI fills them as none-coverage). Caller is customer-facing /research source coverage tab. Sources with empty transport_modes OR empty jurisdiction_iso arrays produce no rows for the missing axis (documented behavior; the registry-classification step is where that gap closes).';


--
-- Name: get_source_citation_stats(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_source_citation_stats(source_ids uuid[]) RETURNS TABLE(source_id uuid, citation_count integer, recency timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT req.source_id::uuid AS source_id,
         count(DISTINCT iic.intelligence_item_id)::int AS citation_count,
         max(iic.detected_at) AS recency
    FROM unnest(source_ids) AS req(source_id)
    LEFT JOIN public.intelligence_item_citations iic
      ON iic.source_id = req.source_id
   GROUP BY req.source_id;
$$;


--
-- Name: FUNCTION get_source_citation_stats(source_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_source_citation_stats(source_ids uuid[]) IS 'Q1 swap (Build 8): per-source citation_count + recency from the intelligence_item_citations edge table (replaced legacy intelligence_items.source_id OR sources_used union from migration 088). citation_count uses DISTINCT intelligence_item_id to dedupe across multiple origin tags (backfill + agent_extraction + manual) for the same (item, source) pair. recency = max(detected_at).';


--
-- Name: get_surface_counts(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_surface_counts(p_org_id uuid, p_surface text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_org_id IS NULL THEN
    IF auth.role() IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'org_id is required' USING ERRCODE = '42501';
    END IF;
  ELSE
    PERFORM public._assert_org_membership(p_org_id);
  END IF;

  WITH scope AS (
    SELECT
      ii.id,
      ii.status,
      ii.jurisdictions,
      ii.updated_at,
      ii.severity,
      ii.signal_band,
      COALESCE(wo.priority_override, ii.priority) AS effective_priority
    FROM intelligence_items ii
    LEFT JOIN workspace_item_overrides wo
      ON  wo.item_id = ii.id
      AND wo.org_id  = p_org_id
    WHERE NOT COALESCE(wo.is_archived, ii.is_archived)
      AND ii.provenance_status = 'verified'
      AND surface_of(ii.item_type, ii.domain) = p_surface
  ),
  by_priority AS (
    SELECT effective_priority AS k, COUNT(*)::int AS v FROM scope
    WHERE effective_priority IS NOT NULL GROUP BY effective_priority
  ),
  by_severity AS (
    SELECT severity AS k, COUNT(*)::int AS v FROM scope
    WHERE severity IS NOT NULL GROUP BY severity
  ),
  by_band AS (
    SELECT signal_band AS k, COUNT(*)::int AS v FROM scope
    WHERE signal_band IS NOT NULL GROUP BY signal_band
  ),
  by_status AS (
    SELECT status AS k, COUNT(*)::int AS v FROM scope
    WHERE status IS NOT NULL GROUP BY status
  ),
  juris_unnest AS (
    SELECT NULLIF(TRIM(j), '') AS jurisdiction
    FROM scope LEFT JOIN LATERAL unnest(scope.jurisdictions) AS j ON TRUE
  ),
  by_jurisdiction AS (
    SELECT jurisdiction AS k, COUNT(*)::int AS v FROM juris_unnest
    WHERE jurisdiction IS NOT NULL GROUP BY jurisdiction
  )
  SELECT jsonb_build_object(
    'surface',             p_surface,
    'total_items',         (SELECT COUNT(*)::int FROM scope),
    'by_priority',         COALESCE((SELECT jsonb_object_agg(k, v) FROM by_priority), '{}'::jsonb),
    'by_severity',         COALESCE((SELECT jsonb_object_agg(k, v) FROM by_severity), '{}'::jsonb),
    'by_band',             COALESCE((SELECT jsonb_object_agg(k, v) FROM by_band), '{}'::jsonb),
    'by_status',           COALESCE((SELECT jsonb_object_agg(k, v) FROM by_status), '{}'::jsonb),
    'by_jurisdiction',     COALESCE((SELECT jsonb_object_agg(k, v) FROM by_jurisdiction), '{}'::jsonb),
    'total_jurisdictions', (SELECT COUNT(DISTINCT jurisdiction)::int FROM juris_unnest WHERE jurisdiction IS NOT NULL),
    'last_updated_at',     (SELECT MAX(updated_at) FROM scope)
  ) INTO v_result;

  RETURN v_result;
END;
$$;


--
-- Name: FUNCTION get_surface_counts(p_org_id uuid, p_surface text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_surface_counts(p_org_id uuid, p_surface text) IS 'Verified-population count bundle for ONE customer surface (regulations/market/operations/research/uncategorized). Gates provenance_status=verified (ruling 1). total_items = distinct verified items (header); by_priority/by_severity/by_band = label instances (cards). Override overlay applied as one LEFT JOIN. Membership gate (migration 361): _assert_org_membership(p_org_id) raises 42501 for a non-member or an unauthenticated caller; the service role bypasses; a NULL org (public platform-wide masthead read, PERF-10) is service role only.';


--
-- Name: get_tier_opinion_disagreements(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_tier_opinion_disagreements(window_days integer DEFAULT 90) RETURNS TABLE(target_source_id uuid, current_base_tier integer, opined_tiers integer[], opinion_count bigint, distinct_disagreeing_tiers integer)
    LANGUAGE sql STABLE
    AS $$
  WITH window_opinions AS (
    SELECT
      o.target_source_id,
      o.opined_tier
    FROM public.source_tier_opinions o
    WHERE o.opined_at >= now() - (window_days || ' days')::interval
      AND o.dismissed_at IS NULL
  ),
  per_source AS (
    SELECT
      wo.target_source_id,
      s.base_tier AS current_base_tier,
      ARRAY_AGG(wo.opined_tier ORDER BY wo.opined_tier) AS opined_tiers,
      COUNT(*) AS opinion_count,
      COUNT(DISTINCT wo.opined_tier) FILTER (WHERE wo.opined_tier <> s.base_tier)::INT AS distinct_disagreeing_tiers,
      COUNT(*) FILTER (WHERE wo.opined_tier <> s.base_tier) AS disagreeing_count
    FROM window_opinions wo
    JOIN public.sources s ON s.id = wo.target_source_id
    GROUP BY wo.target_source_id, s.base_tier
  )
  SELECT
    p.target_source_id,
    p.current_base_tier,
    p.opined_tiers,
    p.opinion_count,
    p.distinct_disagreeing_tiers
  FROM per_source p
  WHERE p.disagreeing_count >= 5
  ORDER BY p.disagreeing_count DESC, p.opinion_count DESC;
$$;


--
-- Name: FUNCTION get_tier_opinion_disagreements(window_days integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_tier_opinion_disagreements(window_days integer) IS 'Q3 disagreement aggregator (091, updated by 099). Returns sources where >=5 non-dismissed tier opinions in the window disagree with the source''s current base tier. Default window 90 days per Q7. Phase 7 admin chrome consumes this for the disagreement review surface.';


--
-- Name: get_workspace_due_next(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_workspace_due_next(p_org_id uuid, p_limit integer DEFAULT 24) RETURNS TABLE(id uuid, legacy_id text, title text, summary text, tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, effective_priority text, effective_archived boolean, jurisdiction_iso text[], next_binding_date date)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE v_limit integer := LEAST(GREATEST(COALESCE(p_limit,24),1),100);
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN QUERY
  WITH active AS (SELECT ii.* FROM public._workspace_active_items(p_org_id) ii),
  dated AS (
    SELECT a.*, LEAST(
      CASE WHEN a.compliance_deadline >= current_date THEN a.compliance_deadline END,
      (SELECT MIN(t.milestone_date) FROM public.item_timelines t WHERE t.item_id = a.id AND t.milestone_date >= current_date)
    ) AS nbd
    FROM active a
  )
  SELECT d.id, d.legacy_id, d.title, d.summary, d.tags, d.domain, d.category, d.item_type, d.source_id, d.source_url, d.jurisdictions, d.transport_modes, d.verticals, d.status, d.severity, d.confidence, d.priority, d.entry_into_force, d.compliance_deadline, d.next_review_date, d.added_date, d.last_verified, d.is_archived, d.effective_priority, d.effective_archived, d.jurisdiction_iso, d.nbd
  FROM dated d WHERE d.nbd IS NOT NULL ORDER BY d.nbd ASC, d.id ASC LIMIT v_limit;
END;
$$;


--
-- Name: get_workspace_intelligence(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_workspace_intelligence(p_org_id uuid) RETURNS TABLE(id uuid, legacy_id text, title text, summary text, what_is_it text, why_matters text, key_data text[], full_brief text, operational_impact text, open_questions text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, reasoning text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, effective_priority text, effective_archived boolean, jurisdiction_iso text[])
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.summary, ii.what_is_it, ii.why_matters,
    ii.key_data, ii.full_brief, ii.operational_impact, ii.open_questions,
    ii.tags, ii.domain, ii.category, ii.item_type, ii.source_id, ii.source_url,
    ii.jurisdictions, ii.transport_modes, ii.verticals, ii.status, ii.severity,
    ii.confidence, ii.priority, ii.reasoning, ii.entry_into_force,
    ii.compliance_deadline, ii.next_review_date, ii.added_date, ii.last_verified,
    ii.is_archived,
    COALESCE(wo.priority_override, ii.priority)::text AS effective_priority,
    COALESCE(wo.is_archived, ii.is_archived)         AS effective_archived,
    ii.jurisdiction_iso
  FROM public.intelligence_items ii
  LEFT JOIN public.workspace_item_overrides wo ON wo.item_id = ii.id AND wo.org_id = p_org_id
  WHERE NOT COALESCE(wo.is_archived, ii.is_archived)
    AND ii.provenance_status = 'verified'
  ORDER BY
    CASE COALESCE(wo.priority_override, ii.priority)
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC;
END;
$$;


--
-- Name: get_workspace_intelligence_aggregates(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_workspace_intelligence_aggregates(p_org_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN (
    WITH scope AS (
      SELECT
        ii.id, ii.status, ii.jurisdictions, ii.updated_at, ii.effective_priority
      FROM public._workspace_active_items(p_org_id) ii
    ),
    by_priority AS (
      SELECT effective_priority AS k, COUNT(*)::int AS v FROM scope GROUP BY effective_priority
    ),
    by_status AS (
      SELECT status AS k, COUNT(*)::int AS v FROM scope GROUP BY status
    ),
    juris_unnest AS (
      SELECT NULLIF(TRIM(j), '') AS jurisdiction
      FROM scope
      LEFT JOIN LATERAL unnest(scope.jurisdictions) AS j ON TRUE
    ),
    by_jurisdiction AS (
      SELECT jurisdiction AS k, COUNT(*)::int AS v
      FROM juris_unnest WHERE jurisdiction IS NOT NULL GROUP BY jurisdiction
    ),
    totals AS (
      SELECT
        (SELECT COUNT(*)::int FROM scope) AS total_items,
        (SELECT COUNT(DISTINCT jurisdiction)::int FROM juris_unnest WHERE jurisdiction IS NOT NULL) AS total_jurisdictions,
        (SELECT MAX(updated_at) FROM scope) AS last_updated_at
    )
    SELECT jsonb_build_object(
      'total_items',         (SELECT total_items FROM totals),
      'by_priority',         COALESCE((SELECT jsonb_object_agg(k, v) FROM by_priority), '{}'::jsonb),
      'by_status',           COALESCE((SELECT jsonb_object_agg(k, v) FROM by_status), '{}'::jsonb),
      'by_jurisdiction',     COALESCE((SELECT jsonb_object_agg(k, v) FROM by_jurisdiction), '{}'::jsonb),
      'total_jurisdictions', (SELECT total_jurisdictions FROM totals),
      'last_updated_at',     (SELECT last_updated_at FROM totals)
    )
  );
END;
$$;


--
-- Name: get_workspace_intelligence_aggregates_scoped(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_workspace_intelligence_aggregates_scoped(p_org_id uuid, p_scope_filter jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN (
    WITH scope AS (
      SELECT
        ii.id, ii.status, ii.jurisdictions, ii.updated_at,
        ii.item_type, ii.domain, ii.effective_priority
      FROM public._workspace_active_items(p_org_id) ii
    ),
    filtered AS (
      SELECT *
      FROM scope
      WHERE
        p_scope_filter IS NULL
        OR (
          (p_scope_filter ? 'item_types' OR p_scope_filter ? 'domains')
          AND (
            (p_scope_filter ? 'item_types'
             AND scope.item_type = ANY(
               SELECT jsonb_array_elements_text(p_scope_filter -> 'item_types')
             ))
            OR
            (p_scope_filter ? 'domains'
             AND scope.domain = ANY(
               SELECT (jsonb_array_elements_text(p_scope_filter -> 'domains'))::int
             ))
          )
        )
        OR (
          NOT (p_scope_filter ? 'item_types')
          AND NOT (p_scope_filter ? 'domains')
        )
    ),
    by_priority AS (
      SELECT effective_priority AS k, COUNT(*)::int AS v FROM filtered GROUP BY effective_priority
    ),
    by_status AS (
      SELECT status AS k, COUNT(*)::int AS v FROM filtered GROUP BY status
    ),
    juris_unnest AS (
      SELECT NULLIF(TRIM(j), '') AS jurisdiction
      FROM filtered
      LEFT JOIN LATERAL unnest(filtered.jurisdictions) AS j ON TRUE
    ),
    by_jurisdiction AS (
      SELECT jurisdiction AS k, COUNT(*)::int AS v
      FROM juris_unnest WHERE jurisdiction IS NOT NULL GROUP BY jurisdiction
    ),
    totals AS (
      SELECT
        (SELECT COUNT(*)::int FROM filtered) AS total_items,
        (SELECT COUNT(DISTINCT jurisdiction)::int FROM juris_unnest WHERE jurisdiction IS NOT NULL) AS total_jurisdictions,
        (SELECT MAX(updated_at) FROM filtered) AS last_updated_at
    )
    SELECT jsonb_build_object(
      'total_items',         (SELECT total_items FROM totals),
      'by_priority',         COALESCE((SELECT jsonb_object_agg(k, v) FROM by_priority), '{}'::jsonb),
      'by_status',           COALESCE((SELECT jsonb_object_agg(k, v) FROM by_status), '{}'::jsonb),
      'by_jurisdiction',     COALESCE((SELECT jsonb_object_agg(k, v) FROM by_jurisdiction), '{}'::jsonb),
      'total_jurisdictions', (SELECT total_jurisdictions FROM totals),
      'last_updated_at',     (SELECT last_updated_at FROM totals)
    )
  );
END;
$$;


--
-- Name: get_workspace_intelligence_dashboard(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_workspace_intelligence_dashboard(p_org_id uuid) RETURNS TABLE(id uuid, legacy_id text, title text, summary text, tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, effective_priority text, effective_archived boolean, jurisdiction_iso text[])
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.summary, ii.tags, ii.domain,
    ii.category, ii.item_type, ii.source_id, ii.source_url,
    ii.jurisdictions, ii.transport_modes, ii.verticals, ii.status,
    ii.severity, ii.confidence, ii.priority, ii.entry_into_force,
    ii.compliance_deadline, ii.next_review_date, ii.added_date,
    ii.last_verified, ii.is_archived,
    ii.effective_priority, ii.effective_archived, ii.jurisdiction_iso
  FROM public._workspace_active_items(p_org_id) ii
  ORDER BY
    CASE ii.effective_priority
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC, ii.id ASC
  LIMIT 50;
END;
$$;


--
-- Name: get_workspace_intelligence_listings(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_workspace_intelligence_listings(p_org_id uuid, p_domain integer DEFAULT NULL::integer) RETURNS TABLE(id uuid, legacy_id text, title text, what_is_it text, why_matters text, key_data text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, effective_priority text, effective_archived boolean, jurisdiction_iso text[], item_grade text, cost_mechanism text, penalty_range text, enforcement_body text, requirement_trajectory jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.what_is_it, ii.why_matters,
    ii.key_data, ii.tags, ii.domain, ii.category, ii.item_type,
    ii.source_id, ii.source_url, ii.jurisdictions, ii.transport_modes,
    ii.verticals, ii.status, ii.severity, ii.confidence, ii.priority,
    ii.entry_into_force, ii.compliance_deadline, ii.next_review_date,
    ii.added_date, ii.last_verified, ii.is_archived,
    ii.effective_priority, ii.effective_archived, ii.jurisdiction_iso,
    ii.item_grade,
    ii.cost_mechanism, ii.penalty_range, ii.enforcement_body, ii.requirement_trajectory
  FROM public._workspace_active_items(p_org_id) ii
  WHERE (p_domain IS NULL OR ii.domain = p_domain)
  ORDER BY
    CASE ii.effective_priority
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC, ii.id ASC;
END;
$$;


--
-- Name: get_workspace_intelligence_listings_public(integer, text, date, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_workspace_intelligence_listings_public(p_domain integer DEFAULT NULL::integer, p_after_priority text DEFAULT NULL::text, p_after_added_date date DEFAULT NULL::date, p_after_id uuid DEFAULT NULL::uuid) RETURNS TABLE(id uuid, legacy_id text, title text, what_is_it text, why_matters text, key_data text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, effective_priority text, effective_archived boolean, jurisdiction_iso text[], item_grade text, cost_mechanism text, penalty_range text, enforcement_body text, requirement_trajectory jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_after_rank int;
BEGIN
  v_after_rank := CASE
    WHEN p_after_priority IS NULL THEN NULL
    ELSE (CASE p_after_priority
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END)
  END;
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.what_is_it, ii.why_matters,
    ii.key_data, ii.tags, ii.domain, ii.category, ii.item_type,
    ii.source_id, ii.source_url, ii.jurisdictions, ii.transport_modes,
    ii.verticals, ii.status, ii.severity, ii.confidence, ii.priority,
    ii.entry_into_force, ii.compliance_deadline, ii.next_review_date,
    ii.added_date, ii.last_verified, ii.is_archived,
    ii.priority::text  AS effective_priority,
    ii.is_archived      AS effective_archived,
    ii.jurisdiction_iso,
    ii.item_grade,
    ii.cost_mechanism, ii.penalty_range, ii.enforcement_body, ii.requirement_trajectory
  FROM public.intelligence_items ii
  WHERE NOT ii.is_archived
    AND ii.provenance_status = 'verified'
    AND (p_domain IS NULL OR ii.domain = p_domain)
    AND (
      p_after_id IS NULL
      OR (
        (CASE ii.priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END) > v_after_rank
        OR ((CASE ii.priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END) = v_after_rank AND ii.added_date < p_after_added_date)
        OR ((CASE ii.priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END) = v_after_rank AND ii.added_date = p_after_added_date AND ii.id > p_after_id)
      )
    )
  ORDER BY
    CASE ii.priority
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC, ii.id ASC;
END;
$$;


--
-- Name: get_workspace_intelligence_slim(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_workspace_intelligence_slim(p_org_id uuid) RETURNS TABLE(id uuid, legacy_id text, title text, summary text, what_is_it text, why_matters text, key_data text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, effective_priority text, effective_archived boolean, jurisdiction_iso text[], item_grade text, cost_mechanism text, penalty_range text, enforcement_body text, requirement_trajectory jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.summary, ii.what_is_it, ii.why_matters,
    ii.key_data, ii.tags, ii.domain, ii.category, ii.item_type,
    ii.source_id, ii.source_url, ii.jurisdictions, ii.transport_modes,
    ii.verticals, ii.status, ii.severity, ii.confidence, ii.priority,
    ii.entry_into_force, ii.compliance_deadline, ii.next_review_date,
    ii.added_date, ii.last_verified, ii.is_archived,
    COALESCE(wo.priority_override, ii.priority)::text AS effective_priority,
    COALESCE(wo.is_archived, ii.is_archived)         AS effective_archived,
    ii.jurisdiction_iso,
    ii.item_grade,
    ii.cost_mechanism, ii.penalty_range, ii.enforcement_body, ii.requirement_trajectory
  FROM public.intelligence_items ii
  LEFT JOIN public.workspace_item_overrides wo ON wo.item_id = ii.id AND wo.org_id = p_org_id
  WHERE NOT COALESCE(wo.is_archived, ii.is_archived)
    AND ii.provenance_status = 'verified'
  ORDER BY
    CASE COALESCE(wo.priority_override, ii.priority)
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC, ii.id ASC;
END;
$$;


--
-- Name: get_workspace_intelligence_slim_public(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_workspace_intelligence_slim_public() RETURNS TABLE(id uuid, legacy_id text, title text, summary text, what_is_it text, why_matters text, key_data text[], tags text[], domain integer, category text, item_type text, source_id uuid, source_url text, jurisdictions text[], transport_modes text[], verticals text[], status text, severity text, confidence text, priority text, entry_into_force date, compliance_deadline date, next_review_date date, added_date date, last_verified timestamp with time zone, is_archived boolean, effective_priority text, effective_archived boolean, jurisdiction_iso text[], item_grade text, cost_mechanism text, penalty_range text, enforcement_body text, requirement_trajectory jsonb)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    ii.id, ii.legacy_id, ii.title, ii.summary, ii.what_is_it, ii.why_matters,
    ii.key_data, ii.tags, ii.domain, ii.category, ii.item_type,
    ii.source_id, ii.source_url, ii.jurisdictions, ii.transport_modes,
    ii.verticals, ii.status, ii.severity, ii.confidence, ii.priority,
    ii.entry_into_force, ii.compliance_deadline, ii.next_review_date,
    ii.added_date, ii.last_verified, ii.is_archived,
    ii.priority::text  AS effective_priority,
    ii.is_archived      AS effective_archived,
    ii.jurisdiction_iso,
    ii.item_grade,
    ii.cost_mechanism, ii.penalty_range, ii.enforcement_body, ii.requirement_trajectory
  FROM public.intelligence_items ii
  WHERE NOT ii.is_archived
    AND ii.provenance_status = 'verified'
  ORDER BY
    CASE ii.priority
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5 END,
    ii.added_date DESC, ii.id ASC;
END;
$$;


--
-- Name: get_workspace_recent_changes(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_workspace_recent_changes(p_org_id uuid, p_days integer DEFAULT 7) RETURNS TABLE(id uuid, legacy_id text, title text, priority text, effective_priority text, added_date date, change_kind text, change_date date)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  PERFORM public._assert_org_membership(p_org_id);
  RETURN QUERY
  WITH active AS (
    SELECT ii.id, ii.legacy_id, ii.title, ii.priority, ii.effective_priority, ii.added_date
    FROM public._workspace_active_items(p_org_id) ii
  ),
  new_items AS (
    SELECT
      a.id, a.legacy_id, a.title, a.priority, a.effective_priority, a.added_date,
      'new'::text AS change_kind,
      a.added_date AS change_date
    FROM active a
    WHERE a.added_date >= (current_date - GREATEST(p_days, 1))
  ),
  updated_items AS (
    -- An item already selected as 'new' above is never also read as 'updated' (the stronger fact
    -- wins, per this migration's own header): excluded here by id, not re-decided downstream.
    SELECT
      a.id, a.legacy_id, a.title, a.priority, a.effective_priority, a.added_date,
      'updated'::text AS change_kind,
      MAX(c.change_date) AS change_date
    FROM active a
    JOIN public.item_changelog c ON c.item_id = a.id
    WHERE c.change_type = 'UPDATED'
      AND c.change_date >= (current_date - GREATEST(p_days, 1))
      AND a.id NOT IN (SELECT n.id FROM new_items n)
    GROUP BY a.id, a.legacy_id, a.title, a.priority, a.effective_priority, a.added_date
  ),
  unioned AS (
    SELECT * FROM new_items
    UNION ALL
    SELECT * FROM updated_items
  )
  SELECT u.id, u.legacy_id, u.title, u.priority, u.effective_priority, u.added_date, u.change_kind, u.change_date
  FROM unioned u
  ORDER BY
    CASE u.effective_priority
      WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MODERATE' THEN 3 WHEN 'LOW' THEN 4 ELSE 5
    END,
    u.change_date DESC,
    u.id ASC
  LIMIT 500;
END;
$$;


--
-- Name: guard_data_audit_block(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_data_audit_block() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_override text := current_setting('app.data_audit_override', true);
  v_block    record;
  v_act      jsonb;
  v_waived   boolean;
BEGIN
  IF v_override IS NOT NULL AND v_override <> '' THEN
    RAISE WARNING 'layer-c-insert-gate: insert into intelligence_items admitted under app.data_audit_override=%; this is a deliberate-act exemption and must correspond to a recorded disposition.', v_override;
    RETURN NEW;
  END IF;
  FOR v_block IN
    SELECT id, description, recommended_actions
    FROM public.integrity_flags
    WHERE category = 'data_integrity'
      AND subject_ref = 'data-audit-lane'
      AND status = 'open'
  LOOP
    v_waived := false;
    IF jsonb_typeof(v_block.recommended_actions) = 'array' THEN
      FOR v_act IN SELECT jsonb_array_elements(v_block.recommended_actions)
      LOOP
        IF jsonb_typeof(v_act) = 'object'
           AND v_act ->> 'action' = 'waiver'
           AND v_act ->> 'until' IS NOT NULL THEN
          BEGIN
            IF ((v_act ->> 'until')::date::timestamp AT TIME ZONE 'UTC') >= now() THEN
              v_waived := true;
              EXIT;
            END IF;
          EXCEPTION WHEN others THEN
            NULL;
          END;
        END IF;
      END LOOP;
    END IF;
    IF NOT v_waived THEN
      RAISE EXCEPTION
        'layer-c-insert-gate: intelligence_items insert blocked - the data-audit lane is RED with no current dated waiver (integrity_flags %). Corpus red is cleared only by a deliberate act, never by time: fix the lane to green (the block row resolves) or record a dated waiver disposition in docs/data-audit-dispositions.md and on the flag (recommended_actions += {"action":"waiver","until":"YYYY-MM-DD"}). %',
        v_block.id, coalesce(left(v_block.description, 160), '')
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION guard_data_audit_block(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.guard_data_audit_block() IS 'Layer C insert gate (migration 240). BEFORE INSERT on intelligence_items: rejects the insert while an open data-audit block (integrity_flags category=data_integrity, subject_ref=data-audit-lane, status=open) lacks a valid dated waiver ({action:"waiver",until>=today-UTC} in recommended_actions). Exact SQL mirror of audit-gate-core.mjs hasValidWaiver - keep in sync. Closes the fleet-bypass gap (500+ inserts that never passed preflightStep''s app-layer check). Deliberate-act exemption: transaction-local GUC app.data_audit_override (set_config(...,true)), logged via RAISE WARNING; precedent app.pause_flag_writer (mig 201). Proof: scripts/verify/layer-c-insert-gate-proof.mjs.';


--
-- Name: guard_judgement_drain_writer(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_judgement_drain_writer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE marker text := current_setting('app.judgement_drain_writer', true);
BEGIN
  IF NEW.judgement_drain IS DISTINCT FROM OLD.judgement_drain THEN
    IF marker IS NULL OR marker = '' THEN
      RAISE EXCEPTION
        'judgement-drain-has-one-writer: system_state.judgement_drain is written ONLY through admin_set_judgement_drain. A direct write carries no writer marker and is rejected; current_user=%.',
        current_user USING ERRCODE = 'insufficient_privilege';
    END IF;
    INSERT INTO public.system_state_flag_audit(changed_by, column_name, old_value, new_value)
      VALUES (marker, 'judgement_drain', OLD.judgement_drain::text, NEW.judgement_drain::text);
  END IF;
  RETURN NEW;
END; $$;


--
-- Name: FUNCTION guard_judgement_drain_writer(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.guard_judgement_drain_writer() IS 'judgement-drain-has-one-writer guard (lane G6-DRAIN, migration 354). BEFORE UPDATE on system_state: rejects a change to judgement_drain that carries no app.judgement_drain_writer marker (only admin_set_judgement_drain sets it) and logs authorized changes to system_state_flag_audit.';


--
-- Name: guard_pause_flag_writer(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_pause_flag_writer() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE marker text := current_setting('app.pause_flag_writer', true);
BEGIN
  IF NEW.global_processing_paused IS DISTINCT FROM OLD.global_processing_paused
     OR NEW.scrape_cadence IS DISTINCT FROM OLD.scrape_cadence THEN
    IF marker IS NULL OR marker = '' THEN
      RAISE EXCEPTION
        'pause-flag-has-one-writer: system_state stop flags (global_processing_paused / scrape_cadence) are written ONLY through admin_set_pause_state (the sanctioned route path). A direct write carries no writer marker and is rejected; current_user=%.',
        current_user USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.global_processing_paused IS DISTINCT FROM OLD.global_processing_paused THEN
      INSERT INTO public.system_state_flag_audit(changed_by, column_name, old_value, new_value)
        VALUES (marker, 'global_processing_paused', OLD.global_processing_paused::text, NEW.global_processing_paused::text);
    END IF;
    IF NEW.scrape_cadence IS DISTINCT FROM OLD.scrape_cadence THEN
      INSERT INTO public.system_state_flag_audit(changed_by, column_name, old_value, new_value)
        VALUES (marker, 'scrape_cadence', OLD.scrape_cadence::text, NEW.scrape_cadence::text);
    END IF;
  END IF;
  RETURN NEW;
END; $$;


--
-- Name: guard_provenance_flip(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_provenance_flip() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  -- Escalation INTO 'verified' only. (Re-checked here so the function stays safe even if the
  -- trigger is ever recreated without its WHEN clause.)
  IF NEW.provenance_status = 'verified'
     AND NEW.provenance_status IS DISTINCT FROM OLD.provenance_status THEN
    -- depth semantics: a trigger fired by a top-level statement runs at pg_trigger_depth()=1;
    -- >=2 means the UPDATE was issued from inside another trigger — in this schema, only
    -- set_provenance_status (the validation derivation) issues such writes.
    IF current_user <> 'reconciler' AND pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION
        '#43 provenance binding: item % cannot be set to ''verified'' by a direct write from role %; ''verified'' is stamped only by the set_provenance_status derivation (validation) or the bound reconciler credential.',
        NEW.id, current_user
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION guard_provenance_flip(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.guard_provenance_flip() IS '#43 credential binding, rebuilt by migration 250. BEFORE UPDATE on intelligence_items: any transition INTO provenance_status=''verified'' is rejected unless current_user=reconciler (the bound credential) or the write was issued from inside another trigger (pg_trigger_depth()>=2 in the guard = the set_provenance_status validation derivation, the only trigger function that writes this column). Replaces mig 118''s session-GUC origin stamp, which any role could forge via set_config, and closes the previously-unguarded quarantined->verified escalation. Restrictive transitions (->quarantined, ->pending_human_verify, downgrades) are deliberately open. Not owner-proof: postgres can disable this trigger; that residual is bound by operator-side credential scoping.';


--
-- Name: heartbeat_funded_pass_lock(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.heartbeat_funded_pass_lock(p_key text, p_pid integer) RETURNS TABLE(still_held boolean)
    LANGUAGE plpgsql
    AS $$
begin
  update public.funded_pass_runlock set heartbeat_at = now() where lock_key = p_key and holder_pid = p_pid;
  return query select found;
end; $$;


--
-- Name: heartbeat_mutation_lease(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.heartbeat_mutation_lease(p_item uuid, p_holder text) RETURNS TABLE(still_held boolean)
    LANGUAGE plpgsql
    AS $$
begin
  update public.mutation_leases set heartbeat_at = now()
   where intelligence_item_id = p_item and holder = p_holder;
  return query select found;
end;
$$;


--
-- Name: intelligence_items_theme_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.intelligence_items_theme_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF NEW.theme IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.theme IS NOT DISTINCT FROM OLD.theme THEN
    RETURN NEW;
  END IF;
  IF NEW.theme IN (
    'emissions_accounting', 'fuels_saf', 'packaging_circular', 'carbon_markets',
    'cold_chain_art', 'last_mile_electrification', 'disclosure_regimes'
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.vocabulary_terms t
     WHERE t.kind = 'theme'
       AND t.status = 'adopted'
       AND regexp_replace(btrim(t.term_key), '\s+', '_', 'g') = NEW.theme
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'intelligence_items.theme "%" is neither one of the 7 code themes nor an adopted theme term', NEW.theme
    USING ERRCODE = 'check_violation', CONSTRAINT = 'intelligence_items_theme_check';
END;
$$;


--
-- Name: FUNCTION intelligence_items_theme_guard(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.intelligence_items_theme_guard() IS 'Migration 357 (lane G5-READ): replaces the intelligence_items_theme_check CHECK of migration 102. Accepts NULL, the 7 code themes, and any adopted theme term of vocabulary_terms (migration 355) by its stored token (term_key with whitespace runs as underscores). An unchanged theme is never refused. The 7-value list here is pinned to metadata-vocab.ts DB_THEME_VALUE_LIST by scripts/verify/vocab-sync-audit.mjs.';


--
-- Name: invalidate_dependents(text, text, bigint, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invalidate_dependents(p_table text, p_pk text, p_event bigint DEFAULT NULL::bigint, p_apply boolean DEFAULT true) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
  n integer;
  n_dv integer;
  n_ir integer;
BEGIN
  IF p_apply THEN
    WITH RECURSIVE affected(node_table, node_id) AS (
      SELECT e.to_table, e.to_value_id::text
      FROM public.derivation_edges e
      WHERE e.from_table = p_table AND e.from_pk = p_pk
      UNION
      SELECT e2.to_table, e2.to_value_id::text
      FROM public.derivation_edges e2
      JOIN affected a ON e2.from_table = a.node_table AND e2.from_pk = a.node_id
    )
    UPDATE public.derived_values d
       SET admissibility = 'stale', invalidated_at = now(), invalidated_by_event = p_event
      FROM affected a
     WHERE a.node_table = 'derived_values' AND d.value_id = a.node_id::uuid AND d.admissibility <> 'stale';
    GET DIAGNOSTICS n_dv = ROW_COUNT;

    WITH RECURSIVE affected(node_table, node_id) AS (
      SELECT e.to_table, e.to_value_id::text
      FROM public.derivation_edges e
      WHERE e.from_table = p_table AND e.from_pk = p_pk
      UNION
      SELECT e2.to_table, e2.to_value_id::text
      FROM public.derivation_edges e2
      JOIN affected a ON e2.from_table = a.node_table AND e2.from_pk = a.node_id
    )
    UPDATE public.inference_records ir
       SET admissibility = 'stale', invalidated_at = now(), invalidated_by_event = p_event
      FROM affected a
     WHERE a.node_table = 'inference_records' AND ir.inference_id = a.node_id::uuid AND ir.admissibility <> 'stale';
    GET DIAGNOSTICS n_ir = ROW_COUNT;

    n := coalesce(n_dv, 0) + coalesce(n_ir, 0);
  ELSE
    WITH RECURSIVE affected(node_table, node_id) AS (
      SELECT e.to_table, e.to_value_id::text
      FROM public.derivation_edges e
      WHERE e.from_table = p_table AND e.from_pk = p_pk
      UNION
      SELECT e2.to_table, e2.to_value_id::text
      FROM public.derivation_edges e2
      JOIN affected a ON e2.from_table = a.node_table AND e2.from_pk = a.node_id
    )
    SELECT
      (SELECT count(*) FROM affected a JOIN public.derived_values d ON a.node_table = 'derived_values' AND d.value_id = a.node_id::uuid WHERE d.admissibility <> 'stale')
      + (SELECT count(*) FROM affected a JOIN public.inference_records ir ON a.node_table = 'inference_records' AND ir.inference_id = a.node_id::uuid WHERE ir.admissibility <> 'stale')
    INTO n;
  END IF;
  RETURN coalesce(n, 0);
END $$;


--
-- Name: FUNCTION invalidate_dependents(p_table text, p_pk text, p_event bigint, p_apply boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.invalidate_dependents(p_table text, p_pk text, p_event bigint, p_apply boolean) IS 'Migration 339: polymorphic rewrite of migration 285''s derived_values-only invalidation walk; marks whichever of derived_values / inference_records each closure member belongs to.';


--
-- Name: is_platform_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_platform_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT coalesce((SELECT p.is_platform_admin FROM public.profiles p WHERE p.id = auth.uid()), false)
$$;


--
-- Name: FUNCTION is_platform_admin(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_platform_admin() IS 'SEC-6 (migration 375). True when the caller (auth.uid()) has a profiles row with is_platform_admin = true, false when the flag is false, the row is missing or there is no caller. SECURITY DEFINER so it reads the column its owner can read after SELECT (is_platform_admin) was revoked from authenticated; no parameter, so it cannot ask about anyone else. Used by the 22 admin RLS policies and by the own-row readers in the app (platform-admin gate, identity bootstrap, Community shell, signoff decide).';


--
-- Name: is_sanctioned_writer(regclass); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_sanctioned_writer(p_rel regclass) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT current_user IN ('service_role', 'postgres', 'supabase_admin')
      OR current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = p_rel);
$$;


--
-- Name: FUNCTION is_sanctioned_writer(p_rel regclass); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_sanctioned_writer(p_rel regclass) IS 'SEC-3b (migration 370). True when current_user is service_role, postgres, supabase_admin or the owner of the given table. Keys on current_user, never on a JWT claim. SECURITY INVOKER on purpose so current_user is the real caller; a SECURITY DEFINER function runs as its owner and is therefore sanctioned. Used by the six guard triggers of migration 370.';


--
-- Name: item_assignments_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_assignments_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF auth.role() = 'service_role' OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.assignee_user_id IS DISTINCT FROM OLD.assignee_user_id
     OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
     OR NEW.due_on IS DISTINCT FROM OLD.due_on
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'item_assignments: only state may change' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: item_corrections_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_corrections_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'item_corrections is append-only: a correction is revoked, never deleted'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'item_corrections is append-only: correction % is already revoked', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'item_corrections is append-only: an UPDATE may only set revoked_at, revoked_by, revoked_reason'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'revoked_at' - 'revoked_by' - 'revoked_reason')
     IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at' - 'revoked_by' - 'revoked_reason') THEN
    RAISE EXCEPTION 'item_corrections is append-only: only revoked_at, revoked_by, revoked_reason may change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: item_corrections_apply_claims(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_corrections_apply_claims() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_patch jsonb;
BEGIN
  IF NEW.intelligence_item_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.item_corrections c
     WHERE c.item_id = NEW.intelligence_item_id AND c.revoked_at IS NULL AND c.target_kind = 'fact'
  ) THEN
    RETURN NEW;
  END IF;
  v_patch := public.item_corrections_patch(NEW.intelligence_item_id, 'section_claim_provenance', jsonb_build_object(
    'id', NEW.id,
    'claim_text', NEW.claim_text,
    'source_span', NEW.source_span,
    'source_id', NEW.source_id,
    'search_result_id', NEW.search_result_id));
  IF v_patch <> '{}'::jsonb THEN
    NEW := jsonb_populate_record(NEW, v_patch);
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: item_corrections_apply_items(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_corrections_apply_items() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_patch jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.item_corrections c
     WHERE c.item_id = NEW.id AND c.revoked_at IS NULL AND c.target_kind IN ('tag', 'full_brief')
  ) THEN
    RETURN NEW;
  END IF;
  v_patch := public.item_corrections_patch(NEW.id, 'intelligence_items', jsonb_build_object(
    'topic_tags', to_jsonb(NEW.topic_tags),
    'operational_scenario_tags', to_jsonb(NEW.operational_scenario_tags),
    'compliance_object_tags', to_jsonb(NEW.compliance_object_tags),
    'full_brief', to_jsonb(NEW.full_brief)));
  IF v_patch <> '{}'::jsonb THEN
    NEW := jsonb_populate_record(NEW, v_patch);
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: item_corrections_apply_sections(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_corrections_apply_sections() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_patch jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.item_corrections c
     WHERE c.item_id = NEW.item_id AND c.revoked_at IS NULL AND c.target_kind = 'section_text'
  ) THEN
    RETURN NEW;
  END IF;
  v_patch := public.item_corrections_patch(NEW.item_id, 'intelligence_item_sections', jsonb_build_object(
    'section_key', NEW.section_key,
    'content_md', NEW.content_md));
  IF v_patch <> '{}'::jsonb THEN
    NEW := jsonb_populate_record(NEW, v_patch);
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: item_corrections_before_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_corrections_before_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
  v_col    text;
  v_tag    text;
  v_mv     jsonb;
  v_target uuid;
  v_claim  record;
  v_sr     uuid;
  v_span   text;
BEGIN
  IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL OR NEW.revoked_reason IS NOT NULL THEN
    RAISE EXCEPTION 'correction_insert_must_be_active: a correction is inserted active and revoked later';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.intelligence_items i WHERE i.id = NEW.item_id) THEN
    RAISE EXCEPTION 'correction_item_not_found: item % does not exist', NEW.item_id;
  END IF;

  IF NEW.target_kind = 'tag' THEN
    v_col := split_part(NEW.target_ref, ':', 1);
    v_tag := substr(NEW.target_ref, length(v_col) + 2);
    IF v_col NOT IN ('topic_tags', 'operational_scenario_tags', 'compliance_object_tags') OR btrim(v_tag) = '' THEN
      RAISE EXCEPTION 'correction_tag_ref_invalid: target_ref must be <topic_tags|operational_scenario_tags|compliance_object_tags>:<tag>, got %', NEW.target_ref;
    END IF;
    EXECUTE format('SELECT to_jsonb(%I) FROM public.intelligence_items WHERE id = $1', v_col)
      INTO v_mv USING NEW.item_id;

  ELSIF NEW.target_kind = 'full_brief' THEN
    IF NEW.target_ref <> 'full_brief' THEN
      RAISE EXCEPTION 'correction_full_brief_ref_invalid: target_ref must be full_brief';
    END IF;
    IF NEW.value IS NULL OR btrim(COALESCE(NEW.value ->> 'text', '')) = '' THEN
      RAISE EXCEPTION 'correction_value_invalid: a full_brief replace needs value {"text": "<non-empty brief>"}';
    END IF;
    SELECT to_jsonb(i.full_brief) INTO v_mv FROM public.intelligence_items i WHERE i.id = NEW.item_id;

  ELSIF NEW.target_kind = 'section_text' THEN
    IF NEW.value IS NULL OR btrim(COALESCE(NEW.value ->> 'content_md', '')) = '' THEN
      RAISE EXCEPTION 'correction_value_invalid: a section_text replace needs value {"content_md": "<non-empty text>"}';
    END IF;
    SELECT to_jsonb(s.content_md) INTO v_mv
      FROM public.intelligence_item_sections s
     WHERE s.item_id = NEW.item_id AND s.section_key = NEW.target_ref;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'correction_section_not_found: item % has no section %', NEW.item_id, NEW.target_ref;
    END IF;

  ELSIF NEW.target_kind = 'fact' THEN
    BEGIN
      v_target := NEW.target_ref::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'correction_fact_ref_invalid: target_ref must be a section_claim_provenance id, got %', NEW.target_ref;
    END;
    SELECT scp.claim_text, scp.claim_kind, scp.source_span, scp.source_id, scp.search_result_id
      INTO v_claim
      FROM public.section_claim_provenance scp
     WHERE scp.id = v_target AND scp.intelligence_item_id = NEW.item_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'correction_claim_not_found: item % has no claim %', NEW.item_id, NEW.target_ref;
    END IF;
    v_mv := jsonb_build_object(
      'claim_text', v_claim.claim_text,
      'claim_kind', v_claim.claim_kind,
      'source_span', v_claim.source_span,
      'source_id', v_claim.source_id,
      'search_result_id', v_claim.search_result_id);
    IF NEW.op = 'replace' THEN
      IF v_claim.claim_kind <> 'FACT' THEN
        RAISE EXCEPTION 'correction_fact_not_a_fact_claim: claim % is %, only a FACT claim takes a replace', NEW.target_ref, v_claim.claim_kind;
      END IF;
      IF NEW.value IS NULL OR btrim(COALESCE(NEW.value ->> 'source_span', '')) = '' OR (NEW.value ->> 'search_result_id') IS NULL THEN
        RAISE EXCEPTION 'correction_fact_needs_span: a fact replace needs value {"source_span", "search_result_id"} (ADR-016)';
      END IF;
      IF NEW.value -> 'claim_text' IS NOT NULL AND btrim(COALESCE(NEW.value ->> 'claim_text', '')) = '' THEN
        RAISE EXCEPTION 'correction_value_invalid: claim_text, when given, must be non-empty';
      END IF;
      BEGIN
        v_sr := (NEW.value ->> 'search_result_id')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'correction_fact_needs_span: search_result_id must be a uuid';
      END;
      v_span := NEW.value ->> 'source_span';
      IF NOT public.item_corrections_span_is_verbatim(NEW.item_id, v_sr, v_span) THEN
        RAISE EXCEPTION 'correction_fact_span_not_verbatim: the span is not verbatim in a held capture of item % (ADR-016, validate_item_provenance criterion 3)', NEW.item_id;
      END IF;
      IF NEW.value -> 'source_id' IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.sources s WHERE s.id::text = (NEW.value ->> 'source_id')) THEN
        RAISE EXCEPTION 'correction_value_invalid: source_id % is not a registered source', NEW.value ->> 'source_id';
      END IF;
    END IF;

  ELSIF NEW.target_kind = 'connection' THEN
    BEGIN
      v_target := NEW.target_ref::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'correction_connection_ref_invalid: target_ref must be the other item id, got %', NEW.target_ref;
    END;
    IF v_target = NEW.item_id THEN
      RAISE EXCEPTION 'correction_connection_ref_invalid: an item cannot connect to itself';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.intelligence_items i WHERE i.id = v_target) THEN
      RAISE EXCEPTION 'correction_item_not_found: connection target % does not exist', v_target;
    END IF;
    IF NEW.op = 'add' AND NEW.value -> 'relationship' IS NOT NULL
       AND (NEW.value ->> 'relationship') NOT IN ('related', 'supersedes', 'implements', 'conflicts', 'amends', 'depends_on') THEN
      RAISE EXCEPTION 'correction_value_invalid: relationship % is not in the edge vocabulary', NEW.value ->> 'relationship';
    END IF;
    SELECT COALESCE(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_mv
      FROM public.item_cross_references x
     WHERE (x.source_item_id = NEW.item_id AND x.target_item_id = v_target)
        OR (x.source_item_id = v_target AND x.target_item_id = NEW.item_id);
  END IF;

  NEW.machine_value := v_mv;
  RETURN NEW;
END;
$_$;


--
-- Name: item_corrections_block_tombstoned_edge(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_corrections_block_tombstoned_edge() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  -- a manual edge is an admin act and is never blocked; every other origin is skipped when the pair is tombstoned
  IF NEW.origin IS DISTINCT FROM 'manual'
     AND public.item_corrections_pair_tombstoned(NEW.source_item_id, NEW.target_item_id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: item_corrections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_corrections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    target_kind text NOT NULL,
    target_ref text NOT NULL,
    op text NOT NULL,
    value jsonb,
    machine_value jsonb,
    reason text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    revoked_by uuid,
    revoked_reason text,
    CONSTRAINT item_corrections_kind_op_chk CHECK ((((target_kind = 'fact'::text) AND (op = ANY (ARRAY['suppress'::text, 'replace'::text]))) OR ((target_kind = 'tag'::text) AND (op = ANY (ARRAY['add'::text, 'remove'::text]))) OR ((target_kind = 'connection'::text) AND (op = ANY (ARRAY['add'::text, 'remove'::text]))) OR ((target_kind = 'section_text'::text) AND (op = 'replace'::text)) OR ((target_kind = 'full_brief'::text) AND (op = 'replace'::text)))),
    CONSTRAINT item_corrections_op_check CHECK ((op = ANY (ARRAY['suppress'::text, 'add'::text, 'remove'::text, 'replace'::text]))),
    CONSTRAINT item_corrections_reason_check CHECK ((btrim(reason) <> ''::text)),
    CONSTRAINT item_corrections_revoked_together_chk CHECK (((revoked_at IS NULL) = (revoked_by IS NULL))),
    CONSTRAINT item_corrections_target_kind_check CHECK ((target_kind = ANY (ARRAY['fact'::text, 'tag'::text, 'connection'::text, 'section_text'::text, 'full_brief'::text]))),
    CONSTRAINT item_corrections_target_ref_check CHECK ((btrim(target_ref) <> ''::text))
);


--
-- Name: TABLE item_corrections; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.item_corrections IS 'Migration 356. Append-only admin corrections to item data (fact, tag, connection, section_text, full_brief) applied over the machine value and preserved through re-runs by triggers. Active = revoked_at IS NULL; latest active per (item_id, target_kind, target_ref) wins. item_id is a soft reference (no FK) so the trail survives an item delete, same posture as claim_versions (migration 208).';


--
-- Name: item_corrections_latest(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_corrections_latest(p_item_id uuid, p_kind text) RETURNS SETOF public.item_corrections
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT DISTINCT ON (c.target_ref) c.*
    FROM public.item_corrections c
   WHERE c.item_id = p_item_id
     AND c.target_kind = p_kind
     AND c.revoked_at IS NULL
   ORDER BY c.target_ref, c.created_at DESC, c.id DESC;
$$;


--
-- Name: item_corrections_note(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_corrections_note(p_correction_id uuid, p_machine_value jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  INSERT INTO public.item_correction_evidence AS e (correction_id, latest_machine_value)
  VALUES (p_correction_id, p_machine_value)
  ON CONFLICT (correction_id) DO UPDATE
     SET latest_machine_value = EXCLUDED.latest_machine_value,
         observed_at = now(),
         observed_count = e.observed_count + 1;
END;
$$;


--
-- Name: item_corrections_pair_tombstoned(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_corrections_pair_tombstoned(p_a uuid, p_b uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_op text;
BEGIN
  SELECT c.op INTO v_op
    FROM public.item_corrections c
   WHERE c.target_kind = 'connection'
     AND c.revoked_at IS NULL
     AND ((c.item_id = p_a AND c.target_ref = p_b::text) OR (c.item_id = p_b AND c.target_ref = p_a::text))
   ORDER BY c.created_at DESC, c.id DESC
   LIMIT 1;
  RETURN COALESCE(v_op = 'remove', false);
END;
$$;


--
-- Name: item_corrections_patch(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_corrections_patch(p_item_id uuid, p_table text, p_row jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_patch    jsonb := '{}'::jsonb;
  c          record;
  v_col      text;
  v_tag      text;
  v_cur      text[];
  v_new      text[];
  v_cols     text[] := ARRAY['topic_tags', 'operational_scenario_tags', 'compliance_object_tags'];
  v_enforced text;
BEGIN
  IF p_table = 'intelligence_items' THEN
    -- tags: remove strips the tag, add makes sure it is present.
    FOREACH v_col IN ARRAY v_cols LOOP
      IF p_row -> v_col IS NULL THEN CONTINUE; END IF;
      v_cur := ARRAY(
        SELECT jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(p_row -> v_col) = 'array' THEN p_row -> v_col ELSE '[]'::jsonb END));
      v_new := v_cur;
      FOR c IN
        SELECT * FROM public.item_corrections_latest(p_item_id, 'tag')
         WHERE split_part(target_ref, ':', 1) = v_col
         ORDER BY created_at, id
      LOOP
        v_tag := substr(c.target_ref, length(v_col) + 2);
        IF c.op = 'remove' THEN
          IF v_tag = ANY (v_cur) THEN
            PERFORM public.item_corrections_note(c.id, to_jsonb(v_cur));
          END IF;
          v_new := array_remove(v_new, v_tag);
        ELSIF c.op = 'add' THEN
          IF NOT (v_tag = ANY (v_cur)) THEN
            PERFORM public.item_corrections_note(c.id, to_jsonb(v_cur));
          END IF;
          IF NOT (v_tag = ANY (v_new)) THEN
            v_new := v_new || v_tag;
          END IF;
        END IF;
      END LOOP;
      IF v_new IS DISTINCT FROM v_cur THEN
        v_patch := v_patch || jsonb_build_object(v_col, to_jsonb(v_new));
      END IF;
    END LOOP;

    -- full_brief: replace enforces the corrected text.
    IF p_row -> 'full_brief' IS NOT NULL THEN
      SELECT * INTO c FROM public.item_corrections_latest(p_item_id, 'full_brief') LIMIT 1;
      IF FOUND AND c.op = 'replace' THEN
        v_enforced := c.value ->> 'text';
        IF v_enforced IS NOT NULL AND (p_row ->> 'full_brief') IS DISTINCT FROM v_enforced THEN
          PERFORM public.item_corrections_note(c.id, p_row -> 'full_brief');
          v_patch := v_patch || jsonb_build_object('full_brief', v_enforced);
        END IF;
      END IF;
    END IF;

  ELSIF p_table = 'intelligence_item_sections' THEN
    SELECT * INTO c FROM public.item_corrections_latest(p_item_id, 'section_text')
     WHERE target_ref = (p_row ->> 'section_key') LIMIT 1;
    IF FOUND AND c.op = 'replace' THEN
      v_enforced := c.value ->> 'content_md';
      IF v_enforced IS NOT NULL AND (p_row ->> 'content_md') IS DISTINCT FROM v_enforced THEN
        PERFORM public.item_corrections_note(c.id, p_row -> 'content_md');
        v_patch := v_patch || jsonb_build_object('content_md', v_enforced);
      END IF;
    END IF;

  ELSIF p_table = 'section_claim_provenance' THEN
    -- a claim matches by id OR by the original machine claim_text, so a regeneration that re-inserts the same
    -- claim under a new id is still corrected. Oldest first, so the latest matching correction wins.
    FOR c IN
      SELECT * FROM public.item_corrections_latest(p_item_id, 'fact')
       WHERE op = 'replace'
         AND (target_ref = (p_row ->> 'id')
              OR (machine_value ->> 'claim_text') = (p_row ->> 'claim_text'))
       ORDER BY created_at, id
    LOOP
      IF (c.value ->> 'source_span') IS DISTINCT FROM (p_row ->> 'source_span')
         OR (c.value ->> 'search_result_id') IS DISTINCT FROM (p_row ->> 'search_result_id')
         OR (c.value -> 'claim_text' IS NOT NULL AND (c.value ->> 'claim_text') IS DISTINCT FROM (p_row ->> 'claim_text'))
         OR (c.value -> 'source_id' IS NOT NULL AND (c.value ->> 'source_id') IS DISTINCT FROM (p_row ->> 'source_id'))
      THEN
        PERFORM public.item_corrections_note(c.id, p_row);
      END IF;
      v_patch := v_patch || jsonb_build_object(
        'source_span', c.value ->> 'source_span',
        'search_result_id', c.value ->> 'search_result_id');
      IF c.value -> 'claim_text' IS NOT NULL THEN
        v_patch := v_patch || jsonb_build_object('claim_text', c.value ->> 'claim_text');
      END IF;
      IF c.value -> 'source_id' IS NOT NULL THEN
        v_patch := v_patch || jsonb_build_object('source_id', c.value ->> 'source_id');
      END IF;
    END LOOP;
  END IF;

  RETURN v_patch;
END;
$$;


--
-- Name: item_corrections_span_is_verbatim(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_corrections_span_is_verbatim(p_item_id uuid, p_search_result_id uuid, p_span text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT p_span IS NOT NULL
     AND btrim(p_span) <> ''
     AND EXISTS (
       SELECT 1
         FROM public.agent_run_searches ars
        WHERE ars.id = p_search_result_id
          AND ars.intelligence_item_id = p_item_id
          AND ars.result_content IS NOT NULL
          AND position(lower(btrim(p_span)) IN lower(ars.result_content)) > 0
     );
$$;


--
-- Name: item_notes_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.item_notes_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_admin boolean;
BEGIN
  IF auth.role() = 'service_role' OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.legacy_override_id IS DISTINCT FROM OLD.legacy_override_id THEN
    RAISE EXCEPTION 'item_notes: only body, edited_at and deleted_at may change' USING ERRCODE = '42501';
  END IF;

  IF OLD.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'item_notes: a deleted note cannot be changed' USING ERRCODE = '42501';
  END IF;

  IF NEW.body IS DISTINCT FROM OLD.body THEN
    IF OLD.author_user_id IS NULL OR OLD.author_user_id <> auth.uid() THEN
      RAISE EXCEPTION 'item_notes: only the author can edit a note' USING ERRCODE = '42501';
    END IF;
    NEW.edited_at := now();
  END IF;

  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    SELECT EXISTS (
      SELECT 1 FROM public.org_memberships m
      WHERE m.org_id = OLD.org_id AND m.user_id = auth.uid() AND m.role IN ('owner', 'admin')
    ) INTO v_admin;
    IF NOT v_admin AND (OLD.author_user_id IS NULL OR OLD.author_user_id <> auth.uid()) THEN
      RAISE EXCEPTION 'item_notes: only the author or an owner or admin can delete a note' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END
$$;


--
-- Name: lookup_invitation(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lookup_invitation(p_token text) RETURNS TABLE(id uuid, org_id uuid, org_name text, invited_email text, proposed_role text, status text, created_at timestamp with time zone, expires_at timestamp with time zone, is_expired boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  SELECT
    inv.id,
    inv.org_id,
    o.name AS org_name,
    inv.invited_email,
    inv.proposed_role,
    -- Lazy-compute expired without writing a row update so this fn stays VOLATILE-free.
    CASE WHEN inv.status = 'pending' AND inv.expires_at <= now() THEN 'expired' ELSE inv.status END AS status,
    inv.created_at,
    inv.expires_at,
    (inv.expires_at <= now()) AS is_expired
  FROM public.org_invitations inv
  JOIN public.organizations o ON o.id = inv.org_id
  WHERE inv.token = p_token;
$$;


--
-- Name: FUNCTION lookup_invitation(p_token text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.lookup_invitation(p_token text) IS 'Read an invitation by token without RLS. Returns org_name + status + is_expired. Stays read-only (does not lazy-write expired status); the accept/decline functions handle that.';


--
-- Name: move_override_notes_to_item_notes(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.move_override_notes_to_item_notes() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_inserted integer;
BEGIN
  INSERT INTO public.item_notes (org_id, item_id, author_user_id, body, created_at, legacy_override_id)
  SELECT o.org_id, o.item_id, NULL, btrim(o.notes), COALESCE(o.updated_at, o.created_at), o.id
  FROM public.workspace_item_overrides o
  WHERE btrim(o.notes) <> ''
    AND char_length(btrim(o.notes)) <= 20000
  ON CONFLICT (legacy_override_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END
$$;


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text,
    display_name text,
    role text DEFAULT 'viewer'::text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    full_name text,
    headline text,
    bio text,
    avatar_url text,
    organization text,
    job_title text,
    linkedin_url text,
    linkedin_sub text,
    linkedin_verified boolean DEFAULT false,
    linkedin_identity_verified boolean DEFAULT false,
    linkedin_workplace_verified boolean DEFAULT false,
    linkedin_verification_checked_at timestamp with time zone,
    verification_tier text DEFAULT 'unverified'::text,
    affiliation_type text,
    region text[] DEFAULT '{}'::text[] NOT NULL,
    topic_interests text[],
    membership_tier text DEFAULT 'free'::text,
    contribution_score integer DEFAULT 0,
    notification_preferences jsonb DEFAULT '{}'::jsonb,
    last_active_at timestamp with time zone,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    sector_overrides text[] DEFAULT '{}'::text[] NOT NULL,
    jurisdiction_overrides text[] DEFAULT '{}'::text[] NOT NULL,
    transport_mode_overrides text[] DEFAULT '{}'::text[] NOT NULL,
    verifier_status text DEFAULT 'none'::text NOT NULL,
    verifier_since timestamp with time zone,
    is_platform_admin boolean DEFAULT false NOT NULL,
    org_id uuid,
    workspace_role text,
    sector text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT profiles_verifier_status_check CHECK ((verifier_status = ANY (ARRAY['none'::text, 'pending'::text, 'active'::text, 'revoked'::text]))),
    CONSTRAINT profiles_workspace_role_check CHECK (((workspace_role IS NULL) OR (workspace_role = ANY (ARRAY['owner'::text, 'admin'::text, 'editor'::text, 'member'::text, 'viewer'::text]))))
);


--
-- Name: COLUMN profiles.region; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.region IS 'Multi-region workspace profile (Q6, 2026-05-24). text[] because operators serve multiple regions (e.g. NYC + LA + London). Pre-existing scalar text column was converted to text[] in-place, preserving prior values as single-element arrays.';


--
-- Name: COLUMN profiles.timezone; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.timezone IS 'IANA tz string. Migrated from user_profiles.timezone in 075.';


--
-- Name: COLUMN profiles.sector_overrides; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.sector_overrides IS 'Per-user sector override array. Composes with workspace_settings.sector_profile (the workspace-level default) to produce per-render relevance ranking per Section 6.8 of the v2 audit. Empty = use workspace defaults. Migrated from user_profiles.sectors in 075.';


--
-- Name: COLUMN profiles.jurisdiction_overrides; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.jurisdiction_overrides IS 'Per-user jurisdiction override array. Composes with workspace_settings.jurisdiction_weights for ranking. Empty = use workspace defaults. Migrated from user_profiles.jurisdictions in 075.';


--
-- Name: COLUMN profiles.transport_mode_overrides; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.transport_mode_overrides IS 'Per-user transport-mode override array. No org-level equivalent currently exists; reserved for future. Migrated from user_profiles.transport_modes in 075.';


--
-- Name: COLUMN profiles.verifier_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.verifier_status IS 'Editorial-board verifier credential lifecycle: none -> pending -> active -> revoked. Migrated from user_profiles.verifier_status in 075.';


--
-- Name: COLUMN profiles.verifier_since; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.verifier_since IS 'Timestamp at which verifier_status entered the active state. Migrated from user_profiles.verifier_since in 075.';


--
-- Name: COLUMN profiles.is_platform_admin; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.is_platform_admin IS 'Caro''s Ledge internal staff flag. Service-role-only writeable per migration 027/075 RLS posture (users cannot self-promote). Grants access to platform-wide admin surfaces: /admin route, integrity flags triage, source registry hygiene, supersession board, the jurisdiction triage queue (added in Sprint 1 Phase 7), the fetchAwaitingReview widget, and community direct-promote. Does NOT grant access to other orgs'' workspace data; cross-org access still requires an org_memberships row in the target org. The Phase 7 requirePlatformAdmin() helper reads this column; the legacy isPlatformAdmin() name in src/lib/auth/admin.ts is misleading (it reads org_memberships.role; being split per docs/sprint-1/phase-1-admin-signals.md Option C).';


--
-- Name: COLUMN profiles.org_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.org_id IS 'Current/primary org for this user (Q6, 2026-05-24). Nullable. org_memberships stays authoritative for multi-org membership; org switcher writes the active selection here.';


--
-- Name: COLUMN profiles.workspace_role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.workspace_role IS 'Denormalized current role for the active org (Q6, 2026-05-24). Mirrors org_memberships.role for the row matching profiles.org_id. NULL when no active org.';


--
-- Name: COLUMN profiles.sector; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.sector IS 'Multi-sector workspace profile (Q6, 2026-05-24). text[] because operators serve multiple verticals. Populated from workspace_settings + user onboarding. Surfaces consume via the projection on every masthead and Community author identity.';


--
-- Name: my_profile(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.my_profile() RETURNS SETOF public.profiles
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT p.* FROM public.profiles p WHERE p.id = auth.uid()
$$;


--
-- Name: FUNCTION my_profile(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.my_profile() IS 'SEC-5 (migration 372). The caller''s own full profiles row (auth.uid()), email and is_platform_admin included: the only own-row path to email now that email is outside the authenticated column grant. SECURITY DEFINER, search_path pinned, EXECUTE to authenticated and service_role only. No parameter, so it cannot name another user.';


--
-- Name: next_uncensused_portal_candidates(uuid, integer, boolean, timestamp with time zone, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_uncensused_portal_candidates(p_source_id uuid, p_limit integer, p_newest boolean DEFAULT false, p_after_first_seen timestamp with time zone DEFAULT NULL::timestamp with time zone, p_after_id uuid DEFAULT NULL::uuid) RETURNS TABLE(id uuid, url text, anchor_text text, source_id uuid, first_seen_at timestamp with time zone, source_name text, source_category text, source_base_tier integer)
    LANGUAGE sql STABLE
    AS $$
  select plc.id, plc.url, plc.anchor_text, plc.source_id, plc.first_seen_at,
         s.name, s.category, s.base_tier
  from public.portal_link_candidates plc
  left join public.sources s on s.id = plc.source_id
  where plc.status = 'candidate'
    and (p_source_id is null or plc.source_id = p_source_id)
    and not exists (
      select 1 from public.census_worklist cw
      where cw.source_id = plc.source_id
        and cw.document_url = plc.url
        and cw.dryrun_disposition is not null
    )
    and (
      p_after_first_seen is null
      or case
           when p_newest then (plc.first_seen_at < p_after_first_seen
                               or (plc.first_seen_at = p_after_first_seen and plc.id < p_after_id))
           else (plc.first_seen_at > p_after_first_seen
                 or (plc.first_seen_at = p_after_first_seen and plc.id > p_after_id))
         end
    )
  order by
    case when p_newest then plc.first_seen_at end desc,
    case when not p_newest then plc.first_seen_at end asc,
    case when p_newest then plc.id end desc,
    case when not p_newest then plc.id end asc
  limit greatest(p_limit, 0);
$$;


--
-- Name: FUNCTION next_uncensused_portal_candidates(p_source_id uuid, p_limit integer, p_newest boolean, p_after_first_seen timestamp with time zone, p_after_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.next_uncensused_portal_candidates(p_source_id uuid, p_limit integer, p_newest boolean, p_after_first_seen timestamp with time zone, p_after_id uuid) IS 'Plan-mode census walk: next N portal_link_candidates for a source NOT yet dispositioned in census_worklist, keyset-paginated (first_seen_at,id). Server-side NOT EXISTS replaces the client NOT IN list that overflowed at ~435 dispositioned rows.';


--
-- Name: obligation_objects_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.obligation_objects_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_capture_item uuid;
  v_capture_text text;
  v_item_entity  text;
  v_item_title   text;
  v_prev         record;
BEGIN
  -- The capture must be a held capture of THIS instrument item, and the span must be verbatim in it.
  SELECT ars.intelligence_item_id, ars.result_content
    INTO v_capture_item, v_capture_text
    FROM public.agent_run_searches ars
   WHERE ars.id = NEW.capture_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'obligation_object_capture_missing: capture_id % is not an agent_run_searches row', NEW.capture_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_capture_item IS DISTINCT FROM NEW.instrument_item_id THEN
    RAISE EXCEPTION 'obligation_object_capture_not_of_instrument: capture % belongs to another item than instrument_item_id %', NEW.capture_id, NEW.instrument_item_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_capture_text IS NULL
     OR btrim(NEW.verbatim_text) = ''
     OR position(lower(btrim(NEW.verbatim_text)) IN lower(v_capture_text)) = 0 THEN
    RAISE EXCEPTION 'obligation_object_span_not_verbatim: verbatim_text is not verbatim in capture % (ADR-016, validate_item_provenance criterion 3)', NEW.capture_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- The instrument's entity (migration 283), read here so the outbox trigger can name it (migration 352).
  SELECT i.instrument_entity_id, i.title INTO v_item_entity, v_item_title
    FROM public.intelligence_items i WHERE i.id = NEW.instrument_item_id;
  IF NEW.instrument_entity_id IS NULL THEN
    NEW.instrument_entity_id := v_item_entity;
  END IF;

  -- Versioning: a superseding row is a later version of an object of the same instrument.
  IF NEW.supersedes IS NOT NULL THEN
    SELECT o.version, o.instrument_item_id INTO v_prev FROM public.obligation_objects o WHERE o.obligation_id = NEW.supersedes;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'obligation_object_supersedes_missing: % does not exist', NEW.supersedes USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_prev.instrument_item_id IS DISTINCT FROM NEW.instrument_item_id THEN
      RAISE EXCEPTION 'obligation_object_supersedes_other_instrument: % belongs to another instrument item', NEW.supersedes USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.version <= v_prev.version THEN
      RAISE EXCEPTION 'obligation_object_version_not_increasing: version % must exceed superseded version %', NEW.version, v_prev.version USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Register the object as an entity of kind obligation (the id is the entity id; the FK is satisfied after this
    -- BEFORE trigger). Idempotent: a re-registered id keeps its original row.
    INSERT INTO public.entities (entity_id, kind, canonical_name)
    VALUES (NEW.obligation_id, 'obligation',
            left(coalesce(v_item_title, 'instrument') || ' ' || NEW.pinpoint_citation || ' v' || NEW.version::text, 500))
    ON CONFLICT (entity_id) DO NOTHING;
  ELSE
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END $$;


--
-- Name: FUNCTION obligation_objects_guard(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.obligation_objects_guard() IS 'BEFORE INSERT OR UPDATE guard on obligation_objects: capture belongs to the instrument item, verbatim_text is verbatim in it (ADR-016), fills instrument_entity_id, checks supersession, registers the obligation entity on insert.';


--
-- Name: org_membership_role_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.org_membership_role_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_actor      uuid := auth.uid();
  v_org        uuid;
  v_actor_role text;
  v_other_owners integer;
BEGIN
  IF public.is_sanctioned_writer('public.org_memberships'::regclass) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'org_membership_role_guard: no signed-in user; current_user=%', current_user
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_org := OLD.org_id;
  ELSE
    v_org := NEW.org_id;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'org_membership_role_guard: org_id and user_id of a membership never change; remove and add the member instead'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT m.role INTO v_actor_role
    FROM public.org_memberships m
   WHERE m.org_id = v_org AND m.user_id = v_actor;

  IF TG_OP = 'INSERT' THEN
    IF NEW.role = 'owner' THEN
      IF v_actor_role IS DISTINCT FROM 'owner' THEN
        RAISE EXCEPTION 'org_membership_role_guard: only an owner may grant the owner role'
          USING ERRCODE = '42501';
      END IF;
    ELSIF v_actor_role IS NULL OR v_actor_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'org_membership_role_guard: only an owner or admin may add a member'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      IF OLD.user_id = v_actor THEN
        RAISE EXCEPTION 'org_membership_role_guard: nobody changes their own role'
          USING ERRCODE = '42501';
      END IF;
      IF OLD.role = 'owner' OR NEW.role = 'owner' THEN
        IF v_actor_role IS DISTINCT FROM 'owner' THEN
          RAISE EXCEPTION 'org_membership_role_guard: only an owner may grant or revoke the owner role'
            USING ERRCODE = '42501';
        END IF;
      ELSIF v_actor_role IS NULL OR v_actor_role NOT IN ('owner', 'admin') THEN
        RAISE EXCEPTION 'org_membership_role_guard: only an owner or admin may change a member role'
          USING ERRCODE = '42501';
      END IF;
      IF OLD.role = 'owner' AND NEW.role <> 'owner' THEN
        SELECT count(*) INTO v_other_owners
          FROM public.org_memberships m
         WHERE m.org_id = OLD.org_id AND m.role = 'owner' AND m.id <> OLD.id;
        IF v_other_owners = 0 THEN
          RAISE EXCEPTION 'org_membership_role_guard: the last owner of an organization cannot be demoted'
            USING ERRCODE = '42501';
        END IF;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.role = 'owner' THEN
    IF v_actor_role IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'org_membership_role_guard: only an owner may remove an owner'
        USING ERRCODE = '42501';
    END IF;
    SELECT count(*) INTO v_other_owners
      FROM public.org_memberships m
     WHERE m.org_id = OLD.org_id AND m.role = 'owner' AND m.id <> OLD.id;
    IF v_other_owners = 0 THEN
      RAISE EXCEPTION 'org_membership_role_guard: the last owner of an organization cannot be removed'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_actor_role IS NULL OR v_actor_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'org_membership_role_guard: only an owner or admin may remove a member'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;


--
-- Name: FUNCTION org_membership_role_guard(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.org_membership_role_guard() IS 'SEC-3b (migration 370). BEFORE INSERT OR UPDATE OR DELETE guard on public.org_memberships for callers other than service_role, postgres, supabase_admin or the table owner: only an owner grants or revokes owner, an admin may set member, viewer or admin, nobody changes their own role, the last owner cannot be demoted or removed, org_id and user_id never change. The policies membership_write_admin, membership_update_admin and membership_delete_admin stay and decide which rows an admin reaches. SECURITY INVOKER; a SECURITY DEFINER function (accept_invitation, create_org_for_self) runs as its owner and is sanctioned.';


--
-- Name: org_memberships_ban_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.org_memberships_ban_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.org_member_bans b
    WHERE b.org_id = NEW.org_id
      AND b.user_id = NEW.user_id
  ) THEN
    RAISE EXCEPTION 'This account is banned from the workspace (org-scoped ban; lift the ban before re-adding)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION org_memberships_ban_guard(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.org_memberships_ban_guard() IS 'DB-layer half of the org-scoped ban re-join block (migration 191, Wave-α Track D d2). Raises 42501 on any org_memberships INSERT (or user_id/org_id UPDATE) matching an org_member_bans row. SECURITY DEFINER so the ban lookup is not blinded by the owner/admin-scoped SELECT policy on org_member_bans. App-layer checks (accept_invitation guard from mig 156; members-route PUT check) remain as friendlier-error front doors; this trigger is the backstop no caller can skip.';


--
-- Name: organizations_plan_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.organizations_plan_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF public.is_sanctioned_writer('public.organizations'::regclass) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.plan IS DISTINCT FROM OLD.plan THEN
      RAISE EXCEPTION 'organizations_plan_guard: organizations.plan is writable only by service_role or the table owner; current_user=%', current_user
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.plan IS DISTINCT FROM 'free' THEN
    RAISE EXCEPTION 'organizations_plan_guard: a new organizations row starts on the free plan; only service_role or the table owner may set another; current_user=%', current_user
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION organizations_plan_guard(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.organizations_plan_guard() IS 'SEC-3b (migration 370). BEFORE INSERT OR UPDATE guard on public.organizations: raises 42501 when a caller other than service_role, postgres, supabase_admin or the table owner changes plan (or inserts a row on a plan other than free). Layer 2 behind the column grants.';


--
-- Name: portfolio_members_cap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portfolio_members_cap() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF (SELECT count(*) FROM public.portfolio_members m WHERE m.portfolio_id = NEW.portfolio_id) >= 500 THEN
    RAISE EXCEPTION 'portfolio_member_cap_reached: a portfolio holds at most 500 members' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: portfolios_org_cap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.portfolios_org_cap() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF (SELECT count(*) FROM public.portfolios p WHERE p.org_id = NEW.org_id) >= 100 THEN
    RAISE EXCEPTION 'portfolio_cap_reached: a workspace holds at most 100 portfolios' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: profiles_privilege_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.profiles_privilege_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_owner name;
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;
  SELECT pg_get_userbyid(c.relowner) INTO v_owner FROM pg_class c WHERE c.oid = 'public.profiles'::regclass;
  IF current_user = v_owner THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.is_platform_admin   IS DISTINCT FROM OLD.is_platform_admin
       OR NEW.role               IS DISTINCT FROM OLD.role
       OR NEW.org_id             IS DISTINCT FROM OLD.org_id
       OR NEW.workspace_role     IS DISTINCT FROM OLD.workspace_role
       OR NEW.verifier_status    IS DISTINCT FROM OLD.verifier_status
       OR NEW.verification_tier  IS DISTINCT FROM OLD.verification_tier
       OR NEW.membership_tier    IS DISTINCT FROM OLD.membership_tier
       OR NEW.contribution_score IS DISTINCT FROM OLD.contribution_score
       OR NEW.verifier_since     IS DISTINCT FROM OLD.verifier_since
       OR NEW.linkedin_verified  IS DISTINCT FROM OLD.linkedin_verified
       OR NEW.linkedin_identity_verified  IS DISTINCT FROM OLD.linkedin_identity_verified
       OR NEW.linkedin_workplace_verified IS DISTINCT FROM OLD.linkedin_workplace_verified
       OR NEW.linkedin_verification_checked_at IS DISTINCT FROM OLD.linkedin_verification_checked_at THEN
      RAISE EXCEPTION
        'profiles_privilege_guard: is_platform_admin, role, org_id, workspace_role, verifier_status, verification_tier, membership_tier, contribution_score, verifier_since, the linkedin_* verification flags and linkedin_verification_checked_at on public.profiles are writable only by service_role, the table owner or a SECURITY DEFINER function it owns; current_user=%', current_user
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NEW.is_platform_admin IS TRUE
       OR NEW.org_id IS NOT NULL
       OR NEW.workspace_role IS NOT NULL
       OR NEW.role IS DISTINCT FROM 'viewer'
       OR NEW.verifier_status    IS DISTINCT FROM 'none'
       OR NEW.verification_tier  IS DISTINCT FROM 'unverified'
       OR NEW.membership_tier    IS DISTINCT FROM 'free'
       OR NEW.contribution_score IS DISTINCT FROM 0
       OR NEW.verifier_since IS NOT NULL
       OR NEW.linkedin_verified IS TRUE
       OR NEW.linkedin_identity_verified IS TRUE
       OR NEW.linkedin_workplace_verified IS TRUE
       OR NEW.linkedin_verification_checked_at IS NOT NULL THEN
      RAISE EXCEPTION
        'profiles_privilege_guard: a new public.profiles row may not set is_platform_admin, role, org_id, workspace_role, verifier_status, verification_tier, membership_tier, contribution_score, verifier_since, the linkedin_* verification flags or linkedin_verification_checked_at; only service_role or the table owner may; current_user=%', current_user
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION profiles_privilege_guard(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.profiles_privilege_guard() IS 'SEC-1 (migration 364), extended by SEC-2 (migration 367). BEFORE INSERT OR UPDATE guard on public.profiles: raises 42501 when a caller other than service_role, postgres, supabase_admin or the table owner changes is_platform_admin, role, org_id, workspace_role, verifier_status, verification_tier, membership_tier, contribution_score, verifier_since, linkedin_verified, linkedin_identity_verified, linkedin_workplace_verified or linkedin_verification_checked_at (or inserts a row carrying a non-default value of one). SECURITY INVOKER so current_user is the real caller; keys on current_user, not on a JWT claim. Layer 2 behind the column-level grants.';


--
-- Name: publish_aggregate(text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.publish_aggregate(p_table text, p_column text, p_cohort_filter jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  pol             public.sensitive_field_policy%ROWTYPE;
  members         jsonb;
  sorted_members  text[];
  n               integer;
  q_id            uuid := gen_random_uuid();
  requester       text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', 'unknown');
  this_hash       text;
  overlap_hit     boolean;
  reason          text;
  frozen_row      record;
  parent_sorted   text[];
  prior_sorted    text[];
  prior_row       record;
  complement_hit  boolean := false;
  period_end_txt  text;
  period_end_date date;
  total_value     numeric;
  max_value       numeric;
  max_share       numeric;
  agg_value       numeric;
  width_mult      numeric;
  bucketed_value  numeric;
  v_granted_payload jsonb;
BEGIN
  SELECT * INTO pol FROM public.sensitive_field_policy WHERE table_name = p_table AND column_name = p_column;
  IF NOT FOUND THEN
    reason := format('field %s.%s is not registered in sensitive_field_policy — refusing by default (spec 08 §5.1)', p_table, p_column);
    INSERT INTO public.aggregate_query_log (query_id, table_name, column_name, cohort_hash, cohort_members, cohort_size, requested_by, refused, reason)
      VALUES (q_id, p_table, p_column, 'n/a', '[]'::jsonb, 0, requester, true, reason);
    RETURN jsonb_build_object('refused', true, 'reason', reason, 'table', p_table, 'column', p_column);
  END IF;
  members := coalesce(p_cohort_filter -> 'member_ids', '[]'::jsonb);
  SELECT array_agg(DISTINCT val ORDER BY val) INTO sorted_members FROM jsonb_array_elements_text(members) AS val;
  n := coalesce(array_length(sorted_members, 1), 0);
  this_hash := md5(array_to_string(coalesce(sorted_members, '{}'::text[]), '|'));
  SELECT query_id, granted_payload INTO frozen_row
    FROM public.aggregate_query_log
    WHERE refused = false AND table_name = p_table AND column_name = p_column AND cohort_hash = this_hash
      AND requested_at > now() - make_interval(days => pol.min_lag_days)
    ORDER BY requested_at ASC
    LIMIT 1;
  IF FOUND THEN
    reason := format('frozen: identical cohort granted at request %s, within the %s-day freeze window (spec 08 §5.2c)', frozen_row.query_id, pol.min_lag_days);
    INSERT INTO public.aggregate_query_log (query_id, table_name, column_name, cohort_hash, cohort_members, cohort_size, requested_by, refused, reason, frozen, frozen_from, granted_payload)
      VALUES (q_id, p_table, p_column, this_hash, to_jsonb(coalesce(sorted_members, '{}'::text[])), n, requester, false, reason, true, frozen_row.query_id, frozen_row.granted_payload);
    RETURN frozen_row.granted_payload || jsonb_build_object('frozen', true, 'source_query_id', frozen_row.query_id);
  END IF;
  IF n < pol.k_min THEN
    reason := format('refused: %s contributing organisation(s), minimum %s (spec 08 §5.1)', n, pol.k_min);
    INSERT INTO public.aggregate_query_log (query_id, table_name, column_name, cohort_hash, cohort_members, cohort_size, requested_by, refused, reason)
      VALUES (q_id, p_table, p_column, this_hash, to_jsonb(coalesce(sorted_members, '{}'::text[])), n, requester, true, reason);
    RETURN jsonb_build_object('refused', true, 'reason', reason, 'table', p_table, 'column', p_column, 'cohort_size', n, 'k_min', pol.k_min);
  END IF;
  period_end_txt := coalesce(p_cohort_filter ->> 'period_end', p_cohort_filter ->> 'period_start');
  IF NOT pol.forward_looking_allowed AND period_end_txt IS NOT NULL THEN
    period_end_date := NULL;
    BEGIN
      period_end_date := period_end_txt::date;
    EXCEPTION WHEN others THEN
      period_end_date := NULL;
    END;
    IF period_end_date IS NOT NULL AND period_end_date > current_date THEN
      reason := format('refused: request names a future period (%s), forward_looking_allowed=false for %s.%s (spec 08 §5.1)', period_end_date, p_table, p_column);
      INSERT INTO public.aggregate_query_log (query_id, table_name, column_name, cohort_hash, cohort_members, cohort_size, requested_by, refused, reason)
        VALUES (q_id, p_table, p_column, this_hash, to_jsonb(coalesce(sorted_members, '{}'::text[])), n, requester, true, reason);
      RETURN jsonb_build_object('refused', true, 'reason', reason, 'table', p_table, 'column', p_column, 'cohort_size', n, 'k_min', pol.k_min);
    END IF;
  END IF;
  IF p_cohort_filter ? 'member_values' THEN
    SELECT sum(val::numeric), max(val::numeric) INTO total_value, max_value FROM jsonb_each_text(p_cohort_filter -> 'member_values') AS t(key, val);
    IF total_value IS NOT NULL AND total_value > 0 THEN
      max_share := (max_value / total_value) * 100;
      IF max_share > pol.max_share_pct THEN
        reason := format('refused: a single contributor holds %s%% of the aggregate, maximum %s%% (spec 08 §5.1 dominance cap)', round(max_share, 1), pol.max_share_pct);
        INSERT INTO public.aggregate_query_log (query_id, table_name, column_name, cohort_hash, cohort_members, cohort_size, requested_by, refused, reason)
          VALUES (q_id, p_table, p_column, this_hash, to_jsonb(coalesce(sorted_members, '{}'::text[])), n, requester, true, reason);
        RETURN jsonb_build_object('refused', true, 'reason', reason, 'table', p_table, 'column', p_column, 'cohort_size', n, 'k_min', pol.k_min, 'max_share_observed', round(max_share, 1));
      END IF;
    END IF;
  END IF;
  IF p_cohort_filter ? 'parent_member_ids' THEN
    SELECT array_agg(DISTINCT val ORDER BY val) INTO parent_sorted FROM jsonb_array_elements_text(p_cohort_filter -> 'parent_member_ids') AS val;
    IF parent_sorted IS NOT NULL AND coalesce(sorted_members, '{}'::text[]) <@ parent_sorted THEN
      FOR prior_row IN
        SELECT cohort_members FROM public.aggregate_query_log WHERE refused = false AND table_name = p_table AND column_name = p_column
      LOOP
        SELECT array_agg(val ORDER BY val) INTO prior_sorted FROM jsonb_array_elements_text(prior_row.cohort_members) AS val;
        IF prior_sorted IS NOT NULL
           AND prior_sorted <@ parent_sorted
           AND NOT (coalesce(sorted_members, '{}'::text[]) && prior_sorted)
           AND coalesce(array_length(sorted_members, 1), 0) + coalesce(array_length(prior_sorted, 1), 0) = array_length(parent_sorted, 1)
        THEN
          complement_hit := true;
          EXIT;
        END IF;
      END LOOP;
    END IF;
  END IF;
  IF complement_hit THEN
    reason := format('refused: cohort is the exact complement, within the supplied parent set, of a previously granted cohort for %s.%s — publishing both would reveal the suppressed cell by subtraction (spec 08 §5.2b)', p_table, p_column);
    INSERT INTO public.aggregate_query_log (query_id, table_name, column_name, cohort_hash, cohort_members, cohort_size, requested_by, refused, reason)
      VALUES (q_id, p_table, p_column, this_hash, to_jsonb(coalesce(sorted_members, '{}'::text[])), n, requester, true, reason);
    RETURN jsonb_build_object('refused', true, 'reason', reason, 'table', p_table, 'column', p_column, 'cohort_size', n, 'k_min', pol.k_min);
  END IF;
  SELECT EXISTS (
    SELECT 1
    FROM public.aggregate_query_log l
    WHERE l.refused = false
      AND l.table_name = p_table AND l.column_name = p_column
      AND l.requested_by = requester
      AND l.requested_at > now() - make_interval(days => pol.min_lag_days)
      AND l.cohort_hash <> this_hash
      AND (
        SELECT count(*) FROM (
          SELECT m FROM unnest(coalesce(sorted_members, '{}'::text[])) AS m
          EXCEPT SELECT jsonb_array_elements_text(l.cohort_members)
          UNION ALL
          SELECT jsonb_array_elements_text(l.cohort_members)
          EXCEPT SELECT m FROM unnest(coalesce(sorted_members, '{}'::text[])) AS m
        ) sym_diff
      ) < pol.k_min
  ) INTO overlap_hit;
  IF overlap_hit THEN
    reason := format('refused: cohort differs from a recent request by fewer than %s member(s) — query-set-size / tracker attack guard (spec 08 §5.2a)', pol.k_min);
    INSERT INTO public.aggregate_query_log (query_id, table_name, column_name, cohort_hash, cohort_members, cohort_size, requested_by, refused, reason)
      VALUES (q_id, p_table, p_column, this_hash, to_jsonb(coalesce(sorted_members, '{}'::text[])), n, requester, true, reason);
    RETURN jsonb_build_object('refused', true, 'reason', reason, 'table', p_table, 'column', p_column, 'cohort_size', n, 'k_min', pol.k_min);
  END IF;
  agg_value := NULL;
  IF p_cohort_filter ? 'member_values' THEN
    SELECT sum(val::numeric) INTO agg_value FROM jsonb_each_text(p_cohort_filter -> 'member_values') AS t(key, val);
  END IF;
  width_mult := public.bucket_width_multiplier(n, pol.k_min);
  bucketed_value := public.bucket_value(agg_value, pol.bucket_scheme, width_mult);
  v_granted_payload := jsonb_build_object(
    'refused', false, 'table', p_table, 'column', p_column, 'cohort_size', n, 'k_min', pol.k_min,
    'bucket_scheme', pol.bucket_scheme, 'bucket_width_multiplier', width_mult, 'value', bucketed_value,
    'note', CASE
              WHEN agg_value IS NULL THEN 'gate passed; no live subject field wired yet — see migration 287 header'
              WHEN bucketed_value IS NULL THEN 'gate passed but bucket_scheme is unresolvable — value withheld, never published raw'
              ELSE 'gate passed; value is the bucketed (never raw) aggregate'
            END
  );
  INSERT INTO public.aggregate_query_log (query_id, table_name, column_name, cohort_hash, cohort_members, cohort_size, requested_by, refused, reason, granted_payload)
    VALUES (q_id, p_table, p_column, this_hash, to_jsonb(coalesce(sorted_members, '{}'::text[])), n, requester, false, 'granted', v_granted_payload);
  RETURN v_granted_payload;
END $$;


--
-- Name: FUNCTION publish_aggregate(p_table text, p_column text, p_cohort_filter jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.publish_aggregate(p_table text, p_column text, p_cohort_filter jsonb) IS 'Spec 08 §5: the ONE way a sensitive aggregate leaves the database. Check order: freeze (§5.2c) → k_min → forward-looking → dominance → complement (§5.2b) → tracker-attack overlap (§5.2a) → grant with bucketed value (§5.2d). Never raises for a policy refusal (a raise would roll back its own log row); always logs, then returns {refused, reason, ...}.';


--
-- Name: recompute_agent_integrity_flag(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recompute_agent_integrity_flag() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_phrase TEXT;
BEGIN
  IF NEW.full_brief IS NULL THEN
    NEW.agent_integrity_flag := FALSE;
    NEW.agent_integrity_phrase := NULL;
    RETURN NEW;
  END IF;

  v_phrase := NULL;

  IF NEW.full_brief ~* 'replace the source URL' THEN
    v_phrase := 'replace the source URL';
  ELSIF NEW.full_brief ~* 'do not act on (any |the )?prior brief' THEN
    v_phrase := 'do not act on prior brief';
  ELSIF NEW.full_brief ~* 'specific article, regulatory text, or guidance document' THEN
    v_phrase := 'specific article, regulatory text, or guidance document';
  ELSIF NEW.full_brief ~* 'unable to verify' THEN
    v_phrase := 'unable to verify';
  ELSIF NEW.full_brief ~* 'could not confirm' THEN
    v_phrase := 'could not confirm';
  END IF;

  IF v_phrase IS NOT NULL AND NOT NEW.agent_integrity_flag THEN
    NEW.agent_integrity_flag := TRUE;
    NEW.agent_integrity_phrase := v_phrase;
    NEW.agent_integrity_flagged_at := NOW();
  ELSIF v_phrase IS NULL THEN
    NEW.agent_integrity_flag := FALSE;
    NEW.agent_integrity_phrase := NULL;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION recompute_agent_integrity_flag(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.recompute_agent_integrity_flag() IS 'W2.C agent-integrity-flag trigger, retuned 2026-05-06 after triage of 57 false-positive-heavy flags. Phrase set narrowed from 8 to 5 to drop over-broad patterns.';


--
-- Name: recompute_source_accuracy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.recompute_source_accuracy() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  IF NEW.confirmation_count + NEW.conflict_count > 0 THEN
    NEW.accuracy_rate = NEW.confirmation_count::NUMERIC
      / (NEW.confirmation_count + NEW.conflict_count)::NUMERIC;
  ELSE
    NEW.accuracy_rate = 0.5000;
  END IF;

  IF NEW.total_checks > 0 THEN
    NEW.accessibility_rate = NEW.successful_checks::NUMERIC
      / NEW.total_checks::NUMERIC;
  ELSE
    NEW.accessibility_rate = 1.0000;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: region_dimension_coverage_sync_fact_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.region_dimension_coverage_sync_fact_count() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  affected_region_id UUID;
  affected_dimension TEXT;
BEGIN
  -- Determine which (region, dimension) cell changed.
  IF TG_OP = 'DELETE' THEN
    affected_region_id := OLD.region_id;
    affected_dimension := OLD.dimension;
  ELSE
    affected_region_id := NEW.region_id;
    affected_dimension := NEW.dimension;
  END IF;

  -- Re-count and upsert coverage row.
  INSERT INTO region_dimension_coverage (region_id, dimension, fact_count, updated_at)
  VALUES (
    affected_region_id,
    affected_dimension,
    (SELECT COUNT(*)::INT
       FROM regional_data_facts
      WHERE region_id = affected_region_id
        AND dimension = affected_dimension),
    NOW()
  )
  ON CONFLICT (region_id, dimension) DO UPDATE
    SET fact_count = EXCLUDED.fact_count,
        updated_at = NOW();

  -- Flip state to 'populated' on the first fact landing in a previously
  -- empty cell. Don't override 'partial' or 'pending' set by operator.
  UPDATE region_dimension_coverage
     SET state = 'populated'
   WHERE region_id = affected_region_id
     AND dimension = affected_dimension
     AND state = 'missing'
     AND fact_count > 0;

  -- Flip state back to 'missing' if the cell empties (last fact deleted).
  UPDATE region_dimension_coverage
     SET state = 'missing'
   WHERE region_id = affected_region_id
     AND dimension = affected_dimension
     AND fact_count = 0
     AND state = 'populated';

  RETURN NULL;
END;
$$;


--
-- Name: register_derived_value(text, text, text, numeric, numeric, numeric, text, text, text, text, text, text, numeric, timestamp with time zone, integer, jsonb, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_derived_value(p_entity_id text, p_method_id text, p_method_version text, p_value numeric, p_value_low numeric, p_value_high numeric, p_unit text, p_currency text, p_derivation text, p_origin_class text, p_lifecycle text, p_admissibility text, p_base_confidence numeric, p_asserted_at timestamp with time zone, p_half_life_days integer, p_inputs jsonb, p_computed_by text, p_supersedes uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_value_id uuid;
  v_ref jsonb;
BEGIN
  INSERT INTO public.derived_values (
    entity_id, method_id, method_version, value, value_low, value_high, unit, currency,
    derivation, origin_class, lifecycle, admissibility, base_confidence, asserted_at,
    half_life_days, inputs, computed_by, supersedes
  ) VALUES (
    p_entity_id, p_method_id, p_method_version, p_value, p_value_low, p_value_high, p_unit, p_currency,
    p_derivation, p_origin_class, p_lifecycle, p_admissibility, p_base_confidence, p_asserted_at,
    p_half_life_days, coalesce(p_inputs, '[]'::jsonb), p_computed_by, p_supersedes
  ) RETURNING value_id INTO v_value_id;
  FOR v_ref IN SELECT * FROM jsonb_array_elements(coalesce(p_inputs, '[]'::jsonb))
  LOOP
    INSERT INTO public.derivation_edges (from_table, from_pk, to_value_id, edge_kind)
    VALUES (v_ref->>'table', v_ref->>'pk', v_value_id, 'input');
  END LOOP;
  RETURN v_value_id;
END $$;


--
-- Name: FUNCTION register_derived_value(p_entity_id text, p_method_id text, p_method_version text, p_value numeric, p_value_low numeric, p_value_high numeric, p_unit text, p_currency text, p_derivation text, p_origin_class text, p_lifecycle text, p_admissibility text, p_base_confidence numeric, p_asserted_at timestamp with time zone, p_half_life_days integer, p_inputs jsonb, p_computed_by text, p_supersedes uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.register_derived_value(p_entity_id text, p_method_id text, p_method_version text, p_value numeric, p_value_low numeric, p_value_high numeric, p_unit text, p_currency text, p_derivation text, p_origin_class text, p_lifecycle text, p_admissibility text, p_base_confidence numeric, p_asserted_at timestamp with time zone, p_half_life_days integer, p_inputs jsonb, p_computed_by text, p_supersedes uuid) IS 'The ONE write path for a new derived_values row + its derivation_edges, atomically. register-derivation.ts''s registerDerivedValue(sb, {...}) calls this via sb.rpc(), never a bare INSERT.';


--
-- Name: register_inference_record(text, text, text, numeric, uuid[], text, text, text, text, text, jsonb, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_inference_record(p_subject_id text, p_claim_text text, p_status_token text, p_confidence numeric, p_cited_item_ids uuid[], p_origin_class text, p_method_id text, p_method_version text, p_computed_by text, p_trigger_question_ref text DEFAULT NULL::text, p_inputs jsonb DEFAULT '[]'::jsonb, p_supersedes uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_inference_id uuid;
  v_ref jsonb;
BEGIN
  INSERT INTO public.inference_records (
    subject_id, claim_text, status_token, confidence, cited_item_ids, origin_class,
    method_id, method_version, computed_by, trigger_question_ref, supersedes
  ) VALUES (
    p_subject_id, p_claim_text, p_status_token, p_confidence, p_cited_item_ids, p_origin_class,
    p_method_id, p_method_version, p_computed_by, p_trigger_question_ref, p_supersedes
  ) RETURNING inference_id INTO v_inference_id;

  FOR v_ref IN SELECT * FROM jsonb_array_elements(coalesce(p_inputs, '[]'::jsonb))
  LOOP
    INSERT INTO public.derivation_edges (from_table, from_pk, to_table, to_value_id, edge_kind)
    VALUES (v_ref->>'table', v_ref->>'pk', 'inference_records', v_inference_id, 'input');
  END LOOP;

  RETURN v_inference_id;
END $$;


--
-- Name: FUNCTION register_inference_record(p_subject_id text, p_claim_text text, p_status_token text, p_confidence numeric, p_cited_item_ids uuid[], p_origin_class text, p_method_id text, p_method_version text, p_computed_by text, p_trigger_question_ref text, p_inputs jsonb, p_supersedes uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.register_inference_record(p_subject_id text, p_claim_text text, p_status_token text, p_confidence numeric, p_cited_item_ids uuid[], p_origin_class text, p_method_id text, p_method_version text, p_computed_by text, p_trigger_question_ref text, p_inputs jsonb, p_supersedes uuid) IS 'The ONE write path for a new inference_records row + its derivation_edges (migration 339), the narrative-table twin of register_derived_value() (migration 285). Service-role only.';


--
-- Name: release_funded_pass_lock(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_funded_pass_lock(p_key text, p_pid integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  delete from public.funded_pass_runlock where lock_key = p_key and holder_pid = p_pid;
end; $$;


--
-- Name: release_mutation_lease(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_mutation_lease(p_item uuid, p_holder text) RETURNS TABLE(released boolean)
    LANGUAGE plpgsql
    AS $$
begin
  delete from public.mutation_leases
   where intelligence_item_id = p_item and holder = p_holder;
  return query select found;
end;
$$;


--
-- Name: reorder_user_list_item(uuid, text, text, text, text, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reorder_user_list_item(p_user_id uuid, p_list_key text, p_item_id text, p_prev_item_id text DEFAULT NULL::text, p_next_item_id text DEFAULT NULL::text, p_seed_item_ids text[] DEFAULT NULL::text[]) RETURNS numeric
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_step    constant numeric := 1000;
  v_min_gap constant numeric := 0.000001;
  v_prev    numeric;
  v_next    numeric;
  v_pos     numeric;
  v_count   integer;
BEGIN
  IF p_user_id IS NULL OR p_list_key IS NULL OR p_item_id IS NULL THEN
    RAISE EXCEPTION 'reorder_user_list_item: user_id, list_key and item_id are required';
  END IF;

  IF p_item_id = p_prev_item_id OR p_item_id = p_next_item_id THEN
    RAISE EXCEPTION 'reorder_user_list_item: item_id may not equal prev_item_id or next_item_id';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(p_user_id::text || ':' || p_list_key));

  SELECT count(*) INTO v_count
    FROM user_list_order
   WHERE user_id = p_user_id AND list_key = p_list_key;

  IF v_count = 0 AND p_seed_item_ids IS NOT NULL AND array_length(p_seed_item_ids, 1) > 0 THEN
    INSERT INTO user_list_order (user_id, list_key, item_id, position)
    SELECT p_user_id, p_list_key, s.item_id, s.ord * v_step
      FROM unnest(p_seed_item_ids) WITH ORDINALITY AS s(item_id, ord)
    ON CONFLICT (user_id, list_key, item_id) DO NOTHING;
  END IF;

  SELECT position INTO v_prev
    FROM user_list_order
   WHERE user_id = p_user_id AND list_key = p_list_key AND item_id = p_prev_item_id;

  SELECT position INTO v_next
    FROM user_list_order
   WHERE user_id = p_user_id AND list_key = p_list_key AND item_id = p_next_item_id;

  IF v_prev IS NOT NULL AND v_next IS NOT NULL AND (v_next - v_prev) < v_min_gap THEN
    WITH ladder AS (
      SELECT id, row_number() OVER (ORDER BY position, item_id) AS rn
        FROM user_list_order
       WHERE user_id = p_user_id AND list_key = p_list_key
    )
    UPDATE user_list_order u
       SET position = ladder.rn * v_step,
           updated_at = now()
      FROM ladder
     WHERE u.id = ladder.id;

    SELECT position INTO v_prev
      FROM user_list_order
     WHERE user_id = p_user_id AND list_key = p_list_key AND item_id = p_prev_item_id;
    SELECT position INTO v_next
      FROM user_list_order
     WHERE user_id = p_user_id AND list_key = p_list_key AND item_id = p_next_item_id;
  END IF;

  IF v_prev IS NULL AND v_next IS NULL THEN
    SELECT coalesce(max(position), 0) + v_step INTO v_pos
      FROM user_list_order
     WHERE user_id = p_user_id AND list_key = p_list_key AND item_id <> p_item_id;
  ELSIF v_prev IS NULL THEN
    v_pos := v_next - v_step;
  ELSIF v_next IS NULL THEN
    v_pos := v_prev + v_step;
  ELSE
    v_pos := (v_prev + v_next) / 2;
  END IF;

  INSERT INTO user_list_order (user_id, list_key, item_id, position)
  VALUES (p_user_id, p_list_key, p_item_id, v_pos)
  ON CONFLICT (user_id, list_key, item_id)
  DO UPDATE SET position = EXCLUDED.position, updated_at = now();

  RETURN v_pos;
END;
$$;


--
-- Name: FUNCTION reorder_user_list_item(p_user_id uuid, p_list_key text, p_item_id text, p_prev_item_id text, p_next_item_id text, p_seed_item_ids text[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.reorder_user_list_item(p_user_id uuid, p_list_key text, p_item_id text, p_prev_item_id text, p_next_item_id text, p_seed_item_ids text[]) IS 'Atomically place one item between two neighbours in a personal list order. Advisory-locked per (user_id, list_key); seeds an unordered list from p_seed_item_ids on first use; renormalises to a 1000-step ladder when a gap collapses. Returns the assigned position.';


--
-- Name: request_verification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.request_verification() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_status text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'request_verification: no authenticated user' USING ERRCODE = '42501';
  END IF;

  SELECT p.verifier_status INTO v_status FROM public.profiles p WHERE p.id = v_uid FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_verification: no profiles row for the caller' USING ERRCODE = 'P0002';
  END IF;

  IF v_status = 'pending' THEN
    RETURN 'pending';
  END IF;

  IF v_status IS NULL OR v_status IN ('none', 'revoked') THEN
    UPDATE public.profiles SET verifier_status = 'pending', updated_at = now() WHERE id = v_uid;
    RETURN 'pending';
  END IF;

  RAISE EXCEPTION 'request_verification: verifier_status is % and cannot be re-requested', v_status
    USING ERRCODE = '55000';
END;
$$;


--
-- Name: FUNCTION request_verification(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.request_verification() IS 'SEC-2 (migration 367). SECURITY DEFINER. Sets profiles.verifier_status to pending for auth.uid() only, from none, NULL or revoked; a no-op from pending; refused (55000) from active; refused (42501) without a session. Runs as the function owner so the profiles_privilege_guard trigger sanctions the write; takes no parameter so it cannot name another user. EXECUTE: authenticated only.';


--
-- Name: revoke_invitation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_invitation(p_invitation_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_invitation public.org_invitations;
  v_caller_id  uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_invitation
  FROM public.org_invitations
  WHERE id = p_invitation_id
  FOR UPDATE;

  IF v_invitation IS NULL THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;

  -- Caller must be admin/owner of the org.
  IF NOT EXISTS (
    SELECT 1 FROM public.org_memberships m
    WHERE m.org_id = v_invitation.org_id
      AND m.user_id = v_caller_id
      AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Not an admin of org %', v_invitation.org_id USING ERRCODE = '42501';
  END IF;

  IF v_invitation.status <> 'pending' THEN
    RAISE EXCEPTION 'Invitation is %', v_invitation.status USING ERRCODE = '22023';
  END IF;

  UPDATE public.org_invitations
  SET status = 'revoked',
      revoked_at = now(),
      revoked_by_user_id = v_caller_id
  WHERE id = v_invitation.id;
END;
$$;


--
-- Name: FUNCTION revoke_invitation(p_invitation_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.revoke_invitation(p_invitation_id uuid) IS 'Admin-only: pull a pending invitation back. Flips status to revoked. RLS would block the UPDATE for non-admins; this DEFINER fn enforces the same check explicitly.';


--
-- Name: revoke_item_correction(uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_item_correction(p_item_id uuid, p_correction_id uuid, p_revoked_by uuid, p_reason text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
DECLARE
  c            public.item_corrections;
  v_has_ev     boolean;
  v_ev         jsonb;
  v_mv         jsonb;
  v_col        text;
  v_tag        text;
  v_cur        text[];
  v_new        text[];
  v_in_machine boolean;
  v_target     uuid;
BEGIN
  IF p_revoked_by IS NULL THEN
    RAISE EXCEPTION 'correction_actor_required: revoked_by is required';
  END IF;

  UPDATE public.item_corrections
     SET revoked_at = now(),
         revoked_by = p_revoked_by,
         revoked_reason = NULLIF(btrim(COALESCE(p_reason, '')), '')
   WHERE id = p_correction_id AND item_id = p_item_id AND revoked_at IS NULL
  RETURNING * INTO c;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correction_not_active: no active correction % on item %', p_correction_id, p_item_id;
  END IF;

  -- The value to put back: the latest machine value a writer tried to store, else the value captured at write.
  SELECT true, e.latest_machine_value INTO v_has_ev, v_ev
    FROM public.item_correction_evidence e WHERE e.correction_id = c.id;
  IF COALESCE(v_has_ev, false) THEN v_mv := v_ev; ELSE v_mv := c.machine_value; END IF;

  IF c.target_kind = 'tag' THEN
    v_col := split_part(c.target_ref, ':', 1);
    v_tag := substr(c.target_ref, length(v_col) + 2);
    EXECUTE format('SELECT %I FROM public.intelligence_items WHERE id = $1', v_col) INTO v_cur USING c.item_id;
    v_cur := COALESCE(v_cur, ARRAY[]::text[]);
    v_in_machine := v_tag = ANY (ARRAY(
      SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(v_mv) = 'array' THEN v_mv ELSE '[]'::jsonb END)));
    v_new := NULL;
    IF v_in_machine AND NOT (v_tag = ANY (v_cur)) THEN
      v_new := v_cur || v_tag;
    ELSIF NOT v_in_machine AND v_tag = ANY (v_cur) THEN
      v_new := array_remove(v_cur, v_tag);
    END IF;
    IF v_new IS NOT NULL THEN
      EXECUTE format('UPDATE public.intelligence_items SET %I = $1 WHERE id = $2', v_col) USING v_new, c.item_id;
    END IF;

  ELSIF c.target_kind = 'full_brief' THEN
    UPDATE public.intelligence_items SET full_brief = (v_mv #>> '{}') WHERE id = c.item_id;

  ELSIF c.target_kind = 'section_text' THEN
    IF v_mv IS NOT NULL THEN
      UPDATE public.intelligence_item_sections SET content_md = (v_mv #>> '{}')
       WHERE item_id = c.item_id AND section_key = c.target_ref;
    END IF;

  ELSIF c.target_kind = 'fact' AND c.op = 'replace' THEN
    v_target := c.target_ref::uuid;
    UPDATE public.section_claim_provenance
       SET claim_text = COALESCE(v_mv ->> 'claim_text', claim_text),
           source_span = v_mv ->> 'source_span',
           source_id = NULLIF(v_mv ->> 'source_id', '')::uuid,
           search_result_id = NULLIF(v_mv ->> 'search_result_id', '')::uuid
     WHERE id = v_target AND intelligence_item_id = c.item_id;

  ELSIF c.target_kind = 'connection' AND c.op = 'add' THEN
    v_target := c.target_ref::uuid;
    DELETE FROM public.item_cross_references
     WHERE (source_item_id = c.item_id AND target_item_id = v_target)
        OR (source_item_id = v_target AND target_item_id = c.item_id);
    INSERT INTO public.item_cross_references
    SELECT * FROM jsonb_populate_recordset(NULL::public.item_cross_references, COALESCE(c.machine_value, '[]'::jsonb))
    ON CONFLICT (source_item_id, target_item_id) DO NOTHING;
  END IF;
  -- connection remove: the edge is NOT re-created here; fact suppress: nothing was written, nothing to restore.
END;
$_$;


--
-- Name: search_intelligence_items(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_intelligence_items(q text, max_rows integer DEFAULT 12) RETURNS TABLE(id uuid, rank real)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  SELECT ii.id,
         ts_rank_cd(ii.search_tsv, websearch_to_tsquery('english', q)) AS rank
    FROM public.intelligence_items ii
   WHERE ii.provenance_status = 'verified'
     AND ii.is_archived IS NOT TRUE
     AND ii.search_tsv @@ websearch_to_tsquery('english', q)
   ORDER BY rank DESC
   LIMIT greatest(1, least(coalesce(max_rows, 12), 30));
$$;


--
-- Name: FUNCTION search_intelligence_items(q text, max_rows integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.search_intelligence_items(q text, max_rows integer) IS 'S1-09 Ask retrieval: websearch-syntax FTS over verified, non-archived intelligence_items, ranked by ts_rank_cd over the weighted search_tsv (title A / summary B / full_brief C). Enforces the customer read predicate inside the function so retrieval can never widen visibility.';


--
-- Name: set_canonical_instrument_key(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_canonical_instrument_key() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_key text;
BEGIN
  v_key := public.derive_canonical_instrument_key(NEW.instrument_identifier, NEW.source_url);
  IF v_key IS NOT NULL THEN
    NEW.canonical_instrument_key := v_key;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: set_provenance_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_provenance_status() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_item_id    uuid;
  v_validation validation_result;
  v_current    provenance_status;
  v_verified_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'section_claim_provenance' THEN
      v_item_id := OLD.intelligence_item_id;
    ELSIF TG_TABLE_NAME = 'intelligence_item_sections' THEN
      v_item_id := OLD.item_id;
    ELSIF TG_TABLE_NAME = 'intelligence_items' THEN
      v_item_id := OLD.id;
    ELSE
      RETURN OLD;
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'intelligence_items' THEN
      v_item_id := NEW.id;
    ELSIF TG_TABLE_NAME = 'intelligence_item_sections' THEN
      v_item_id := NEW.item_id;
    ELSIF TG_TABLE_NAME = 'section_claim_provenance' THEN
      v_item_id := NEW.intelligence_item_id;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  IF v_item_id IS NULL THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  v_validation := public.validate_item_provenance(v_item_id);

  SELECT provenance_status INTO v_current
    FROM public.intelligence_items
   WHERE id = v_item_id;

  IF NOT FOUND THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF v_current IS DISTINCT FROM v_validation.recommended_status THEN
    IF v_validation.recommended_status = 'verified' THEN
      v_verified_at := now();
    ELSE
      v_verified_at := NULL;
    END IF;

    UPDATE public.intelligence_items
       SET provenance_status      = v_validation.recommended_status,
           provenance_verified_at = v_verified_at
     WHERE id = v_item_id;
  END IF;

  IF v_validation.recommended_status = 'quarantined' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.integrity_flags f
       WHERE f.category = 'data_quality'
         AND f.subject_type = 'item'
         AND f.subject_ref = v_item_id::text
         AND f.status = 'open'
    ) THEN
      INSERT INTO public.integrity_flags (
        category, subject_type, subject_ref, description,
        recommended_actions, status, created_by
      )
      VALUES (
        'data_quality',
        'item',
        v_item_id::text,
        'Provenance gate quarantine: item failed one or more of the six provenance criteria on write.',
        jsonb_build_object('failures', v_validation.failures),
        'open',
        'set_provenance_status_trigger'
      );
    END IF;
  END IF;

  IF v_validation.recommended_status = 'verified' THEN
    UPDATE public.integrity_flags
       SET status = 'resolved',
           resolved_at = now(),
           resolved_by = 'set_provenance_status_trigger',
           resolution_note = 'auto-resolved: item re-verified by the provenance gate'
     WHERE category = 'data_quality'
       AND subject_type = 'item'
       AND subject_ref = v_item_id::text
       AND status = 'open'
       AND created_by = 'set_provenance_status_trigger';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;


--
-- Name: FUNCTION set_provenance_status(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.set_provenance_status() IS 'Sprint 4 Block 1 task 1.4 trigger function, migration 139 revision. AFTER INSERT/UPDATE, stamps provenance_status from validate_item_provenance and (NEW in 139) CLOSES the trigger-opened data_quality flag when the item is verified. Opens a data_quality flag on quarantine (idempotent). Fires only on future writes.';


--
-- Name: set_source_label(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_source_label() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  NEW.category := public.derive_source_category(NEW.source_role, NEW.name);
  NEW.intelligence_types := public.derive_source_intelligence_types(NEW.category);
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION set_source_label(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.set_source_label() IS 'Migration 123: category + intelligence_types DERIVE from source_role + name on every write (derive_source_category == migration 084 CASE). The label is now a live function of what the source IS, not an independent field. source_role is classified at onboarding by classify-source-role.ts.';


--
-- Name: source_reliability_ledger_append_only(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.source_reliability_ledger_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: a correction is a new row, never an edit or a delete (%)', TG_TABLE_NAME, TG_OP;
END $$;


--
-- Name: surface_of(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.surface_of(p_item_type text, p_domain integer) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  SELECT
    CASE
      WHEN p_item_type IN ('regulation', 'directive', 'standard', 'guidance', 'framework', 'law') THEN 'regulations'
      WHEN p_domain IN (1) THEN 'regulations'
      WHEN p_domain IN (3, 6) THEN 'operations'
      WHEN p_domain IN (7) THEN 'research'
      WHEN p_domain IN (2, 4) THEN 'market'
      WHEN p_item_type IN ('regional_data') THEN 'operations'
      WHEN p_item_type IN ('research_finding') THEN 'research'
      WHEN p_item_type IN ('market_signal', 'initiative', 'technology', 'innovation') THEN 'market'
      ELSE 'uncategorized'
    END;
$$;


--
-- Name: FUNCTION surface_of(p_item_type text, p_domain integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.surface_of(p_item_type text, p_domain integer) IS 'Single classification SoT: maps (item_type, domain) to one of regulations/market/operations/research, else uncategorized. Body GENERATED from src/lib/surface-of.mjs SURFACE_RULES (renderSurfaceOfSql); the vocab-drift guard fails CI on any divergence. Mirrors the five-surface model (Community is not an intelligence_items surface).';


--
-- Name: sync_sources_tier_columns(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_sources_tier_columns() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.base_tier IS NULL AND NEW.tier IS NOT NULL THEN
      NEW.base_tier := NEW.tier;
    ELSIF NEW.tier IS NULL AND NEW.base_tier IS NOT NULL THEN
      NEW.tier := NEW.base_tier;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.tier IS DISTINCT FROM OLD.tier AND NEW.base_tier IS NOT DISTINCT FROM OLD.base_tier THEN
      NEW.base_tier := NEW.tier;
    ELSIF NEW.base_tier IS DISTINCT FROM OLD.base_tier AND NEW.tier IS NOT DISTINCT FROM OLD.tier THEN
      NEW.tier := NEW.base_tier;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION sync_sources_tier_columns(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.sync_sources_tier_columns() IS 'Lockstep sync between sources.tier (legacy column) and sources.base_tier (Q2 canonical name). On INSERT, fills whichever of tier or base_tier was not provided from the one that was. On UPDATE, propagates a single-column change to the other. Belt-and-suspenders with the CHECK constraint sources_tier_matches_base_tier. Drops with migration 094 when tier column is removed.';


--
-- Name: trg_intelligence_items_version_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_intelligence_items_version_snapshot() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
DECLARE
  next_version INT;
  prev_id UUID;
BEGIN
  SELECT COALESCE(MAX(version_number), 0) + 1,
         (SELECT id FROM intelligence_item_versions
            WHERE intelligence_item_id = NEW.id
            ORDER BY version_number DESC
            LIMIT 1)
    INTO next_version, prev_id
    FROM intelligence_item_versions
   WHERE intelligence_item_id = NEW.id;

  INSERT INTO intelligence_item_versions (
    intelligence_item_id,
    version_number,
    previous_version_id,
    full_brief,
    severity,
    priority,
    urgency_tier,
    format_type,
    topic_tags,
    operational_scenario_tags,
    compliance_object_tags,
    related_items,
    intersection_summary,
    sources_used,
    last_regenerated_at,
    regeneration_skill_version
  ) VALUES (
    NEW.id,
    next_version,
    prev_id,
    NEW.full_brief,
    NEW.severity,
    NEW.priority,
    NEW.urgency_tier,
    NEW.format_type,
    COALESCE(to_jsonb(NEW.topic_tags), '[]'::jsonb),
    COALESCE(to_jsonb(NEW.operational_scenario_tags), '[]'::jsonb),
    COALESCE(to_jsonb(NEW.compliance_object_tags), '[]'::jsonb),
    COALESCE(to_jsonb(NEW.related_items), '[]'::jsonb),
    NEW.intersection_summary,
    COALESCE(NEW.sources_used, '{}'::uuid[]),
    NEW.last_regenerated_at,
    NEW.regeneration_skill_version
  );

  RETURN NEW;
END;
$$;


--
-- Name: update_community_group_member_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_community_group_member_count() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
begin
  if tg_op = 'INSERT' then
    update community_groups
       set member_count = member_count + 1,
           last_active_at = now()
     where id = new.group_id;
  elsif tg_op = 'DELETE' then
    update community_groups
       set member_count = greatest(0, member_count - 1)
     where id = old.group_id;
  end if;
  return coalesce(new, old);
end;
$$;


--
-- Name: update_community_post_reply_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_community_post_reply_count() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
declare
  v_group_id uuid;
begin
  if tg_op = 'INSERT' and new.parent_post_id is not null then
    update community_posts
       set reply_count = reply_count + 1,
           last_reply_at = new.created_at
     where id = new.parent_post_id;
    -- bubble last_active_at up to the group
    update community_groups
       set last_active_at = new.created_at
     where id = new.group_id;
  elsif tg_op = 'DELETE' and old.parent_post_id is not null then
    update community_posts
       set reply_count = greatest(0, reply_count - 1)
     where id = old.parent_post_id;
  end if;

  -- weekly_post_count writer (F9, migration 190): deterministic recount of the
  -- trailing 7-day window. AFTER-trigger visibility means the recount already
  -- sees the inserted row / no longer sees the deleted row.
  v_group_id := coalesce(new.group_id, old.group_id);
  if v_group_id is not null then
    update community_groups
       set weekly_post_count = (
             select count(*)
               from community_posts p
              where p.group_id = v_group_id
                and p.created_at >= now() - interval '7 days'
           )
     where id = v_group_id;
  end if;

  return coalesce(new, old);
end;
$$;


--
-- Name: update_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: user_belongs_to_org(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_belongs_to_org(check_org_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM org_memberships
    WHERE org_id = check_org_id
    AND user_id = auth.uid()
  );
END;
$$;


--
-- Name: user_can_write_in_org(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_can_write_in_org(p_org uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.org_memberships m
     WHERE m.org_id = p_org
       AND m.user_id = auth.uid()
       AND m.role IN ('member', 'admin', 'owner')
  );
$$;


--
-- Name: FUNCTION user_can_write_in_org(p_org uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.user_can_write_in_org(p_org uuid) IS 'SEC-3b (migration 370). True when auth.uid() holds a membership of the organization with role member, admin or owner; role viewer reads (user_belongs_to_org) but does not write. Same shape as user_belongs_to_org (SECURITY DEFINER, pinned search_path) so it does not recurse through org_memberships RLS. Used by the INSERT, UPDATE and DELETE policies of workspace_item_overrides, org_watchlist, workspace_tags, item_workspace_tags, portfolios and portfolio_members.';


--
-- Name: user_group_role(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_group_role(p_group uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT m.role
    FROM public.community_group_members m
   WHERE m.group_id = p_group
     AND m.user_id = auth.uid()
   LIMIT 1;
$$;


--
-- Name: FUNCTION user_group_role(p_group uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.user_group_role(p_group uuid) IS 'SEC-3b (migration 370, recursion fix). The role (admin, moderator, member) auth.uid() holds in the community group, NULL when none. SECURITY DEFINER with a pinned search_path so a policy on community_group_members can ask it without a subquery on its own table (a policy that reads its own table raises 42P17 infinite recursion). Same shape as user_org_role and user_is_group_member.';


--
-- Name: user_is_group_admin(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_is_group_admin(_group_id uuid, _user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM community_group_members
    WHERE group_id = _group_id AND user_id = _user_id
      AND role IN ('admin', 'moderator')
  );
$$;


--
-- Name: FUNCTION user_is_group_admin(_group_id uuid, _user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.user_is_group_admin(_group_id uuid, _user_id uuid) IS 'SECURITY DEFINER helper for admin/moderator role checks. Bypasses RLS recursion.';


--
-- Name: user_is_group_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_is_group_member(_group_id uuid, _user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM community_group_members
    WHERE group_id = _group_id AND user_id = _user_id
  );
$$;


--
-- Name: FUNCTION user_is_group_member(_group_id uuid, _user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.user_is_group_member(_group_id uuid, _user_id uuid) IS 'SECURITY DEFINER helper to bypass RLS recursion on community_group_members membership checks.';


--
-- Name: user_org_role(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_org_role(p_org uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT m.role
    FROM public.org_memberships m
   WHERE m.org_id = p_org
     AND m.user_id = auth.uid()
   LIMIT 1;
$$;


--
-- Name: FUNCTION user_org_role(p_org uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.user_org_role(p_org uuid) IS 'SEC-3b (migration 370, recursion fix). The role (owner, admin, member, viewer) auth.uid() holds in the organization, NULL when none. SECURITY DEFINER with a pinned search_path so a policy on org_memberships can ask it without a subquery on its own table (a policy that reads its own table raises 42P17 infinite recursion). Same shape as user_belongs_to_org.';


--
-- Name: user_owns_group(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_owns_group(_group_id uuid, _user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM community_groups
    WHERE id = _group_id AND owner_user_id = _user_id
  );
$$;


--
-- Name: FUNCTION user_owns_group(_group_id uuid, _user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.user_owns_group(_group_id uuid, _user_id uuid) IS 'SECURITY DEFINER helper for group ownership check. Bypasses RLS recursion.';


--
-- Name: validate_item_provenance(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_item_provenance(p_item_id uuid) RETURNS public.validation_result
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_result        validation_result;
  v_failures      jsonb := '[]'::jsonb;
  v_warnings      jsonb := '[]'::jsonb;   -- 302: below-floor tier RATINGS (never blocks validity)
  v_below_floor_facts integer := 0;       -- 302: count mirrored into v_result.warnings
  v_item          RECORD;
  v_source        RECORD;
  v_has_sections  boolean;
  v_priority_high boolean;
  v_floor_armed   boolean;
  v_floor_max     integer;
  v_fact_floor    integer;          -- 202: per-fact effective floor (scoped for standard own-body)
  v_item_institution uuid;          -- 202: the item's own authoring-body institution (from its canonical source)
  r               RECORD;
  v_url           text;
  v_url_ok        boolean;
  v_slot          RECORD;
  v_slot_count    integer;
  v_fact_total    integer;
  v_fact_verified integer;
  -- 203: voluntary-instrument family eligible for the own-authoring-body floor.
  c_own_body_types constant text[] := ARRAY['standard', 'framework', 'initiative'];
  c_analysis_labels constant text[] := ARRAY[
    '*Per the workspace''s reading:*',
    '*Analytical inference:*',
    '*Industry interpretation:*',
    '*Operational implication:*'
  ];
  c_legal_callout   constant text := '*Legal Confirmation Required:*';
  c_label_re        constant text :=
    '\*?(per the workspace''s reading|analytical inference|industry interpretation|operational implication)([[:space:]]*\([^)]*\))?:\*?';
  c_legal_req_re    constant text :=
    '(the[[:space:]]+(regulation|law|directive|rule|act|amendment|mechanism|standard)[[:space:]]+(requires|mandates|obligates|prohibits|imposes))|(is[[:space:]]+required[[:space:]]+(under|by))|(legally[[:space:]]+required)';
  c_forward_re      constant text :=
    '(propos|would|will|expected|forthcoming|consultation|draft|anticipat|pending|set[[:space:]]+to|once[[:space:]]+(adopted|enacted)|if[[:space:]]+adopted|(by|from|effective|until)[[:space:]]+20[0-9][0-9])';
BEGIN
  SELECT id, source_id, priority, item_type, source_url, full_brief
    INTO v_item
    FROM public.intelligence_items
   WHERE id = p_item_id;

  IF NOT FOUND THEN
    v_failures := v_failures || jsonb_build_object(
      'criterion', 0,
      'reason', 'item_not_found',
      'item_id', p_item_id
    );
    v_result.valid := false;
    v_result.failures := v_failures;
    v_result.recommended_status := 'quarantined';
    RETURN v_result;
  END IF;

  -- 202: the item's own authoring-body institution (null when the item has no source / unlinked source).
  IF v_item.source_id IS NOT NULL THEN
    SELECT institution_id INTO v_item_institution
      FROM public.sources WHERE id = v_item.source_id;
  END IF;

  v_priority_high := v_item.priority IN ('CRITICAL', 'HIGH');
  v_floor_max := CASE
    WHEN v_item.item_type IN ('regulation', 'directive', 'standard', 'guidance', 'framework') THEN 2
    WHEN v_item.item_type = 'research_finding' THEN 4
    WHEN v_item.item_type IN ('technology', 'innovation', 'tool') THEN 5
    ELSE NULL
  END;
  -- 158: the reg family arms the floor UNCONDITIONALLY (primary-legal grounding is the bar
  -- regardless of the model's own severity choice); non-reg per-type floors stay CRITICAL/HIGH.
  v_floor_armed := v_priority_high
    OR v_item.item_type IN ('regulation', 'directive', 'standard', 'guidance', 'framework');

  SELECT EXISTS (
    SELECT 1 FROM public.intelligence_item_sections s
     WHERE s.item_id = p_item_id
       AND COALESCE(s.content_md, '') <> ''
  ) INTO v_has_sections;

  -- ══ CRITERION 1 — Validated source ════════════════════════════════
  IF v_item.source_id IS NULL THEN
    v_failures := v_failures || jsonb_build_object(
      'criterion', 1,
      'reason', 'missing_source_id'
    );
  ELSE
    SELECT id, base_tier, effective_tier, status, url
      INTO v_source
      FROM public.sources
     WHERE id = v_item.source_id;

    IF NOT FOUND THEN
      v_failures := v_failures || jsonb_build_object(
        'criterion', 1,
        'reason', 'source_not_found',
        'source_id', v_item.source_id
      );
    ELSE
      IF v_source.base_tier IS NULL AND v_source.effective_tier IS NULL THEN
        v_failures := v_failures || jsonb_build_object(
          'criterion', 1,
          'reason', 'source_tier_null',
          'source_id', v_item.source_id
        );
      END IF;
      IF v_source.status <> 'active' THEN
        v_failures := v_failures || jsonb_build_object(
          'criterion', 1,
          'reason', 'source_not_active',
          'source_id', v_item.source_id,
          'status', v_source.status
        );
      END IF;
    END IF;
  END IF;

  IF v_has_sections THEN

    -- ══ CRITERION 2 — Citation URL grounding ════════════════════════
    FOR r IN
      SELECT DISTINCT m[1] AS url
        FROM public.intelligence_item_sections s,
             LATERAL regexp_matches(
               COALESCE(s.content_md, ''),
               'https?://(?:[^\s()\]\}"''<>«»‹›“”‘’]|\([^\s()]*\))+',
               'g'
             ) AS m
       WHERE s.item_id = p_item_id
    LOOP
      v_url := public.canonicalize_citation_url(r.url);
      v_url_ok := false;

      IF v_item.source_url IS NOT NULL
         AND v_item.source_url <> ''
         AND public.canonicalize_citation_url(v_item.source_url) = v_url THEN
        v_url_ok := true;
      END IF;

      IF NOT v_url_ok AND EXISTS (
        SELECT 1 FROM public.agent_run_searches a
         WHERE a.intelligence_item_id = p_item_id
           AND public.canonicalize_citation_url(a.result_url) = v_url
      ) THEN
        v_url_ok := true;
      END IF;

      IF NOT v_url_ok AND EXISTS (
        SELECT 1 FROM public.sources sr
         WHERE public.canonicalize_citation_url(sr.url) = v_url
      ) THEN
        v_url_ok := true;
      END IF;

      IF NOT v_url_ok THEN
        v_failures := v_failures || jsonb_build_object(
          'criterion', 2,
          'reason', 'ungrounded_url',
          'url', v_url
        );
      END IF;
    END LOOP;

    -- ══ CRITERION 3 — Claim-level FACT grounding ════════════════════
    FOR r IN
      SELECT scp.id,
             scp.claim_text,
             scp.source_span,
             scp.search_result_id, scp.mint_hold_reason,
             COALESCE(src.tier_override, src.base_tier) AS derived_tier,
             src.institution_id AS src_institution_id,      -- 202: the fact source's authoring body
             ars.result_content
        FROM public.section_claim_provenance scp
        LEFT JOIN public.agent_run_searches ars
               ON ars.id = scp.search_result_id
        LEFT JOIN public.sources src
               ON src.id = scp.source_id
       WHERE scp.intelligence_item_id = p_item_id
         AND scp.claim_kind = 'FACT'
    LOOP
      IF r.source_span IS NULL OR btrim(r.source_span) = '' THEN
        v_failures := v_failures || jsonb_build_object(
          'criterion', 3,
          'reason', 'fact_missing_source_span',
          'claim', r.claim_text
        );
      ELSIF r.result_content IS NULL
            OR position(lower(btrim(r.source_span)) IN lower(r.result_content)) = 0 THEN
        v_failures := v_failures || jsonb_build_object(
          'criterion', 3,
          'reason', 'fact_span_not_in_source',
          'claim', r.claim_text,
          'source_span', r.source_span
        );
      END IF;

      -- 202/203: per-fact effective floor. Default = the item-type floor (2 for the reg family).
      -- For a VOLUNTARY INSTRUMENT (standard | framework | initiative), a FACT on the item's OWN
      -- authoring body (same institution as the item's canonical source) grounds at the
      -- issuing-body tier (<= 4) — the instrument's own authoritative text IS its primary.
      -- A same-tier UNRELATED host does NOT qualify; it stays at the item-type floor. Third-party
      -- commentary therefore can never clear via this path.
      v_fact_floor := v_floor_max;
      IF v_item.item_type = ANY (c_own_body_types)
         AND v_item_institution IS NOT NULL
         AND r.src_institution_id IS NOT NULL
         AND r.src_institution_id = v_item_institution THEN
        v_fact_floor := 4;
      END IF;

      IF v_floor_armed
         AND v_fact_floor IS NOT NULL
         AND (r.derived_tier IS NULL
              OR r.derived_tier > v_fact_floor) THEN
        v_below_floor_facts := v_below_floor_facts + 1;
        v_warnings := v_warnings || jsonb_build_object(
          'criterion', 3,
          'reason', 'fact_below_authority_floor',
          'claim', r.claim_text,
          'source_tier_derived', r.derived_tier,
          'priority', v_item.priority,
          'item_type', v_item.item_type,
          'floor_max', v_fact_floor,
          'floor_scope', CASE
                           WHEN v_fact_floor = 4 AND v_item.item_type = 'standard'
                             THEN 'standard_own_body'
                           WHEN v_fact_floor = 4 AND v_item.item_type = ANY (c_own_body_types)
                             THEN 'voluntary_own_body'
                           ELSE 'default'
                         END,
          'floor_basis', CASE WHEN v_priority_high THEN 'priority' ELSE 'item_type_unconditional' END
        );
      END IF;

      IF r.mint_hold_reason IS NOT NULL THEN
        v_failures := v_failures || jsonb_build_object('criterion', 3, 'reason', 'fact_mint_hold', 'claim', r.claim_text, 'mint_hold_reason', r.mint_hold_reason);
      END IF;
    END LOOP;

    -- ══ CRITERION 4 — Labeling discipline ═══════════════════════════
    -- 158: ANALYSIS label check is PER-CLAIM (same blank-line-delimited paragraph as the claim).
    FOR r IN
      SELECT scp.id, scp.claim_text, scp.claim_kind
        FROM public.section_claim_provenance scp
       WHERE scp.intelligence_item_id = p_item_id
         AND scp.claim_kind IN ('ANALYSIS', 'LEGAL')
    LOOP
      IF r.claim_kind = 'ANALYSIS' THEN
        IF NOT EXISTS (
          SELECT 1
            FROM public.intelligence_item_sections s,
                 LATERAL regexp_split_to_table(COALESCE(s.content_md, ''), E'\n[[:space:]]*\n') AS para
           WHERE s.item_id = p_item_id
             AND para ~* c_label_re
             AND para ILIKE '%' || r.claim_text || '%'
        ) THEN
          v_failures := v_failures || jsonb_build_object(
            'criterion', 4,
            'reason', 'analysis_missing_label_syntax',
            'claim', r.claim_text
          );
        END IF;

        IF r.claim_text ~* c_legal_req_re AND r.claim_text !~* c_forward_re THEN
          v_failures := v_failures || jsonb_build_object(
            'criterion', 4,
            'reason', 'legal_claim_mislabeled_analysis',
            'claim', r.claim_text
          );
        END IF;
      ELSIF r.claim_kind = 'LEGAL' THEN
        IF NOT EXISTS (
          SELECT 1
            FROM public.intelligence_item_sections s
           WHERE s.item_id = p_item_id
             AND s.content_md ILIKE '%' || c_legal_callout || '%'
        ) THEN
          v_failures := v_failures || jsonb_build_object(
            'criterion', 4,
            'reason', 'legal_not_routed_to_callout',
            'claim', r.claim_text
          );
        END IF;
      END IF;
    END LOOP;

    FOR r IN
      SELECT s.id AS section_row_id, s.content_md
        FROM public.intelligence_item_sections s
       WHERE s.item_id = p_item_id
         AND COALESCE(s.content_md, '') <> ''
    LOOP
      IF r.content_md ~* '\m(requires|must|mandates|obligates|prohibits|applies to)\M'
         AND NOT (
           r.content_md ~* c_label_re OR
           r.content_md ILIKE '%' || c_legal_callout || '%'
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.section_claim_provenance scp
            WHERE scp.section_row_id = r.section_row_id
              AND scp.claim_kind = 'FACT'
         )
      THEN
        v_failures := v_failures || jsonb_build_object(
          'criterion', 4,
          'reason', 'unlabeled_assertion',
          'section_row_id', r.section_row_id
        );
      END IF;
    END LOOP;

    -- ══ CRITERION 5 — Active sourcing / required slots ══════════════
    FOR v_slot IN
      SELECT slot_key
        FROM public.item_type_required_slots
       WHERE item_type = v_item.item_type
    LOOP
      SELECT count(*)::int INTO v_slot_count
        FROM public.section_claim_provenance scp
       WHERE scp.intelligence_item_id = p_item_id
         AND scp.claim_kind IN ('FACT', 'GAP')
         AND scp.claim_text ILIKE '%' || v_slot.slot_key || '%';

      IF v_slot_count = 0 THEN
        v_failures := v_failures || jsonb_build_object(
          'criterion', 5,
          'reason', 'missing_required_slot',
          'slot_key', v_slot.slot_key,
          'item_type', v_item.item_type
        );
      END IF;
    END LOOP;

  ELSE
    v_failures := v_failures || jsonb_build_object(
      'criterion', 2,
      'reason', 'no_section_content'
    );
  END IF; -- v_has_sections

  -- ══ CRITERION 6 — Brief presence (Wave-a Track B9 / plan A8) ═══════
  IF v_item.full_brief IS NULL OR btrim(v_item.full_brief) = '' THEN
    v_failures := v_failures || jsonb_build_object(
      'criterion', 6,
      'reason', 'missing_full_brief'
    );
  END IF;

  v_result.failures := v_failures;
    -- CRITERION 7 - GATE A (prose-fact, hash-validated). Every fact a customer could ACT ON must be span-proven.
  -- Fail when the item has a brief but lacks a CURRENT-HASH CLEAN scan state: missing state, STALE hash (prose edited
  -- since the scan), or orphan_count > 0. Scoped to full_brief <> '' (empty briefs are handled by criterion 6).
  IF coalesce(v_item.full_brief, '') <> ''
     AND NOT EXISTS (SELECT 1 FROM public.item_gate_a_state g
                      WHERE g.intelligence_item_id = p_item_id
                        AND g.scanned_hash = md5(v_item.full_brief)
                        AND g.orphan_count = 0) THEN
    v_failures := v_failures || jsonb_build_object('criterion', 7, 'reason', 'gate_a_unproven_or_stale');
    v_result.failures := v_failures;
  END IF;
  v_result.warnings := jsonb_build_object('below_floor_facts', v_below_floor_facts, 'claims', v_warnings);
  v_result.valid := (jsonb_array_length(v_failures) = 0);

  IF NOT v_result.valid THEN
    v_result.recommended_status := 'quarantined';
  ELSE
    v_result.recommended_status := 'verified';
  END IF;

  RETURN v_result;
END;
$$;


--
-- Name: FUNCTION validate_item_provenance(p_item_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.validate_item_provenance(p_item_id uuid) IS 'v203 (2026-08-01): own-authoring-body authority-floor carve-out extended from item_type=''standard'' to the voluntary-instrument family ARRAY[''standard'',''framework'',''initiative'']. Fires only on institution identity (claim source institution = item canonical source institution), tier cap <=4 unchanged. Third-party secondary commentary cannot clear via this path and is handled by the labeling track. ''regulation''/''directive''/''guidance'' unaffected. Monotonically relaxing: cannot regress a previously-valid item.';


--
-- Name: admin_action_cooldowns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_action_cooldowns (
    action_key text NOT NULL,
    last_triggered_at timestamp with time zone DEFAULT now() NOT NULL,
    triggered_by uuid,
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: TABLE admin_action_cooldowns; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.admin_action_cooldowns IS 'Singleton-per-action ledger. One row per cooldown-gated admin action. Updated on every successful trigger; read on every attempt to gate by elapsed time.';


--
-- Name: agent_run_searches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_run_searches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_run_id uuid,
    intelligence_item_id uuid,
    search_query text,
    result_url text,
    result_title text,
    result_index integer,
    result_content text,
    searched_at timestamp with time zone,
    result_chars integer
);


--
-- Name: TABLE agent_run_searches; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.agent_run_searches IS 'Per-run web_search log (Sprint 4 Addition A enabling table). One row per search result surfaced during the run that wrote an item content. result_content_excerpt caches the ~2KB snippet so claim-level span-checks (Component 3) run without re-fetching the page at validation time.';


--
-- Name: COLUMN agent_run_searches.result_content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.agent_run_searches.result_content IS 'FULL verbatim capture/result text (NOT a snippet — an earlier comment claimed ~2KB and was wrong; corrected 2026-08-09). Used for FACT-claim span verification without re-fetch; supports byte-exact position()/substring() checks and cross-run resume-first authoring.';


--
-- Name: COLUMN agent_run_searches.result_chars; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.agent_run_searches.result_chars IS 'Trigger-maintained (agent_run_searches_result_chars_trg, migration 322): the character length of result_content, kept in sync on every insert and update of that column. Readers that only need to know how long a capture is must use result_chars instead of computing the length of result_content in SQL -- a corpus-wide scan that decompresses result_content to measure it exhausted the Supabase small-tier disk IO burst budget for three and a half hours on 2026-09-13 (D32, defect-fix-plan-2026-09-12.md). Backfilled for pre-existing rows by migration 323.';


--
-- Name: agent_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.agent_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid,
    source_url text,
    fetch_method text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    duration_ms integer,
    status text DEFAULT 'running'::text NOT NULL,
    cost_usd_estimated numeric(10,6) DEFAULT 0 NOT NULL,
    errors jsonb DEFAULT '[]'::jsonb NOT NULL,
    fetch_status integer,
    fetch_html_bytes bigint,
    fetch_text_bytes bigint,
    fetch_render_ms integer,
    raw_fetch_id uuid,
    intelligence_item_id uuid,
    intelligence_item_version_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    model text,
    CONSTRAINT agent_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'success'::text, 'skipped'::text, 'error'::text])))
);


--
-- Name: TABLE agent_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.agent_runs IS 'One row per /api/agent/run invocation. Insert at request start, update in finally with terminal state. Drives the MTD spend tile and the wave-1 cost meter hard halt.';


--
-- Name: COLUMN agent_runs.model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.agent_runs.model IS 'Model id for a paid call row (e.g. claude-sonnet-4-6, claude-haiku-4-5-20251001). First-class per-model actuals (operator ruling 2026-07-15, build-phase measurement). Cost-0 marker/aggregate rows may leave it null.';


--
-- Name: aggregate_query_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.aggregate_query_log (
    query_id uuid DEFAULT gen_random_uuid() NOT NULL,
    table_name text NOT NULL,
    column_name text NOT NULL,
    cohort_hash text NOT NULL,
    cohort_members jsonb NOT NULL,
    cohort_size integer NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    requested_by text NOT NULL,
    refused boolean NOT NULL,
    reason text NOT NULL,
    frozen boolean DEFAULT false NOT NULL,
    frozen_from uuid,
    granted_payload jsonb,
    CONSTRAINT aggregate_query_log_cohort_size_check CHECK ((cohort_size >= 0))
);


--
-- Name: TABLE aggregate_query_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.aggregate_query_log IS 'Spec 08 §5.2: every publish_aggregate() request, granted or refused, with the sorted member list (real overlap and complement detection), the freeze linkage (frozen/frozen_from) and the exact granted payload a frozen repeat replays verbatim. Never readable by the application roles.';


--
-- Name: assumption_register; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assumption_register (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    assumption_key text NOT NULL,
    subsystem text NOT NULL,
    label text NOT NULL,
    rationale text NOT NULL,
    code_location text NOT NULL,
    governing_decision text,
    status text DEFAULT 'active'::text NOT NULL,
    superseded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    value_numeric numeric,
    unit text,
    derivation text,
    origin_class text,
    source_key text,
    source_ref text,
    n_observations integer,
    method_version text,
    as_at_date date,
    CONSTRAINT assumption_register_derivation_check CHECK ((derivation = ANY (ARRAY['statutory_fixed'::text, 'statutory_formula'::text, 'observed'::text, 'transacted_index'::text, 'assessed'::text, 'calculated'::text, 'interpolated'::text, 'modelled'::text, 'estimated'::text]))),
    CONSTRAINT assumption_register_n_observations_positive_check CHECK (((n_observations IS NULL) OR (n_observations > 0))),
    CONSTRAINT assumption_register_origin_class_check CHECK ((origin_class = ANY (ARRAY['community'::text, 'community-corroborated'::text, 'modelled'::text, 'derived'::text, 'partner'::text, 'verified'::text, 'official'::text]))),
    CONSTRAINT assumption_register_status_check CHECK ((status = ANY (ARRAY['active'::text, 'superseded'::text, 'retired'::text])))
);


--
-- Name: TABLE assumption_register; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.assumption_register IS 'WO-20: the register for modelling constants this product chose (a scorer weight, a confidence cutoff, a pedigree floor) — distinct from emission_factors, the register for numbers the world published. Read-only display consumer only; never a runtime read path for the code that embodies each constant.';


--
-- Name: auxiliary_energy_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auxiliary_energy_profiles (
    profile_id uuid DEFAULT gen_random_uuid() NOT NULL,
    load_type text NOT NULL,
    node_id text,
    kw_draw numeric NOT NULL,
    duty_cycle numeric NOT NULL,
    setpoint_c numeric,
    setpoint_rh_pct numeric,
    hours_typical numeric NOT NULL,
    grid_intensity_source text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id uuid NOT NULL,
    CONSTRAINT auxiliary_energy_profiles_duty_cycle_check CHECK (((duty_cycle >= (0)::numeric) AND (duty_cycle <= (1)::numeric))),
    CONSTRAINT auxiliary_energy_profiles_hours_typical_check CHECK ((hours_typical >= (0)::numeric)),
    CONSTRAINT auxiliary_energy_profiles_kw_draw_check CHECK ((kw_draw >= (0)::numeric)),
    CONSTRAINT auxiliary_energy_profiles_load_type_check CHECK ((load_type = ANY (ARRAY['reefer_genset'::text, 'airport_climate_hold'::text, 'warehouse_hvac'::text, 'museum_spec_hold'::text, 'battery_conditioning'::text, 'dehumidification'::text]))),
    CONSTRAINT auxiliary_energy_profiles_setpoint_rh_pct_check CHECK (((setpoint_rh_pct IS NULL) OR ((setpoint_rh_pct >= (0)::numeric) AND (setpoint_rh_pct <= (100)::numeric))))
);


--
-- Name: TABLE auxiliary_energy_profiles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.auxiliary_energy_profiles IS 'Spec 09 §1.5: STATIONARY auxiliary load (never a per-tonne-km factor) — "a 72-hour climate-controlled airport hold for a museum loan can exceed the flight leg''s own emissions". src/lib/spec09/auxiliary-energy.mjs computes kWh consumed = kw_draw * duty_cycle * hours_typical; converting that to gCO2e requires grid_intensity_source, which this table names but does not itself carry a value for.';


--
-- Name: COLUMN auxiliary_energy_profiles.node_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auxiliary_energy_profiles.node_id IS 'entities(entity_id), kind expected = node. Not DB-enforced. Nullable per spec text.';


--
-- Name: COLUMN auxiliary_energy_profiles.setpoint_c; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auxiliary_energy_profiles.setpoint_c IS 'e.g. 21±1°C for a real museum loan condition. No CHECK range: a valid setpoint spans far below zero (pharma cold chain) to well above ambient (some industrial holds).';


--
-- Name: COLUMN auxiliary_energy_profiles.org_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.auxiliary_energy_profiles.org_id IS 'organizations(id) — the uploading customer org. NOT NULL (migration 311). RLS-enforced via user_belongs_to_org(org_id).';


--
-- Name: brief_apply_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brief_apply_runs (
    run_id text NOT NULL,
    mode text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    bytes_read bigint DEFAULT 0 NOT NULL,
    items_applied integer DEFAULT 0 NOT NULL,
    stop_reason text,
    CONSTRAINT brief_apply_runs_mode_check CHECK ((mode = ANY (ARRAY['dry'::text, 'apply'::text])))
);


--
-- Name: TABLE brief_apply_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.brief_apply_runs IS 'One row per apply-record-briefs.mjs run (dry or apply), written at start and updated in the driver''s own finally block. Read by the pre-flight cooldown check (scripts/turns/io-preflight.mjs) before the next apply run starts. D32, defect-fix-plan-2026-09-12.md, lane L21.';


--
-- Name: bulk_imports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bulk_imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    imported_by uuid NOT NULL,
    format text NOT NULL,
    total_rows integer NOT NULL,
    sources_inserted integer DEFAULT 0 NOT NULL,
    provisional_inserted integer DEFAULT 0 NOT NULL,
    rejected integer DEFAULT 0 NOT NULL,
    raw_input text NOT NULL,
    preview_summary jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bulk_imports_format_check CHECK ((format = ANY (ARRAY['csv'::text, 'json'::text])))
);


--
-- Name: TABLE bulk_imports; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bulk_imports IS 'W2.A: Audit log for /api/admin/sources/bulk-import. One row per applied (non-dryRun) call. preview_summary captures the per-row outcome the route returned to the caller.';


--
-- Name: canonical_source_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canonical_source_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    intelligence_item_id uuid NOT NULL,
    current_source_id uuid,
    current_source_url text,
    issue_classification text NOT NULL,
    candidate_url text NOT NULL,
    candidate_title text,
    candidate_publisher text,
    confidence text NOT NULL,
    rationale text,
    verified boolean DEFAULT false NOT NULL,
    verified_status_code integer,
    verified_content_excerpt text,
    reviewed boolean DEFAULT false NOT NULL,
    decision text DEFAULT 'pending'::text NOT NULL,
    reviewer_id uuid,
    reviewed_at timestamp with time zone,
    reviewer_notes text,
    promoted_to_source_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    recommended_classification jsonb,
    CONSTRAINT canonical_source_candidates_confidence_check CHECK ((confidence = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text]))),
    CONSTRAINT canonical_source_candidates_decision_check CHECK ((decision = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'deferred'::text]))),
    CONSTRAINT canonical_source_candidates_issue_classification_check CHECK ((issue_classification = ANY (ARRAY['stale_url'::text, 'missing_link'::text, 'missing_source'::text, 'thin_match'::text])))
);


--
-- Name: TABLE canonical_source_candidates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.canonical_source_candidates IS 'Canonical-source discovery candidates. RLS-gated to platform admins via profiles.is_platform_admin (migration 342, fixing migration 043''s org_memberships-based gate). Service role bypasses for the discovery worker.';


--
-- Name: COLUMN canonical_source_candidates.issue_classification; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.canonical_source_candidates.issue_classification IS 'Why this item needed discovery. stale_url: source_id present but URL returns 4xx/5xx. missing_link: no source_id but item topic implies a known authoritative source should exist. missing_source: no source_id and no obvious canonical source in the registry. thin_match: source_id present, URL works, but content is institutional homepage rather than item-specific (e.g., regulator landing page instead of the regulation page).';


--
-- Name: COLUMN canonical_source_candidates.confidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.canonical_source_candidates.confidence IS 'Discovery agent self-rated confidence. high = exact-name match against authoritative publisher. medium = strong topic match against likely-authoritative publisher. low = best guess; reviewer should verify carefully.';


--
-- Name: COLUMN canonical_source_candidates.recommended_classification; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.canonical_source_candidates.recommended_classification IS 'Cached Haiku classification for the approve-flow new-source insert. Schema: { tier:1-7, domains:int[], jurisdictions:str[], transport_modes:str[], topic_tags:str[], rationale, model, computed_at }. Populated on first reviewer expansion of a candidate whose URL is not already in the sources registry.';


--
-- Name: census_worklist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.census_worklist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    document_url text NOT NULL,
    lane text NOT NULL,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    shape_class text,
    enumeration_status text DEFAULT 'discovered'::text NOT NULL,
    cap_hit boolean DEFAULT false NOT NULL,
    dryrun_disposition text,
    hold_reason text,
    surface_tags text[] DEFAULT '{}'::text[] NOT NULL,
    instrument_identifier text,
    resolved_into_id uuid,
    flagged_reason text,
    flagged_at timestamp with time zone,
    notes text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    identity_checked_at timestamp with time zone,
    identity_http_status integer,
    identity_resolves boolean,
    identity_scheme text,
    identity_shape_valid boolean,
    identity_host_registered boolean,
    title text,
    title_source text,
    is_archived boolean DEFAULT false NOT NULL,
    archive_reason text,
    CONSTRAINT census_worklist_check CHECK (((flagged_reason IS NULL) = (flagged_at IS NULL))),
    CONSTRAINT census_worklist_check1 CHECK (((dryrun_disposition = 'hold'::text) = (hold_reason IS NOT NULL))),
    CONSTRAINT census_worklist_dryrun_disposition_check CHECK ((dryrun_disposition = ANY (ARRAY['would_mint'::text, 'dedup_hit'::text, 'congruence_reject'::text, 'invariant_reject'::text, 'hold'::text]))),
    CONSTRAINT census_worklist_enumeration_status_check CHECK ((enumeration_status = ANY (ARRAY['discovered'::text, 'classified'::text, 'dry_run_complete'::text, 'reconciled'::text, 'flagged'::text]))),
    CONSTRAINT census_worklist_identity_scheme_check CHECK (((identity_scheme IS NULL) OR (identity_scheme = ANY (ARRAY['celex'::text, 'eli'::text, 'uk-legislation'::text, 'generic'::text, 'none'::text])))),
    CONSTRAINT census_worklist_lane_check CHECK ((lane = ANY (ARRAY['A'::text, 'C'::text]))),
    CONSTRAINT census_worklist_shape_class_check CHECK ((shape_class = ANY (ARRAY['instrument_page'::text, 'index_page'::text, 'pdf_direct'::text, 'feed_entry'::text, 'unknown'::text]))),
    CONSTRAINT census_worklist_surface_tags_check CHECK ((surface_tags <@ ARRAY['regulations'::text, 'operations'::text, 'market_intel'::text, 'research'::text]))
);


--
-- Name: TABLE census_worklist; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.census_worklist IS 'Full-corpus gap census data layer (operator dispatch 2026-07-19). One row per (source, document) a census enumeration pass has seen, not yet a corpus item. Sessions A (intake) and C (discovery) produce rows; Session B owns the table + standing dedup/rollup/flag-back duties. Append-only (no DELETE); enumeration_status transitions guarded forward-only. Lease discipline via the existing mutation_leases table (mig 211), keyed on census_worklist.id.';


--
-- Name: COLUMN census_worklist.shape_class; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.census_worklist.shape_class IS 'Structural shape at discovery time, distinct from the eventual item_type/format classification: instrument_page (single document) | index_page (hub/register/portal listing many documents) | pdf_direct | feed_entry | unknown.';


--
-- Name: COLUMN census_worklist.cap_hit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.census_worklist.cap_hit IS 'True when the producing lane stopped this source''s enumeration at its per-source cap, a signal that more documents on this source may exist beyond what the census captured. Rolled up per-source in the gap-census report.';


--
-- Name: COLUMN census_worklist.dryrun_disposition; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.census_worklist.dryrun_disposition IS 'The mint chokepoint dryRun verdict on this document (mintIntelligenceItem dryRun:true, per F6/mint-dryrun-equivalence): would_mint | dedup_hit | congruence_reject | invariant_reject | hold (see hold_reason). NULL = not yet dry-run evaluated.';


--
-- Name: COLUMN census_worklist.surface_tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.census_worklist.surface_tags IS 'Multi-tag: which of the four machine-addressable customer surfaces this document could serve (regulations/operations/market_intel/research). Community is excluded by design, human-operated, outside machine intake (caros-ledge-platform-intent).';


--
-- Name: COLUMN census_worklist.resolved_into_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.census_worklist.resolved_into_id IS 'Cross-source dedup (Task 2 standing duty): set when the same instrument was enumerated at two registers and matchExistingSubject-style resolution collapses this row into the canonical one. NULL = not deduped / this row is canonical.';


--
-- Name: COLUMN census_worklist.flagged_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.census_worklist.flagged_reason IS 'Set when a malformed or incomplete row is flagged back to the producing lane''s queue (never silently fixed by a different lane). Paired with flagged_at; enumeration_status moves to ''flagged'' at the same time.';


--
-- Name: COLUMN census_worklist.identity_resolves; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.census_worklist.identity_resolves IS 'B1 identity axis: TRUE only on a confirmed 2xx/3xx from a free-fetch probe; FALSE only on a confirmed 4xx/5xx; NULL = could-not-confirm (timeout/rate-limit/network) — never fabricate a dead verdict from our own throttling. Identity-verified (index-prominent) requires identity_resolves=true AND identity_host_registered=true.';


--
-- Name: COLUMN census_worklist.identity_host_registered; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.census_worklist.identity_host_registered IS 'B1 identity axis: the document_url host matches a registered sources row (the pointer lives on a source we monitor). Deterministic; set by the identity-resolve pass.';


--
-- Name: COLUMN census_worklist.title; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.census_worklist.title IS 'B1/P1 human-readable instrument title, durably persisted (the prior enrichment pass wrote titles only to gitignored scratch — the not-persisted finding). Populated by scripts/coverage/persist-titles.mjs from the free-path capture (EUR-Lex Cellar SPARQL expression_title + legislation.gov.uk dc:title), $0. NULL = not yet enriched (residual re-capture worklist); the Coverage panel falls back to the notes descriptor, never ships a bare identifier once enrichment completes.';


--
-- Name: COLUMN census_worklist.title_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.census_worklist.title_source IS 'Provenance of title: eurlex-cellar | uk-legislation | notes-descriptor | null. Audit of which free path produced the title.';


--
-- Name: COLUMN census_worklist.is_archived; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.census_worklist.is_archived IS 'Terminal, reversible archive flag — orthogonal to dryrun_disposition and enumeration_status (migration 221''s two existing lifecycles). Set by scripts/maintenance/census-off-vertical.mjs''s `arg=archive` apply path (ruling R-A) for would_mint rows the shared relevance screen (scripts/mint/lib/screen-verdict.mjs, via export-census-rows.mjs''s partitionByScreen) calls off_vertical. Every live reader of the would_mint pool excludes is_archived=true rows (see migration 308''s header for the exact call sites updated in the same commit). Default FALSE for every existing and future row until an archive apply runs; reversible by a future guarded UPDATE back to FALSE (no rows are ever deleted — census_worklist is APPEND-ONLY, migration 221).';


--
-- Name: COLUMN census_worklist.archive_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.census_worklist.archive_reason IS 'Free text (not CHECK''d — mirrors intelligence_items.archive_reason, migration 004), paired with is_archived. This lane''s one live value is ''off_vertical'' (ruling R-A), set by scripts/maintenance/census-off-vertical.mjs via scripts/lib/db.mjs''s table-generic archivePatch().';


--
-- Name: coverage_gap_census_findings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coverage_gap_census_findings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    lane text DEFAULT 'C'::text NOT NULL,
    sweep text NOT NULL,
    subject_type text NOT NULL,
    subject_ref text NOT NULL,
    instrument text NOT NULL,
    jurisdiction text,
    url text,
    fetch_method text NOT NULL,
    fetch_result text,
    four_contract_classification jsonb,
    dry_run_disposition text NOT NULL,
    dry_run_reason text,
    entity_confirmed boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    pending_dependency text,
    historical_evidence text,
    historical_intent text,
    auth_gate text,
    operator_confirm_question text,
    lens text,
    CONSTRAINT coverage_gap_census_findings_dry_run_disposition_check CHECK ((dry_run_disposition = ANY (ARRAY['would_mint'::text, 'would_decline'::text, 'would_park'::text, 'browser_required_undetermined'::text, 'not_applicable'::text, 'operator_confirm'::text]))),
    CONSTRAINT coverage_gap_census_findings_fetch_method_check CHECK ((fetch_method = ANY (ARRAY['plain_http'::text, 'api'::text, 'feed_xml'::text, 'browser_required'::text, 'not_applicable'::text]))),
    CONSTRAINT coverage_gap_census_findings_lens_check CHECK (((lens IS NULL) OR (lens = ANY (ARRAY['freight_native'::text, 'esg_finance'::text])))),
    CONSTRAINT coverage_gap_census_findings_pending_dependency_check CHECK ((pending_dependency = ANY (ARRAY['session_a_chrome_render'::text, 'session_a_register_walk'::text]))),
    CONSTRAINT coverage_gap_census_findings_subject_type_check CHECK ((subject_type = ANY (ARRAY['existing_feed'::text, 'candidate_source'::text, 'candidate_catalog'::text, 'lost_historical_provider'::text]))),
    CONSTRAINT coverage_gap_census_findings_sweep_check CHECK ((sweep = ANY (ARRAY['sweep1_existing_feed_audit'::text, 'sweep2_adjacent_universes'::text, 'sweep3_research_feedstock'::text, 'sweep4_found_then_lost_recovery'::text])))
);


--
-- Name: TABLE coverage_gap_census_findings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.coverage_gap_census_findings IS 'Session C discovery-lane census artifact (2026-07-19 mandate). NOT the corpus: zero staged_updates rows, zero intelligence_items, zero source registrations. Records what already-held free feeds, adjacent enumerable universes, and Research feedstock catalogs actually carry, classified against the four surface contracts, with a dryRun (predictive, non-binding) disposition. Distinct from coverage_gap_candidates (new-instrument acquisition pricing) and from disposition/surface_test there (real operator-ruled outcomes). Retroactively captured into a committed migration by Session B (mig 222) as a precondition for the rollup-view stitch; authorship and ownership stay with Session C.';


--
-- Name: COLUMN coverage_gap_census_findings.pending_dependency; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.coverage_gap_census_findings.pending_dependency IS 'Operator-ruled visibility marker (2026-07-19): non-NULL means this row''s finding is provisional pending Session A''s queue. session_a_chrome_render = genuine fetch-light block (403/404/timeout/cert/SPA-shell). session_a_register_walk = page reachable but real content is one hop deeper behind a register/portal index (B2 register-walk territory, not raw rendering). NULL = resolved this pass, no A-dependency.';


--
-- Name: COLUMN coverage_gap_census_findings.historical_evidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.coverage_gap_census_findings.historical_evidence IS 'Sweep 4 only: the archaeology trail for a lost_historical_provider row -- which repo artifact named it, when, and what was said/ruled (source-map, existence-check, session log, seed file, disposition_ledger).';


--
-- Name: COLUMN coverage_gap_census_findings.operator_confirm_question; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.coverage_gap_census_findings.operator_confirm_question IS 'Sweep 4 only: the one-line question for a dry_run_disposition=operator_confirm row (a signup likely exists but only the operator can confirm). Batched into the audit report, never asked piecemeal.';


--
-- Name: census_rollup_by_surface; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.census_rollup_by_surface WITH (security_invoker='on') AS
 WITH b_rows AS (
         SELECT cw.id,
            cw.dryrun_disposition,
            s.surface
           FROM (public.census_worklist cw
             CROSS JOIN LATERAL unnest(cw.surface_tags) s(surface))
        ), b_tally AS (
         SELECT b_rows.surface,
            count(*) AS enumerated_held_sources,
            count(*) FILTER (WHERE (b_rows.dryrun_disposition = 'dedup_hit'::text)) AS held,
            count(*) FILTER (WHERE (b_rows.dryrun_disposition = 'would_mint'::text)) AS missing_from_held_sources,
            count(*) FILTER (WHERE (b_rows.dryrun_disposition = ANY (ARRAY['congruence_reject'::text, 'invariant_reject'::text, 'hold'::text]))) AS other_dispositioned_held_sources,
            count(*) FILTER (WHERE (b_rows.dryrun_disposition IS NULL)) AS undispositioned_held_sources
           FROM b_rows
          GROUP BY b_rows.surface
        ), c_rows AS (
         SELECT f.id,
            f.dry_run_disposition,
            f.pending_dependency,
            kv.key AS surface
           FROM (public.coverage_gap_census_findings f
             CROSS JOIN LATERAL jsonb_each(COALESCE(f.four_contract_classification, '{}'::jsonb)) kv(key, value))
          WHERE ((kv.value ->> 'verdict'::text) = 'IN'::text)
        ), c_tally AS (
         SELECT c_rows.surface,
            count(*) AS enumerated_world,
            count(*) FILTER (WHERE ((c_rows.dry_run_disposition = 'would_mint'::text) AND (c_rows.pending_dependency IS NULL))) AS missing_from_world,
            count(*) FILTER (WHERE (c_rows.pending_dependency IS NOT NULL)) AS pending_on_session_a,
            count(*) FILTER (WHERE ((c_rows.dry_run_disposition = ANY (ARRAY['would_decline'::text, 'would_park'::text, 'not_applicable'::text])) AND (c_rows.pending_dependency IS NULL))) AS declined_or_parked_world
           FROM c_rows
          GROUP BY c_rows.surface
        ), surfaces AS (
         SELECT unnest(ARRAY['regulations'::text, 'operations'::text, 'market_intel'::text, 'research'::text]) AS surface
        )
 SELECT surfaces.surface,
    COALESCE(b_tally.enumerated_held_sources, (0)::bigint) AS enumerated_held_sources,
    COALESCE(b_tally.held, (0)::bigint) AS held,
    COALESCE(b_tally.missing_from_held_sources, (0)::bigint) AS missing_from_held_sources,
    COALESCE(b_tally.other_dispositioned_held_sources, (0)::bigint) AS other_dispositioned_held_sources,
    COALESCE(b_tally.undispositioned_held_sources, (0)::bigint) AS undispositioned_held_sources,
    COALESCE(c_tally.enumerated_world, (0)::bigint) AS enumerated_world,
    COALESCE(c_tally.missing_from_world, (0)::bigint) AS missing_from_world,
    COALESCE(c_tally.pending_on_session_a, (0)::bigint) AS pending_on_session_a,
    COALESCE(c_tally.declined_or_parked_world, (0)::bigint) AS declined_or_parked_world
   FROM ((surfaces
     LEFT JOIN b_tally ON ((b_tally.surface = surfaces.surface)))
     LEFT JOIN c_tally ON ((c_tally.surface = surfaces.surface)))
  ORDER BY surfaces.surface;


--
-- Name: VIEW census_rollup_by_surface; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.census_rollup_by_surface IS 'Per-surface census rollup (Session B, 2026-07-19), the stitch between census_worklist (documents inside already-held sources) and coverage_gap_census_findings (candidate sources not yet held). Never merged by FK, a structural grain mismatch per Session C''s schema-stitch review. held/missing_from_held_sources read from census_worklist; missing_from_world/pending_on_session_a read from coverage_gap_census_findings, pending_on_session_a carried as its own visible count, never folded into missing_from_world. other_dispositioned_held_sources/undispositioned_held_sources/declined_or_parked_world are honest residual buckets, no silent caps. Feeds docs/census/gap-census-2026-07.md, Rollup tallies, Per surface.';


--
-- Name: claim_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.claim_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    current_claim_id uuid,
    intelligence_item_id uuid NOT NULL,
    section_row_id uuid,
    claim_text text,
    claim_kind text,
    source_span text,
    source_id uuid,
    search_result_id uuid,
    source_tier_at_grounding integer,
    mint_hold_reason text,
    version_number integer DEFAULT 1 NOT NULL,
    supersede_reason text NOT NULL,
    inaccuracy_proof jsonb,
    superseded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    note text,
    CONSTRAINT claim_versions_proof_required CHECK (((supersede_reason = ANY (ARRAY['changed'::text, 'superseded_by_record_briefs'::text])) OR (inaccuracy_proof IS NOT NULL))),
    CONSTRAINT claim_versions_supersede_reason_chk CHECK ((supersede_reason = ANY (ARRAY['changed'::text, 'proven_inaccurate'::text, 'orphaned_no_prose_referent'::text, 'superseded_by_record_briefs'::text])))
);


--
-- Name: TABLE claim_versions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.claim_versions IS 'Preserved claim history (non-destructive grounding doctrine 2026-07-16). Append-only. current_claim_id / intelligence_item_id are SOFT refs (no cascading FK) so history survives current-row/item deletion. supersede_reason = changed (old state before a re-attribution) | proven_inaccurate (final state + proof of a cross-instrument/contradicted erase) | orphaned_no_prose_referent (final state + proof of a functionless claim whose text is verbatim-absent from every section prose). The three exits + relabel-to-ANALYSIS (stays live) are the ONLY sanctioned live-ledger dispositions.';


--
-- Name: COLUMN claim_versions.note; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.claim_versions.note IS 'Free-text context for a version row -- e.g. the record-briefs batch id for supersede_reason=''superseded_by_record_briefs'' (migration 321, D29). Null for every other reason.';


--
-- Name: community_group_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_group_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    inviter_user_id uuid,
    invitee_user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT community_group_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'revoked'::text])))
);


--
-- Name: TABLE community_group_invitations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.community_group_invitations IS 'Pending invites from group admins to prospective members. Status transitions: pending -> accepted | declined (by invitee) or pending -> revoked (by admin). Acceptance does NOT auto-insert a row in community_group_members; the application code performs that insert.';


--
-- Name: community_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_group_members (
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    starred boolean DEFAULT false NOT NULL,
    muted boolean DEFAULT false NOT NULL,
    CONSTRAINT community_group_members_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'moderator'::text, 'member'::text])))
);


--
-- Name: TABLE community_group_members; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.community_group_members IS 'Membership in community_groups. Phase C is explicit-only: every row is inserted by an admin (or service role on group creation). No auto-join or auto-domain logic exists.';


--
-- Name: community_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    region text NOT NULL,
    privacy text NOT NULL,
    owner_user_id uuid NOT NULL,
    description text,
    member_count integer DEFAULT 0 NOT NULL,
    weekly_post_count integer DEFAULT 0 NOT NULL,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    vertical text,
    CONSTRAINT community_groups_privacy_check CHECK ((privacy = ANY (ARRAY['public'::text, 'private'::text]))),
    CONSTRAINT community_groups_region_check CHECK ((region = ANY (ARRAY['EU'::text, 'UK'::text, 'US'::text, 'LATAM'::text, 'APAC'::text, 'HK'::text, 'MEA'::text, 'GLOBAL'::text])))
);


--
-- Name: TABLE community_groups; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.community_groups IS 'Top-level community discussion container. Phase C ships with public and private groups only; workplace tier and join policies are deferred.';


--
-- Name: COLUMN community_groups.owner_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.community_groups.owner_user_id IS 'Original creator. ON DELETE SET NULL preserves the group when the owner is deleted; remaining admins continue to manage it.';


--
-- Name: COLUMN community_groups.member_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.community_groups.member_count IS 'Cached member count. Maintained by trigger on community_group_members (see migration 029).';


--
-- Name: COLUMN community_groups.weekly_post_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.community_groups.weekly_post_count IS 'Count of community_posts rows (top-level + replies) created in the trailing 7 days. Written by update_community_post_reply_count() on every post insert/delete (migration 190); exact as of the group''s most recent post write — repairable any time via scripts/_wave-alpha/recount-community-counters.mjs.';


--
-- Name: COLUMN community_groups.vertical; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.community_groups.vertical IS 'Cargo vertical (canonical sector id from ALL_SECTORS, e.g. fine-art, live-events, automotive) for a member-created cross-regional vertical GROUP. NULL for the 7 canonical regional ROOMS. No CHECK — validated at the application layer so the sector taxonomy can grow without a migration (matches vertical_tags posture, migration 007).';


--
-- Name: community_member_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_member_profiles (
    user_id uuid NOT NULL,
    org_type text NOT NULL,
    role text,
    sector text,
    region text,
    organisation_key text,
    verified boolean DEFAULT false NOT NULL,
    verified_at timestamp with time zone,
    verification_method text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    default_anonymous boolean DEFAULT false NOT NULL,
    CONSTRAINT community_member_profiles_org_type_check CHECK ((org_type = ANY (ARRAY['forwarder'::text, 'carrier'::text, 'shipper'::text, 'customs-broker'::text, '3pl'::text, 'regulator'::text, 'ngo'::text, 'analyst'::text, 'other'::text]))),
    CONSTRAINT community_member_profiles_region_check CHECK (((region IS NULL) OR (region = ANY (ARRAY['EU'::text, 'UK'::text, 'US'::text, 'LATAM'::text, 'APAC'::text, 'HK'::text, 'MEA'::text, 'GLOBAL'::text])))),
    CONSTRAINT community_member_profiles_verification_method_check CHECK (((verification_method IS NULL) OR (verification_method = ANY (ARRAY['corporate-email'::text, 'linkedin'::text, 'write-in'::text])))),
    CONSTRAINT community_member_profiles_verified_has_method CHECK (((verified = false) OR ((verified_at IS NOT NULL) AND (verification_method IS NOT NULL) AND (organisation_key IS NOT NULL))))
);


--
-- Name: TABLE community_member_profiles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.community_member_profiles IS 'Spec 05 §2: verified backing, displayed pseudonymity. Deliberately carries NO name, email or company — org_type/role/sector/region/verified only. "The platform knows exactly who you are. The room does not." Never SELECT * this table into a client response; read through src/lib/community/identity.mjs projectAuthorIdentity() so the allowlist projection is the ONE place that decision is enforced in code, even though this table structurally cannot leak a name.';


--
-- Name: COLUMN community_member_profiles.sector; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.community_member_profiles.sector IS 'Canonical sector id from ALL_SECTORS (src/lib/constants.ts). No CHECK — the sector taxonomy grows without a migration, matching community_groups.vertical (migration 155).';


--
-- Name: COLUMN community_member_profiles.default_anonymous; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.community_member_profiles.default_anonymous IS 'R8.7 amendment (spec 07 Community, 2026-09-25): the member''s account-wide default for the per-post community_posts.anonymous flag, applied by POST /api/community/posts when a post does not explicitly set `anonymous`. Self-service via PUT /api/community/profile (sanitizeMemberWrite, profile-policy.mjs), same self-service posture as org_type/role/sector/region, never verification-sensitive, so it carries no RLS or REVOKE exception beyond migration 293''s existing community_member_profiles_update_own policy (self row only).';


--
-- Name: community_post_signoff_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_post_signoff_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    post_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    verifier_id uuid,
    primary_doc_url text,
    decision_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_at timestamp with time zone,
    CONSTRAINT community_post_signoff_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'signed_off'::text, 'declined'::text, 'withdrawn'::text])))
);


--
-- Name: community_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    parent_post_id uuid,
    author_user_id uuid,
    title text,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_reply_at timestamp with time zone,
    reply_count integer DEFAULT 0 NOT NULL,
    promoted_from_post_id uuid,
    attribution text,
    referenced_intelligence_item_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    signed_off_at timestamp with time zone,
    signed_off_by uuid,
    anonymous boolean DEFAULT false NOT NULL,
    CONSTRAINT community_posts_attribution_check CHECK (((attribution IS NULL) OR (attribution = ANY (ARRAY['editorial'::text, 'original-author'::text, 'anonymous'::text])))),
    CONSTRAINT community_posts_title_shape CHECK ((((parent_post_id IS NULL) AND (title IS NOT NULL)) OR ((parent_post_id IS NOT NULL) AND (title IS NULL))))
);


--
-- Name: TABLE community_posts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.community_posts IS 'Posts and replies in community groups. Self-referential via parent_post_id. Top-level posts have a title; replies do not.';


--
-- Name: COLUMN community_posts.promoted_from_post_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.community_posts.promoted_from_post_id IS 'Set when this post was created via the promote-to-public flow (a private-group post republished into a public group). The original post is preserved; this copy carries attribution metadata.';


--
-- Name: COLUMN community_posts.attribution; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.community_posts.attribution IS 'Attribution mode for promoted posts. NULL on regular posts. One of editorial (Caro''s Ledge editorial team), original-author (preserve name), or anonymous (strip name).';


--
-- Name: COLUMN community_posts.referenced_intelligence_item_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.community_posts.referenced_intelligence_item_ids IS 'UUIDs of intelligence_items this post references (Q5, 2026-05-24). Populated by post-compose parser when user mentions @reg:X or pastes an intel URL. Reverse lookup via GIN index powers the Peer Discussion panel on intelligence detail pages.';


--
-- Name: COLUMN community_posts.anonymous; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.community_posts.anonymous IS 'R8.7 amendment (spec 07 Community, 2026-09-25): per-post anonymity opt-in. false (default) shows the author''s identity per the new identity-by-default rule; true withholds it, the author-identity projection (identity.mjs) omits name/company but STILL carries the verified-member marker when the author is verified. Set by the caller on POST /api/community/posts, defaulting to the author''s own community_member_profiles.default_anonymous when not explicitly supplied.';


--
-- Name: community_thread_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_thread_entities (
    thread_id uuid NOT NULL,
    entity_id text NOT NULL,
    entity_kind public.entity_kind,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE community_thread_entities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.community_thread_entities IS 'Spec 05 §5 component 2 / §6 acceptance criterion 6: every community thread binds to at least one spine entity (corridor, jurisdiction, instrument, technology, organisation — migration 282''s entity_kind). Cardinality (>=1 per top-level thread) is enforced by the guard-enforced route (POST /api/community/posts), not a DB trigger — see this migration''s header for why. Only top-level posts (community_posts.parent_post_id IS NULL) are expected to carry a row here; a reply binds through its parent thread.';


--
-- Name: community_topic_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_topic_groups (
    topic_id uuid NOT NULL,
    group_id uuid NOT NULL
);


--
-- Name: TABLE community_topic_groups; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.community_topic_groups IS 'Junction: which groups belong to which user-defined topic. RLS is enforced via ownership of the parent community_topics row.';


--
-- Name: community_topics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_topics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE community_topics; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.community_topics IS 'Per-user sidebar groupings (personal labels for sets of groups). Private to the owner; do not affect group membership or visibility.';


--
-- Name: connection_theme_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connection_theme_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    args jsonb DEFAULT '{}'::jsonb NOT NULL,
    nodes_read integer,
    edges_read integer,
    nodes_clustered integer,
    edges_used integer,
    themes_written integer,
    gaps_flagged integer,
    rounds integer,
    error_message text,
    theme_delta jsonb,
    CONSTRAINT connection_theme_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'ok'::text, 'error'::text])))
);


--
-- Name: TABLE connection_theme_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.connection_theme_runs IS 'Append-only ledger: one row per analyze-corpus.mjs invocation (flywheel U2). started/finished + full counts, so every pass is auditable (rule 15 — the runs ledger is the execution record, not the code that cites it).';


--
-- Name: COLUMN connection_theme_runs.args; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.connection_theme_runs.args IS 'The CLI args the pass ran with (threshold, limit, dry, etc.) — the reproducibility record.';


--
-- Name: COLUMN connection_theme_runs.theme_delta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.connection_theme_runs.theme_delta IS 'Structured theme-set diff for THIS run (src/lib/connections/theme-delta.mjs diffThemes output: persisted/renamed/split/merged/dissolved/appeared + summary counts), computed against the PRIOR connection_themes contents before this run''s guardedDelete-all replaced them. NULL for any run that predates this column (their digest, if computed, was recorded inside that row''s own args.theme_delta — a historical shape this migration does not backfill). Populated going forward by scripts/connections/analyze-corpus.mjs; `args` reverts to holding only the CLI args it is documented (migration 253) to hold.';


--
-- Name: connection_themes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.connection_themes (
    id uuid NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    member_ids uuid[] NOT NULL,
    dominant_signals jsonb DEFAULT '[]'::jsonb NOT NULL,
    surfaces text[] DEFAULT '{}'::text[] NOT NULL,
    density real NOT NULL,
    convergence real NOT NULL,
    pivots jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT connection_themes_member_ids_check CHECK ((array_length(member_ids, 1) >= 2))
);


--
-- Name: TABLE connection_themes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.connection_themes IS 'Cache of the last connection-cluster pass (flywheel U1/U2). Fully replaced every analyze-corpus run — not append-only. See connection_theme_runs for the audit trail.';


--
-- Name: COLUMN connection_themes.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.connection_themes.id IS 'The theme''s natural anchor: cluster.mjs sets this to the lexicographically smallest member id. Stable across reruns on a stable corpus (fixpoint guarantee) — gaps.mjs keys coverage_gap subject_ref off this.';


--
-- Name: COLUMN connection_themes.member_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.connection_themes.member_ids IS 'intelligence_items.id[] belonging to this theme, F4-basic ordered (date ascending, undated last) by cluster.mjs.';


--
-- Name: COLUMN connection_themes.dominant_signals; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.connection_themes.dominant_signals IS 'Array of {signal, weight} aggregated from intra-theme edge basis (cluster.mjs), strongest first.';


--
-- Name: COLUMN connection_themes.pivots; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.connection_themes.pivots IS 'Array of {id, centrality} — top members by weighted-degree centrality (F2, cluster.mjs).';


--
-- Name: corpus_census; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.corpus_census (
    intelligence_item_id uuid NOT NULL,
    is_archived boolean,
    provenance_status text,
    archive_reason text,
    census_class text,
    haiku_verdict text,
    haiku_confidence integer,
    haiku_rationale text,
    classified_by text,
    classified_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE corpus_census; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.corpus_census IS 'Total-corpus census (operator ruling 2026-07-16). One row per item. Live = provenance_status. Archived = Haiku verdict verifying the archive_reason (archive_correct | review_valuable). Input to the archive endgame; read-only classification, no item mutations.';


--
-- Name: corpus_turn_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.corpus_turn_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    intelligence_item_id uuid NOT NULL,
    reason text NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    consumed_at timestamp with time zone,
    consumed_by text,
    CONSTRAINT corpus_turn_requests_consumed_pair_check CHECK (((consumed_at IS NULL) = (consumed_by IS NULL))),
    CONSTRAINT corpus_turn_requests_reason_check CHECK ((reason = ANY (ARRAY['inserted'::text, 'verified'::text, 'unarchived'::text, 'updated'::text, 'tags_applied'::text, 'manual'::text])))
);


--
-- Name: TABLE corpus_turn_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.corpus_turn_requests IS 'One row per "this item needs a flywheel turn" ticket. Written mechanically by enqueue_corpus_turn_request() (this migration''s trigger on intelligence_items) for every producer that writes provenance_status/is_archived/the three tag columns outside the in-app rule-16 chokepoints (mint-item.ts, apply-staged-update.ts), plus reason=''manual'' rows from the admin "Request corpus turn" action. Consumed by scripts/turns/consume-turn-requests.mjs, which the corpus-turn GitHub Actions workflow (a sibling lane) runs to feed discover-for-items --ids. NULL consumed_at = still open.';


--
-- Name: COLUMN corpus_turn_requests.reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.corpus_turn_requests.reason IS 'inserted (new mint) | verified (provenance_status flipped to verified) | unarchived (is_archived true->false) | tags_applied (operational_scenario_tags/compliance_object_tags/topic_tags changed) | updated (an OF-listed column was touched without matching one of the above precisely) | manual (operator-requested via the admin route — the only value the trigger itself never writes).';


--
-- Name: COLUMN corpus_turn_requests.consumed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.corpus_turn_requests.consumed_at IS 'NULL = open (awaiting a turn). Stamped by consume-turn-requests.mjs --mark-consumed, never by this table''s own trigger.';


--
-- Name: COLUMN corpus_turn_requests.consumed_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.corpus_turn_requests.consumed_by IS 'Free-text label for whatever consumed this request (e.g. a corpus-turn workflow run id, an operator handle). NULL exactly when consumed_at is NULL (corpus_turn_requests_consumed_pair_check).';


--
-- Name: coverage_gap_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coverage_gap_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rank integer,
    instrument text NOT NULL,
    jurisdiction text NOT NULL,
    primary_vertical text,
    transport_mode text,
    freight_relevance text NOT NULL,
    estimated_priority text NOT NULL,
    coverage_class text NOT NULL,
    corpus_match_ref text,
    sizing_class text NOT NULL,
    entity_confirmed boolean DEFAULT false NOT NULL,
    authoritative_url text,
    notes text,
    created_by text DEFAULT 'session-c-coverage-discovery-2026-07-17'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    data_class text DEFAULT 'instrument'::text NOT NULL,
    discovery_class text,
    disposition text,
    surface_test jsonb,
    access_model text,
    CONSTRAINT coverage_gap_candidates_access_model_check CHECK ((access_model = ANY (ARRAY['free'::text, 'licensed'::text, 'mixed'::text, 'not_applicable'::text]))),
    CONSTRAINT coverage_gap_candidates_coverage_class_check CHECK ((coverage_class = ANY (ARRAY['MISSING'::text, 'AMBIGUOUS_ARCHIVED'::text, 'HAVE_QUARANTINED'::text]))),
    CONSTRAINT coverage_gap_candidates_data_class_check CHECK ((data_class = ANY (ARRAY['instrument'::text, 'data_feed'::text, 'tracker'::text]))),
    CONSTRAINT coverage_gap_candidates_discovery_class_check CHECK ((discovery_class = ANY (ARRAY['labor_cost_feed'::text, 'energy_price_feed'::text, 'commercial_fuel_assessment'::text, 'state_subnational_tracker'::text, 'compliance_reporting_portal'::text, 'enforcement_verification_system'::text, 'lca_disclosure_verification'::text, 'market_intel_source'::text, 'research_horizon_source'::text, 'vertical_operational_standard'::text]))),
    CONSTRAINT coverage_gap_candidates_disposition_check CHECK (((disposition IS NULL) OR (disposition = ANY (ARRAY['kept'::text, 'declined'::text, 'parked'::text])))),
    CONSTRAINT coverage_gap_candidates_estimated_priority_check CHECK ((estimated_priority = ANY (ARRAY['CRITICAL'::text, 'HIGH'::text, 'MODERATE'::text, 'LOW'::text]))),
    CONSTRAINT coverage_gap_candidates_sizing_class_check CHECK ((sizing_class = ANY (ARRAY['major'::text, 'minor'::text]))),
    CONSTRAINT coverage_gap_candidates_surface_test_required_check CHECK (((disposition IS NULL) OR (disposition = 'kept'::text) OR ((surface_test IS NOT NULL) AND (surface_test ?& ARRAY['regulations'::text, 'operations'::text, 'market_intel'::text, 'research'::text, 'community'::text]) AND (COALESCE(length((surface_test #>> '{regulations,verdict}'::text[])), 0) > 0) AND (COALESCE(length((surface_test #>> '{regulations,reason}'::text[])), 0) > 0) AND (COALESCE(length((surface_test #>> '{operations,verdict}'::text[])), 0) > 0) AND (COALESCE(length((surface_test #>> '{operations,reason}'::text[])), 0) > 0) AND (COALESCE(length((surface_test #>> '{market_intel,verdict}'::text[])), 0) > 0) AND (COALESCE(length((surface_test #>> '{market_intel,reason}'::text[])), 0) > 0) AND (COALESCE(length((surface_test #>> '{research,verdict}'::text[])), 0) > 0) AND (COALESCE(length((surface_test #>> '{research,reason}'::text[])), 0) > 0) AND (COALESCE(length((surface_test #>> '{community,verdict}'::text[])), 0) > 0) AND (COALESCE(length((surface_test #>> '{community,reason}'::text[])), 0) > 0))))
);


--
-- Name: TABLE coverage_gap_candidates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.coverage_gap_candidates IS 'Coverage-floor pricing input (Session C, 2026-07-17). Ranked genuine-absence candidates for the 60->400 expansion. NOT a worklist; not corpus items. Cross-checked against the live corpus via the HAVE/HAVE_QUARANTINED/AMBIGUOUS_ARCHIVED/MISSING evidence hierarchy.';


--
-- Name: COLUMN coverage_gap_candidates.data_class; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.coverage_gap_candidates.data_class IS 'instrument = regulatory/policy instrument (the original table scope, MISSING/AMBIGUOUS_ARCHIVED/HAVE_QUARANTINED against the corpus). data_feed = a live numeric/API data source serving Operations or Market Intel surface content, NOT a corpus regulatory item. A data_feed row implies a SEPARATE feed-intake architecture (API attestation: feed, series, query, retrieval_timestamp, value) that NEVER mints a FACT claim in section_claim_provenance -- a second intake door alongside the regulatory grounding pipeline, named as a post-drain build unit, not scoped or built by this table.';


--
-- Name: COLUMN coverage_gap_candidates.discovery_class; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.coverage_gap_candidates.discovery_class IS 'Which of the 9 operator-defined coverage classes (Gemini-review-driven category expansion, 2026-07-17) this row belongs to. NULL for rows from the original single-pass discovery job (ranks 1-22) and the pre-category Gemini delta (ranks 23-28), which predate this categorization. Distinct from coverage_class (the MISSING/AMBIGUOUS_ARCHIVED/HAVE_QUARANTINED evidence hierarchy) -- do not conflate the two.';


--
-- Name: COLUMN coverage_gap_candidates.disposition; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.coverage_gap_candidates.disposition IS 'kept = accepted as a real coverage gap. declined = rejected (not a genuine gap, or out of scope). parked = deferred pending an operator decision (scope, spend, or product). NULL = no disposition decision made yet (the default state for rows from the original discovery passes). Per operator ruling 2026-07-17: no backfill on existing rows -- this column is DORMANT until a row is actually dispositioned.';


--
-- Name: COLUMN coverage_gap_candidates.surface_test; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.coverage_gap_candidates.surface_test IS 'Five-surface scope test, required when disposition IN (declined, parked): {"regulations":{"verdict":"IN|OUT|CONDITIONAL","reason":"..."}, "operations":{...}, "market_intel":{...}, "research":{...}, "community":{...}}. SSOT for the JSON shape is scripts/verify/surface-contract-gate.golden.mjs PART A (caros-ledge-platform-intent skill). The DB CHECK is the mechanical twin of that golden -- no decline/park can land in this table without every surface accounted for.';


--
-- Name: COLUMN coverage_gap_candidates.access_model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.coverage_gap_candidates.access_model IS 'free = primary/feed is free-fetchable or free-integrable. licensed = paid, requires an operator spend/license decision before acquisition. mixed = partially free / partially paid (e.g. free subnational disclosure, paid corporate tier). not_applicable = Class 6 PRODUCT-DECISION rows where spend is not the relevant axis. Backfilled once from freight_relevance text at migration time (rule-based, individually verified on the 2 pattern exceptions); new rows should set this explicitly going forward, not rely on future backfills.';


--
-- Name: coverage_gaps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coverage_gaps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    jurisdiction text,
    sector_affinity text[] DEFAULT '{}'::text[] NOT NULL,
    severity text NOT NULL,
    description text NOT NULL,
    suggested_action_label text NOT NULL,
    suggested_action_href text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coverage_gaps_severity_check CHECK ((severity = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])))
);


--
-- Name: data_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.data_sources (
    source_key text NOT NULL,
    name text NOT NULL,
    redistribution text NOT NULL,
    embeddable boolean NOT NULL,
    licence text,
    attribution text,
    url text,
    verified_on date,
    blocker text,
    ask_who text,
    ask_what text,
    substitute text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT data_sources_embeddable_matches_verdict CHECK ((embeddable = (redistribution = 'permitted'::text))),
    CONSTRAINT data_sources_redistribution_check CHECK ((redistribution = ANY (ARRAY['permitted'::text, 'conditional'::text, 'unverified'::text, 'prohibited'::text])))
);


--
-- Name: TABLE data_sources; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.data_sources IS 'Licence verdicts per data source. Generated from src/lib/contracts/source-licence.mjs. Unregistered sources fail closed: absence from this table means NOT embeddable, never unknown.';


--
-- Name: derivation_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.derivation_edges (
    from_table text NOT NULL,
    from_pk text NOT NULL,
    to_value_id uuid NOT NULL,
    edge_kind text DEFAULT 'input'::text NOT NULL,
    to_table text DEFAULT 'derived_values'::text NOT NULL,
    CONSTRAINT derivation_edges_from_table_allowed CHECK ((from_table = ANY (ARRAY['emission_factors'::text, 'market_series'::text, 'regional_data_facts'::text, 'derived_values'::text, 'statutory_computations'::text, 'estimated_values'::text, 'state_cost_facts'::text, 'inference_records'::text]))),
    CONSTRAINT derivation_edges_to_table_allowed CHECK ((to_table = ANY (ARRAY['derived_values'::text, 'inference_records'::text])))
);


--
-- Name: TABLE derivation_edges; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.derivation_edges IS 'The invalidation DAG (spec 08 §2.2 Part 2): one row per (input, derived value) dependency, one row per registerDerivedValue() call per declared input (register-derivation.ts writes this table AND derived_values.inputs from the SAME caller-supplied list — see that column''s comment). from_table is a closed allowlist (derivation_edges_from_table_allowed) mirroring entity_refs_ref_table_allowed''s posture (migration 283): widen deliberately, in a reviewed migration, never by inference. invalidate_dependents() (below) walks this table; propagation_events.(table_name,row_pk) (migration 284) addresses an input in the IDENTICAL shape, so the walk''s seed step is a plain equality join. RLS ENABLED, no anon/authenticated policy (migration 330, SEC-1 fix): every reader/writer is the service-role client (src/lib/propagation/), which bypasses RLS by role membership; there is no customer- or admin-surface reader of this table.';


--
-- Name: COLUMN derivation_edges.to_value_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.derivation_edges.to_value_id IS 'The target row''s own PK (derived_values.value_id or inference_records.inference_id, per to_table). No FK as of migration 339 (polymorphic target); validity is enforced by the two RPC write paths.';


--
-- Name: COLUMN derivation_edges.edge_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.derivation_edges.edge_kind IS '''input'' (the only value this lane writes) for a value genuinely computed FROM the referenced row. Open text, not a closed CHECK beyond the one default: a future edge kind (e.g. a weaker "informed_by" relation that should NOT propagate staleness) can be added without a schema change.';


--
-- Name: COLUMN derivation_edges.to_table; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.derivation_edges.to_table IS 'The target-node table this edge points into (derived_values or inference_records, migration 339). Generic address, no FK, same closed-allowlist posture from_table/from_pk already use (migration 285); the two legal writers (register_derived_value(), register_inference_record()) keep to_value_id valid.';


--
-- Name: derived_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.derived_values (
    value_id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id text,
    method_id text NOT NULL,
    method_version text NOT NULL,
    value numeric,
    value_low numeric,
    value_high numeric,
    unit text,
    currency text,
    derivation text NOT NULL,
    origin_class text NOT NULL,
    lifecycle text NOT NULL,
    admissibility text NOT NULL,
    base_confidence numeric NOT NULL,
    asserted_at timestamp with time zone NOT NULL,
    half_life_days integer,
    inputs jsonb NOT NULL,
    supersedes uuid,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    computed_by text NOT NULL,
    invalidated_at timestamp with time zone,
    invalidated_by_event bigint,
    CONSTRAINT derived_values_admissibility_check CHECK ((admissibility = ANY (ARRAY['display_only'::text, 'analysis_ok'::text, 'calculation_ok'::text, 'filing_ok'::text, 'stale'::text]))),
    CONSTRAINT derived_values_base_confidence_check CHECK (((base_confidence >= (0)::numeric) AND (base_confidence <= (1)::numeric))),
    CONSTRAINT derived_values_derivation_check CHECK ((derivation = ANY (ARRAY['statutory_fixed'::text, 'statutory_formula'::text, 'observed'::text, 'transacted_index'::text, 'assessed'::text, 'calculated'::text, 'interpolated'::text, 'modelled'::text, 'estimated'::text]))),
    CONSTRAINT derived_values_half_life_days_check CHECK (((half_life_days IS NULL) OR (half_life_days > 0))),
    CONSTRAINT derived_values_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['emerging'::text, 'strengthening'::text, 'corroborated'::text, 'verified'::text, 'stalled'::text, 'falsified'::text, 'superseded'::text, 'obsolete'::text]))),
    CONSTRAINT derived_values_not_self_superseded CHECK (((supersedes IS NULL) OR (supersedes <> value_id))),
    CONSTRAINT derived_values_origin_class_check CHECK ((origin_class = ANY (ARRAY['community'::text, 'community-corroborated'::text, 'modelled'::text, 'derived'::text, 'partner'::text, 'verified'::text, 'official'::text]))),
    CONSTRAINT derived_values_range_ordered CHECK (((value_low IS NULL) OR (value_high IS NULL) OR (value_low <= value_high))),
    CONSTRAINT derived_values_value_brackets CHECK (((value IS NULL) OR (value_low IS NULL) OR (value_high IS NULL) OR ((value >= value_low) AND (value <= value_high))))
);


--
-- Name: TABLE derived_values; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.derived_values IS 'One row per computed value (spec 08 §2.2 Part 2, §3). Append-mostly: a recompute inserts a NEW row pointing supersedes at the prior one; the prior row is retained for the audit trail (spec §2.2 Part 3). Read ONLY through derived_values_admissible below (spec §3.3''s second enforcement point) or through admissibleFor() (src/lib/propagation/admissible-for.ts) — never directly; F31 fails CI on a direct read outside src/lib/propagation/.';


--
-- Name: COLUMN derived_values.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.derived_values.entity_id IS 'The entity this value is ABOUT, when it has one addressable subject (nullable — a corridor carbon-cost figure may have no single entity.entity_id subject yet).';


--
-- Name: COLUMN derived_values.admissibility; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.derived_values.admissibility IS '''stale'' is set ONLY by the governed drain (invalidate_dependents(), never a trigger — spec §2.2: "propagation invalidates, it does not compute"). The other four values describe what a FRESH value may be used for (spec §3.1''s admissibility axis) and are set at write time by registerDerivedValue/the recomputing method, never derived automatically from lifecycle (the two axes are orthogonal by design).';


--
-- Name: COLUMN derived_values.half_life_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.derived_values.half_life_days IS 'NULL means NO DECAY (spec §3.2: statutory text has half-life infinity). Consumed by effective_confidence() below — a NULL here makes that function return base_confidence unchanged regardless of age.';


--
-- Name: COLUMN derived_values.inputs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.derived_values.inputs IS 'jsonb array of {"table": "...", "pk": "...", "version": "..."} — the InputRef shape (types.ts). This is the DECLARED input list a caller supplies to registerDerivedValue(); derivation_edges (below) is the SAME information, normalised into queryable rows by register-derivation.ts in the same write. The two must never disagree — register-derivation.ts derives derivation_edges FROM inputs in one write, never independently.';


--
-- Name: derived_values_admissible; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.derived_values_admissible WITH (security_invoker='on') AS
 SELECT d.value_id,
    d.entity_id,
    d.method_id,
    d.method_version,
    d.value,
    d.value_low,
    d.value_high,
    d.unit,
    d.currency,
    d.derivation,
    d.origin_class,
    d.lifecycle,
    d.admissibility,
    d.base_confidence,
    d.asserted_at,
    d.half_life_days,
    d.inputs,
    d.supersedes,
    d.computed_at,
    d.computed_by,
    d.invalidated_at,
    d.invalidated_by_event,
    public.effective_confidence(d.base_confidence, d.asserted_at, d.half_life_days, now()) AS effective_confidence
   FROM public.derived_values d
  WHERE ((d.lifecycle <> ALL (ARRAY['falsified'::text, 'obsolete'::text])) AND (d.admissibility <> 'stale'::text));


--
-- Name: VIEW derived_values_admissible; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.derived_values_admissible IS 'Spec 08 §3.3''s second enforcement point ("RLS denies SELECT on the raw table... granting it only on a view that has already applied the gate"). Hides stale/falsified/obsolete rows and pre-computes effective_confidence so a caller never re-derives the decay formula. Deliberately NOT security_invoker, which is what lets a role with no direct grant on derived_values still read through this view.';


--
-- Name: disposition_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.disposition_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    intelligence_item_id uuid,
    item_key text,
    canonical_instrument_key text,
    title text,
    source_url text,
    archive_reason text,
    disposition text NOT NULL,
    merged_into_item_id uuid,
    snapshot_pointer text,
    disposition_by text,
    disposition_date timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE disposition_ledger; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.disposition_ledger IS 'Tombstone ledger (operator amendment 2026-07-16). Permanent identity record of every archived item DELETED to reach zero-archived. Append-only, no FK. Written BEFORE the guarded delete. Queryable by canonical_instrument_key.';


--
-- Name: emission_factors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emission_factors (
    factor_id uuid DEFAULT gen_random_uuid() NOT NULL,
    tier text NOT NULL,
    scope_kind text NOT NULL,
    mode text NOT NULL,
    vehicle_class text,
    energy_carrier text,
    jurisdiction text,
    grid_region text,
    operator_key text,
    corridor_id text,
    movement_ref text,
    quantity_basis text NOT NULL,
    wtt_co2e numeric,
    ttw_co2e numeric,
    wtw_co2e numeric,
    co2_fossil numeric,
    co2_biogenic numeric,
    ch4 numeric,
    n2o numeric,
    gwp_basis text NOT NULL,
    load_factor_pct numeric,
    empty_running_pct numeric,
    source_key text NOT NULL,
    source_ref text,
    donor text,
    n_observations integer,
    derivation text NOT NULL,
    origin_class text NOT NULL,
    pedigree smallint NOT NULL,
    pedigree_reliability smallint,
    pedigree_completeness smallint,
    pedigree_temporal_correlation smallint,
    pedigree_geographical_correlation smallint,
    pedigree_technological_correlation smallint,
    method_version text NOT NULL,
    as_at_date date NOT NULL,
    valid_from date NOT NULL,
    valid_to date,
    superseded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT emission_factors_ch4_check CHECK ((ch4 >= (0)::numeric)),
    CONSTRAINT emission_factors_co2_biogenic_check CHECK ((co2_biogenic >= (0)::numeric)),
    CONSTRAINT emission_factors_co2_fossil_check CHECK ((co2_fossil >= (0)::numeric)),
    CONSTRAINT emission_factors_corridor_id_check CHECK (((corridor_id IS NULL) OR (corridor_id ~ '^cl:corridor:[0-9a-f]{16}$'::text))),
    CONSTRAINT emission_factors_derivation_check CHECK ((derivation = ANY (ARRAY['statutory_fixed'::text, 'statutory_formula'::text, 'observed'::text, 'transacted_index'::text, 'assessed'::text, 'calculated'::text, 'interpolated'::text, 'modelled'::text, 'estimated'::text]))),
    CONSTRAINT emission_factors_empty_running_pct_check CHECK (((empty_running_pct >= (0)::numeric) AND (empty_running_pct < (100)::numeric))),
    CONSTRAINT emission_factors_gwp_basis CHECK ((gwp_basis = ANY (ARRAY['AR4_GWP100'::text, 'AR5_GWP100'::text, 'AR6_GWP100'::text, 'AR6_GWP20'::text, 'unstated'::text]))),
    CONSTRAINT emission_factors_has_a_number CHECK ((num_nonnulls(wtt_co2e, ttw_co2e, wtw_co2e) >= 1)),
    CONSTRAINT emission_factors_load_factor_pct_check CHECK (((load_factor_pct > (0)::numeric) AND (load_factor_pct <= (100)::numeric))),
    CONSTRAINT emission_factors_mode CHECK ((mode = ANY (ARRAY['road'::text, 'rail'::text, 'ocean'::text, 'inland_waterway'::text, 'air'::text]))),
    CONSTRAINT emission_factors_n2o_check CHECK ((n2o >= (0)::numeric)),
    CONSTRAINT emission_factors_n_observations_check CHECK ((n_observations > 0)),
    CONSTRAINT emission_factors_not_self_superseded CHECK (((superseded_by IS NULL) OR (superseded_by <> factor_id))),
    CONSTRAINT emission_factors_origin_class_check CHECK ((origin_class = ANY (ARRAY['community'::text, 'community-corroborated'::text, 'modelled'::text, 'derived'::text, 'partner'::text, 'verified'::text, 'official'::text]))),
    CONSTRAINT emission_factors_pedigree_check CHECK (((pedigree >= 1) AND (pedigree <= 5))),
    CONSTRAINT emission_factors_pedigree_completeness_check CHECK (((pedigree_completeness >= 1) AND (pedigree_completeness <= 5))),
    CONSTRAINT emission_factors_pedigree_floor CHECK ((((tier = 'carrier_primary'::text) AND (pedigree >= 1)) OR ((tier = 'verified_operator_avg'::text) AND (pedigree >= 2)) OR ((tier = 'programme_lane_avg'::text) AND (pedigree >= 2)) OR ((tier = 'modal_default'::text) AND (pedigree >= 3)) OR ((tier = 'proxy_estimate'::text) AND (pedigree >= 4)))),
    CONSTRAINT emission_factors_pedigree_geographical_correlation_check CHECK (((pedigree_geographical_correlation >= 1) AND (pedigree_geographical_correlation <= 5))),
    CONSTRAINT emission_factors_pedigree_reliability_check CHECK (((pedigree_reliability >= 1) AND (pedigree_reliability <= 5))),
    CONSTRAINT emission_factors_pedigree_technological_correlation_check CHECK (((pedigree_technological_correlation >= 1) AND (pedigree_technological_correlation <= 5))),
    CONSTRAINT emission_factors_pedigree_temporal_correlation_check CHECK (((pedigree_temporal_correlation >= 1) AND (pedigree_temporal_correlation <= 5))),
    CONSTRAINT emission_factors_proxy_needs_donor CHECK (((tier <> 'proxy_estimate'::text) OR (donor IS NOT NULL))),
    CONSTRAINT emission_factors_quantity_basis CHECK ((quantity_basis = ANY (ARRAY['tonne_km'::text, 'vehicle_km'::text, 'teu_km'::text, 'tonne'::text, 'litre'::text, 'kg'::text, 'kwh'::text, 'mj'::text]))),
    CONSTRAINT emission_factors_scope_carrier_lane CHECK (((scope_kind <> 'carrier_lane'::text) OR ((operator_key IS NOT NULL) AND (corridor_id IS NOT NULL) AND (movement_ref IS NULL)))),
    CONSTRAINT emission_factors_scope_kind CHECK ((scope_kind = ANY (ARRAY['movement'::text, 'carrier_lane'::text, 'operator_lane'::text, 'modal'::text]))),
    CONSTRAINT emission_factors_scope_modal CHECK (((scope_kind <> 'modal'::text) OR ((vehicle_class IS NOT NULL) AND (energy_carrier IS NOT NULL) AND (jurisdiction IS NOT NULL) AND (operator_key IS NULL) AND (corridor_id IS NULL) AND (movement_ref IS NULL)))),
    CONSTRAINT emission_factors_scope_movement CHECK (((scope_kind <> 'movement'::text) OR (movement_ref IS NOT NULL))),
    CONSTRAINT emission_factors_scope_operator_lane CHECK (((scope_kind <> 'operator_lane'::text) OR ((operator_key IS NOT NULL) AND (movement_ref IS NULL)))),
    CONSTRAINT emission_factors_tier CHECK ((tier = ANY (ARRAY['carrier_primary'::text, 'verified_operator_avg'::text, 'programme_lane_avg'::text, 'modal_default'::text, 'proxy_estimate'::text]))),
    CONSTRAINT emission_factors_ttw_co2e_check CHECK ((ttw_co2e >= (0)::numeric)),
    CONSTRAINT emission_factors_valid_window CHECK (((valid_to IS NULL) OR (valid_to > valid_from))),
    CONSTRAINT emission_factors_wtt_co2e_check CHECK ((wtt_co2e >= (0)::numeric)),
    CONSTRAINT emission_factors_wtw_co2e_check CHECK ((wtw_co2e >= (0)::numeric)),
    CONSTRAINT emission_factors_wtw_decomposition CHECK (((wtt_co2e IS NULL) OR (ttw_co2e IS NULL) OR (wtw_co2e IS NULL) OR (abs((wtw_co2e - (wtt_co2e + ttw_co2e))) <= (0.000000001 * GREATEST(wtw_co2e, (1)::numeric)))))
);


--
-- Name: TABLE emission_factors; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.emission_factors IS 'Emission factors across five tiers and four scope kinds. Append-only: correct by inserting a new row and setting superseded_by, never by editing a factor a served number was computed from.';


--
-- Name: licence_clear_sources; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.licence_clear_sources WITH (security_invoker='on') AS
 SELECT data_sources.source_key,
    data_sources.name,
    data_sources.attribution,
    data_sources.licence,
    data_sources.url,
    data_sources.verified_on
   FROM public.data_sources
  WHERE (data_sources.embeddable IS TRUE);


--
-- Name: VIEW licence_clear_sources; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.licence_clear_sources IS 'Sources we may lawfully embed and re-serve. The database half of the licence gate; src/lib/contracts/source-licence.mjs is the application half, and both derive from one register.';


--
-- Name: emission_factor_candidates; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.emission_factor_candidates WITH (security_invoker='on') AS
 SELECT f.factor_id,
    f.tier,
    f.scope_kind,
    f.mode,
    f.vehicle_class,
    f.energy_carrier,
    f.jurisdiction,
    f.grid_region,
    f.operator_key,
    f.corridor_id,
    f.movement_ref,
    f.quantity_basis,
    f.wtt_co2e,
    f.ttw_co2e,
    f.wtw_co2e,
    f.co2_fossil,
    f.co2_biogenic,
    f.ch4,
    f.n2o,
    f.gwp_basis,
    f.load_factor_pct,
    f.empty_running_pct,
    f.source_key,
    f.source_ref,
    f.donor,
    f.n_observations,
    f.derivation,
    f.origin_class,
    f.pedigree,
    f.pedigree_reliability,
    f.pedigree_completeness,
    f.pedigree_temporal_correlation,
    f.pedigree_geographical_correlation,
    f.pedigree_technological_correlation,
    f.method_version,
    f.as_at_date,
    f.valid_from,
    f.valid_to,
    f.superseded_by,
    f.created_at,
        CASE f.tier
            WHEN 'carrier_primary'::text THEN 1
            WHEN 'verified_operator_avg'::text THEN 2
            WHEN 'programme_lane_avg'::text THEN 3
            WHEN 'modal_default'::text THEN 4
            WHEN 'proxy_estimate'::text THEN 5
            ELSE NULL::integer
        END AS tier_rank,
        CASE f.scope_kind
            WHEN 'movement'::text THEN 1
            WHEN 'carrier_lane'::text THEN 2
            WHEN 'operator_lane'::text THEN 3
            WHEN 'modal'::text THEN 4
            ELSE NULL::integer
        END AS scope_specificity
   FROM public.emission_factors f
  WHERE ((f.superseded_by IS NULL) AND (f.as_at_date <= CURRENT_DATE) AND (f.source_key IN ( SELECT licence_clear_sources.source_key
           FROM public.licence_clear_sources)));


--
-- Name: VIEW emission_factor_candidates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.emission_factor_candidates IS 'Licence-clear, in-window, non-superseded factors decorated with tier_rank and scope_specificity. Eligibility only. resolveActiveFactor() in src/lib/contracts/factor-tier.mjs picks the winner.';


--
-- Name: entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entities (
    entity_id text NOT NULL,
    kind public.entity_kind NOT NULL,
    canonical_name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    merged_into text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    display_name text,
    entity_level text,
    CONSTRAINT entities_entity_level_organisation_only CHECK (((entity_level IS NULL) OR (kind = 'organisation'::public.entity_kind))),
    CONSTRAINT entities_entity_level_values CHECK (((entity_level IS NULL) OR (entity_level = ANY (ARRAY['group'::text, 'legal_entity'::text, 'operating_identity'::text])))),
    CONSTRAINT entities_status_check CHECK ((status = ANY (ARRAY['active'::text, 'merged'::text, 'retired'::text]))),
    CONSTRAINT id_matches_kind CHECK ((entity_id ~~ (('cl:'::text || (kind)::text) || ':%'::text))),
    CONSTRAINT merged_has_target CHECK (((status = 'merged'::text) = (merged_into IS NOT NULL)))
);


--
-- Name: TABLE entities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entities IS 'The entity spine (spec 08 §1.1): one row per real-world thing, permanent id, never reused. Minted by entityId() in src/lib/entities/entity-id.mjs — never hand-assembled at a call site. Deletes are forbidden by convention (no DELETE RLS policy is ever intended for this table); an entity leaves circulation via `status=''retired''` or `status=''merged''`+`merged_into`, so an old id 301s at read time rather than 404ing (spec §1.3 rule 3).';


--
-- Name: COLUMN entities.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entities.entity_id IS 'cl:<kind>:<16 lowercase hex>, minted by entityId(kind, seed) in src/lib/entities/entity-id.mjs. Deterministic from a normalized seed per kind — two independent callers mint the SAME id with zero coordination, which is what makes the backfill idempotent.';


--
-- Name: COLUMN entities.merged_into; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entities.merged_into IS 'Tombstone target when status=''merged''. A reader resolving an old id follows this to the live id — 301, never 404 (spec §1.3 rule 3). NULL for every other status.';


--
-- Name: COLUMN entities.display_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entities.display_name IS 'Optional human-readable label, distinct from canonical_name (the identity SEED string an entity''s id was minted from — see migration 282). NULL until a kind-specific backfill writes one; every reader (src/lib/entities/corridor-scope.ts''s listCorridorScopes()) falls back to composing a label live from canonical_name when this is NULL, so the column landing ahead of its backfill is never a regression. For kind=''corridor'', written by scripts/entities/seed-corridors.mjs (the corridor producer) via src/lib/entities/unlocode-names.mjs''s formatCorridorLabel() — one writer per row, same as every other progressive-re-keying column in this schema (ADR-024 §5).';


--
-- Name: COLUMN entities.entity_level; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entities.entity_level IS 'Spec 00 section 1.3 rule 1: which level of the composite/atomic hierarchy this organisation is: group, legal_entity (the LEI-bearing entity) or operating_identity (for example a carrier SCAC). NULL for every non-organisation kind (CHECK) and NULL where the level is not recorded: a level is set by the seed where known and never guessed. Screens state it through entityLevelLabel() in src/lib/entities/resolve.mjs.';


--
-- Name: entity_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_aliases (
    entity_id text NOT NULL,
    alias text NOT NULL,
    alias_kind text NOT NULL,
    asserted_by text NOT NULL,
    asserted_at timestamp with time zone DEFAULT now() NOT NULL,
    source_id uuid,
    provenance jsonb,
    CONSTRAINT entity_aliases_alias_values CHECK (((btrim(alias) <> ''::text) AND (alias = btrim(regexp_replace(alias, '\s+'::text, ' '::text, 'g'::text))))),
    CONSTRAINT entity_aliases_asserted_by_present CHECK ((btrim(asserted_by) <> ''::text)),
    CONSTRAINT entity_aliases_kind_values CHECK ((alias_kind = ANY (ARRAY['name'::text, 'short_name'::text, 'former_name'::text, 'ticker'::text, 'scac'::text, 'iata'::text, 'other'::text]))),
    CONSTRAINT entity_aliases_provenance_object CHECK (((provenance IS NULL) OR (jsonb_typeof(provenance) = 'object'::text)))
);


--
-- Name: TABLE entity_aliases; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_aliases IS 'Name aliases of entities with provenance (spec 00 section 1.3 rule 2): who asserted each alias and when. Aliases are evidence, not edits: INSERT-only (an UPDATE, DELETE or TRUNCATE is refused by trigger), a correction is a new row with a later asserted_at, and an alias never overwrites entities.canonical_name. The alias text is stored trimmed with whitespace collapsed (CHECK). Read by resolveEntityByAlias() in src/lib/entities/resolve.mjs. Written by service_role only.';


--
-- Name: COLUMN entity_aliases.alias_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_aliases.alias_kind IS 'name, short_name, former_name, ticker, scac, iata or other. Kinds that coincide with an external identifier scheme (scac, iata) are still aliases here; the validated identifier lives in entity_identifiers.';


--
-- Name: COLUMN entity_aliases.asserted_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_aliases.asserted_by IS 'Provenance on the alias, never overwritten (the shape of entity_identifiers.asserted_by, migration 282): a script path, a rule id or an editor identity.';


--
-- Name: entity_identifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_identifiers (
    entity_id text NOT NULL,
    scheme text NOT NULL,
    value text NOT NULL,
    scheme_version text,
    asserted_by text NOT NULL,
    asserted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE entity_identifiers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_identifiers IS 'Crosswalk to published external identifier standards (spec 08 §1.1). ADOPT, never invent — this is what makes the spine joinable to a customer''s TMS and to third-party feeds already keyed on these schemes. Rows are built by identifierRow() in src/lib/entities/crosswalk.mjs, which validates the value against the scheme''s published format/check-digit rule before returning a row a caller may insert.';


--
-- Name: COLUMN entity_identifiers.asserted_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_identifiers.asserted_by IS 'Provenance on the ALIAS, never overwritten (spec §1.3 rule 2) — who/what asserted this crosswalk mapping (e.g. a script path, an editor identity), distinct from entities.created_at which is the entity''s own provenance.';


--
-- Name: entity_refs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_refs (
    ref_table text NOT NULL,
    ref_id uuid NOT NULL,
    entity_id text NOT NULL,
    role text NOT NULL,
    asserted_by text NOT NULL,
    asserted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_refs_ref_table_allowed CHECK ((ref_table = ANY (ARRAY['intelligence_items'::text, 'regions'::text])))
);


--
-- Name: TABLE entity_refs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_refs IS 'Progressive re-keying (ADR-024): multi-valued entity references (jurisdiction_iso TEXT[] on intelligence_items and regions.iso_codes) as one row per (row, entity, role), beside the text keys they do not replace. Written by scripts/entities/backfill-entities.mjs.';


--
-- Name: entity_relations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_relations (
    parent_entity_id text NOT NULL,
    child_entity_id text NOT NULL,
    relation text NOT NULL,
    asserted_by text NOT NULL,
    asserted_at timestamp with time zone DEFAULT now() NOT NULL,
    source_id uuid,
    provenance jsonb,
    CONSTRAINT entity_relations_asserted_by_present CHECK ((btrim(asserted_by) <> ''::text)),
    CONSTRAINT entity_relations_not_self CHECK ((parent_entity_id <> child_entity_id)),
    CONSTRAINT entity_relations_provenance_object CHECK (((provenance IS NULL) OR (jsonb_typeof(provenance) = 'object'::text))),
    CONSTRAINT entity_relations_relation_values CHECK ((relation = ANY (ARRAY['group_of'::text, 'legal_entity_of'::text, 'operating_identity_of'::text])))
);


--
-- Name: TABLE entity_relations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_relations IS 'Declared relations between organisation entities (spec 00 section 1.3 rule 1): the composite/atomic hierarchy (group, legal entity, operating identity) as separate objects with declared relations, not one fuzzy object. The relation names the CHILD''s role toward the PARENT. No cycles (trigger). Every row says who asserted it and when, with an optional registered source and free-form provenance. Written by service_role only.';


--
-- Name: COLUMN entity_relations.relation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.entity_relations.relation IS 'The child''s role toward the parent: legal_entity_of (child is a legal entity of the parent group), operating_identity_of (child is an operating identity of the parent legal entity), group_of (child is a sub-group of the parent group).';


--
-- Name: entity_scope; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_scope (
    subject_id text NOT NULL,
    scope_id text NOT NULL,
    relation text NOT NULL,
    confidence numeric(3,2),
    attributed_to text NOT NULL
);


--
-- Name: TABLE entity_scope; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.entity_scope IS 'Cross-entity addressability join (spec 08 §1.2) — "the mechanism behind one corridor, five answers". Unpopulated by this lane''s backfill (spec §1.3: v1 scope is corridor/jurisdiction/organisation/instrument/obligation identity itself; the scoping RELATIONS between them are a later build). Schema lands now so a later lane is additive-only against it, never a DDL change riding the same commit as its first writer.';


--
-- Name: error_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.error_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    release text DEFAULT 'dev'::text NOT NULL,
    env text DEFAULT 'unknown'::text NOT NULL,
    side text NOT NULL,
    route text DEFAULT ''::text NOT NULL,
    message text NOT NULL,
    stack_hash text NOT NULL,
    stack_excerpt text,
    user_scope uuid,
    count integer DEFAULT 1 NOT NULL,
    CONSTRAINT error_events_message_check CHECK ((char_length(message) <= 1000)),
    CONSTRAINT error_events_route_check CHECK ((char_length(route) <= 300)),
    CONSTRAINT error_events_side_check CHECK ((side = ANY (ARRAY['server'::text, 'client'::text]))),
    CONSTRAINT error_events_stack_excerpt_check CHECK ((char_length(stack_excerpt) <= 4000)),
    CONSTRAINT error_events_stack_hash_check CHECK ((char_length(stack_hash) <= 64))
);


--
-- Name: estimated_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estimated_values (
    estimate_id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id text NOT NULL,
    scenario_key text DEFAULT 'default'::text NOT NULL,
    model_id text NOT NULL,
    model_version text NOT NULL,
    point numeric,
    low numeric,
    high numeric,
    distribution jsonb,
    pedigree jsonb NOT NULL,
    CONSTRAINT estimate_brackets_point CHECK (((point IS NULL) OR (low IS NULL) OR ((point >= low) AND (point <= high)))),
    CONSTRAINT estimate_has_uncertainty CHECK (((low IS NOT NULL) OR (distribution IS NOT NULL))),
    CONSTRAINT estimate_range_ordered CHECK (((low IS NULL) OR (high IS NULL) OR (low <= high)))
);


--
-- Name: TABLE estimated_values; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.estimated_values IS 'Spec 08 §4 Layer 1: model output, scenario bands, projections. Range-native (estimate_has_uncertainty); a point is the exception. pedigree = the five-axis assurance vocabulary. Surrogate PK + scenario_key per ADR-024 amendment 2026-09-02 (several scenarios per entity). Rendered only through EstimatedFigure as a range (ESTIMATE_DISPLAY = range).';


--
-- Name: funded_pass_runlock; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.funded_pass_runlock (
    lock_key text NOT NULL,
    holder_label text,
    holder_pid integer,
    holder_host text,
    worklist_ref text,
    acquired_at timestamp with time zone DEFAULT now() NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE funded_pass_runlock; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.funded_pass_runlock IS 'Funded-pass run-lock (mig 205). One row per lock_key; heartbeat_at drives the stale-takeover rule. A live holder blocks a second acquisition (acquired=false -> runner exits zero-spend). Prevents the 2026-07-15 concurrent-race that zeroed two items.';


--
-- Name: gate_a_health_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gate_a_health_cache (
    singleton boolean DEFAULT true NOT NULL,
    payload jsonb NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gate_a_health_cache_singleton_check CHECK (singleton)
);


--
-- Name: grid_connection_queues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.grid_connection_queues (
    queue_id uuid DEFAULT gen_random_uuid() NOT NULL,
    jurisdiction_id text NOT NULL,
    dso_name text NOT NULL,
    capacity_band_mw text,
    queue_months_p50 numeric,
    queue_months_p90 numeric,
    as_of date NOT NULL,
    obs_status text DEFAULT 'A'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    substation_ref text,
    substation_name text,
    demand_firm_mw numeric,
    demand_available_mw numeric,
    demand_constraint text,
    demand_constraint_limiting_factor text,
    source_id uuid,
    origin_class text,
    derivation text,
    confidence_admiralty text,
    CONSTRAINT grid_connection_queues_band_or_substation CHECK (((capacity_band_mw IS NOT NULL) OR (substation_ref IS NOT NULL))),
    CONSTRAINT grid_connection_queues_capacity_band_mw_check CHECK ((length(capacity_band_mw) > 0)),
    CONSTRAINT grid_connection_queues_confidence_admiralty_shape CHECK (((confidence_admiralty IS NULL) OR (confidence_admiralty ~ '^[A-F][1-6]$'::text))),
    CONSTRAINT grid_connection_queues_demand_constraint_check CHECK (((demand_constraint IS NULL) OR (demand_constraint = ANY (ARRAY['GREEN'::text, 'AMBER'::text, 'RED'::text])))),
    CONSTRAINT grid_connection_queues_demand_figure_enveloped CHECK ((((demand_firm_mw IS NULL) AND (demand_available_mw IS NULL)) OR ((source_id IS NOT NULL) AND (origin_class IS NOT NULL) AND (derivation IS NOT NULL)))),
    CONSTRAINT grid_connection_queues_demand_firm_nonneg CHECK (((demand_firm_mw IS NULL) OR (demand_firm_mw >= (0)::numeric))),
    CONSTRAINT grid_connection_queues_derivation_check CHECK (((derivation IS NULL) OR (derivation = ANY (ARRAY['statutory_fixed'::text, 'statutory_formula'::text, 'observed'::text, 'transacted_index'::text, 'assessed'::text, 'calculated'::text, 'interpolated'::text, 'modelled'::text, 'estimated'::text])))),
    CONSTRAINT grid_connection_queues_dso_name_check CHECK ((length(dso_name) > 0)),
    CONSTRAINT grid_connection_queues_obs_status_check CHECK ((obs_status = ANY (ARRAY['A'::text, 'P'::text, 'E'::text, 'I'::text, 'F'::text, 'B'::text, 'D'::text, 'U'::text, 'V'::text, 'G'::text, 'M'::text, 'O'::text, 'L'::text, 'H'::text, 'Q'::text, 'N'::text]))),
    CONSTRAINT grid_connection_queues_origin_class_check CHECK (((origin_class IS NULL) OR (origin_class = ANY (ARRAY['community'::text, 'community-corroborated'::text, 'modelled'::text, 'derived'::text, 'partner'::text, 'verified'::text, 'official'::text])))),
    CONSTRAINT grid_connection_queues_percentiles_ordered CHECK (((queue_months_p50 IS NULL) OR (queue_months_p90 IS NULL) OR (queue_months_p90 >= queue_months_p50))),
    CONSTRAINT grid_connection_queues_queue_months_p50_check CHECK (((queue_months_p50 IS NULL) OR (queue_months_p50 >= (0)::numeric))),
    CONSTRAINT grid_connection_queues_queue_months_p90_check CHECK (((queue_months_p90 IS NULL) OR (queue_months_p90 >= (0)::numeric)))
);


--
-- Name: TABLE grid_connection_queues; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.grid_connection_queues IS 'Spec 09 §1.6: the DSO transformer-connection queue — "commonly 24 to 36 months... the binding constraint on electrification". src/lib/spec09/grid-queue.mjs treats this as a GATE (BLOCKED/CLEAR against a decision horizon), never folds it into a €/kWh cost line.';


--
-- Name: COLUMN grid_connection_queues.jurisdiction_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.grid_connection_queues.jurisdiction_id IS 'entities(entity_id), kind expected = jurisdiction. Not DB-enforced.';


--
-- Name: COLUMN grid_connection_queues.capacity_band_mw; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.grid_connection_queues.capacity_band_mw IS 'Connection size band the queue months apply to. NULL for a per-substation headroom row: the publisher states no band and a band is never estimated.';


--
-- Name: COLUMN grid_connection_queues.obs_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.grid_connection_queues.obs_status IS 'SDMX CL_OBS_STATUS (src/lib/contracts/vocabularies.mjs OBS_STATUS), the SAME 16-code vocabulary the rest of this product uses. Default ''A'' (Normal) matches the existing convention (cf. migration 106).';


--
-- Name: COLUMN grid_connection_queues.substation_ref; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.grid_connection_queues.substation_ref IS 'The publisher''s own identifier for the substation row (UK Power Networks heatmap mRID). The stable identity of a per-substation observation; NULL for a migration 297 shape row (a band-level queue observation).';


--
-- Name: COLUMN grid_connection_queues.substation_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.grid_connection_queues.substation_name IS 'The substation name as the publisher states it (e.g. "Aberdeen Pl A 11kV"). NULL for a band-level row.';


--
-- Name: COLUMN grid_connection_queues.demand_firm_mw; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.grid_connection_queues.demand_firm_mw IS 'Firm demand capacity of the substation in MW, as published (observed). NULL when the row does not state it.';


--
-- Name: COLUMN grid_connection_queues.demand_available_mw; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.grid_connection_queues.demand_available_mw IS 'Demand capacity still available at the substation in MW, as published (observed). May be NEGATIVE: the publisher states a deficit for a RED substation, and a deficit is a fact, not an error. This is HEADROOM, not a queue duration.';


--
-- Name: COLUMN grid_connection_queues.demand_constraint; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.grid_connection_queues.demand_constraint IS 'The publisher''s demand constraint indicator for the substation: GREEN, AMBER or RED, verbatim.';


--
-- Name: COLUMN grid_connection_queues.demand_constraint_limiting_factor; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.grid_connection_queues.demand_constraint_limiting_factor IS 'The publisher''s stated limiting factor for the demand constraint (e.g. Thermal, Voltage), verbatim; the publisher''s vocabulary, so no CHECK list.';


--
-- Name: COLUMN grid_connection_queues.source_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.grid_connection_queues.source_id IS 'sources(id): the registered publisher of the figure (rule 18: the figure carries its source''s rating). Required whenever a demand MW figure is present (grid_connection_queues_demand_figure_enveloped).';


--
-- Name: COLUMN grid_connection_queues.origin_class; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.grid_connection_queues.origin_class IS 'Shared ORIGIN_CLASSES vocabulary (src/lib/contracts/vocabularies.mjs), same list as migration 296.';


--
-- Name: COLUMN grid_connection_queues.derivation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.grid_connection_queues.derivation IS 'Shared DERIVATIONS vocabulary (src/lib/contracts/envelope.mjs), same list as migration 296.';


--
-- Name: COLUMN grid_connection_queues.confidence_admiralty; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.grid_connection_queues.confidence_admiralty IS 'Admiralty pair shape (letter A-F, digit 1-6). NULL unless a rating is stated; never estimated.';


--
-- Name: harness_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.harness_runs (
    run_id text NOT NULL,
    harness_family text NOT NULL,
    harness_version text,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    trigger text,
    github_run_id text,
    upstream_run_id text,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    inputs_ref jsonb DEFAULT '[]'::jsonb NOT NULL,
    per_item jsonb DEFAULT '[]'::jsonb NOT NULL,
    metrics jsonb DEFAULT '{}'::jsonb NOT NULL,
    defects_found jsonb DEFAULT '[]'::jsonb NOT NULL,
    full_trace_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_branch text,
    source_artifact_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE harness_runs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.harness_runs IS 'One row per harness-run artifact (fsi-app/scripts/harness-runs/CONVENTION.md), landed by the service-role writer scripts/lib/record-harness-run.mjs (SHARED-WRITER: harness_runs) in place of the old branch-push + gh-pr-create + tracking-issue-520 path (migration 331, lane HARNESS-LANDING, 2026-09-27). RLS ENABLED, no anon/authenticated policy (deny-all): every reader/writer is the service-role client.';


--
-- Name: holdings_quality; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.holdings_quality (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    intelligence_item_id uuid NOT NULL,
    source_id uuid,
    capture_kind text NOT NULL,
    capture_ref uuid,
    bytes_collected bigint DEFAULT 0 NOT NULL,
    clean_content_chars integer,
    declared_size integer,
    completeness text NOT NULL,
    defect_evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    sufficiency text NOT NULL,
    publisher_shape text,
    stale_verified boolean DEFAULT false NOT NULL,
    audited_at timestamp with time zone DEFAULT now() NOT NULL,
    audit_version text NOT NULL,
    CONSTRAINT holdings_quality_capture_kind_check CHECK ((capture_kind = ANY (ARRAY['snapshot'::text, 'pool'::text]))),
    CONSTRAINT holdings_quality_completeness_check CHECK ((completeness = ANY (ARRAY['NO-KNOWN-DEFECT'::text, 'TRUNCATED'::text, 'FURNITURE'::text, 'STUB'::text]))),
    CONSTRAINT holdings_quality_publisher_shape_check CHECK ((publisher_shape = ANY (ARRAY['eur-lex'::text, 'legislation.gov.uk'::text, 'federal-register'::text, 'gazette'::text, 'other'::text]))),
    CONSTRAINT holdings_quality_sufficiency_check CHECK ((sufficiency = ANY (ARRAY['covers_grounding'::text, 'corroborators_only'::text, 'insufficient'::text])))
);


--
-- Name: TABLE holdings_quality; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.holdings_quality IS 'Per-capture holdings-quality audit (2026-07-14). One row per stored capture (snapshot=raw_fetches | pool=agent_run_searches aggregate) behind an item. completeness detects KNOWN DEFECT CLASSES (TRUNCATED/FURNITURE/STUB) and never proves wholeness — NO-KNOWN-DEFECT = no detectable defect, not certified-complete. The integrity guarantee is grounding-side (floor-first truncation moat). This is a re-collection triage index.';


--
-- Name: COLUMN holdings_quality.completeness; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.holdings_quality.completeness IS 'NO-KNOWN-DEFECT (no detectable defect; NOT proof of wholeness) | TRUNCATED (byte-cap/declared-size shortfall) | FURNITURE (chrome/nav dominates, low clean-content ratio) | STUB (JS/error shell, <=1000 bytes).';


--
-- Name: COLUMN holdings_quality.defect_evidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.holdings_quality.defect_evidence IS 'The measures behind the classification: e.g. {"byte_cap":61440,"declared":218000,"ratio":0.28,"checks_fired":["byte_truncation"]}. Records what was detected, not a completeness proof.';


--
-- Name: COLUMN holdings_quality.sufficiency; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.holdings_quality.sufficiency IS 'covers_grounding (a floor-qualifying capture usable to ground facts) | corroborators_only (below the item authority floor; contextualizes) | insufficient (too thin to ground or corroborate).';


--
-- Name: indexation_clauses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.indexation_clauses (
    clause_id uuid DEFAULT gen_random_uuid() NOT NULL,
    contract_ref text,
    corridor_id text,
    index_id text NOT NULL,
    base_value numeric NOT NULL,
    base_date date NOT NULL,
    passthrough_pct numeric NOT NULL,
    cap_pct numeric,
    floor_pct numeric,
    review_cadence text NOT NULL,
    rounding_rule text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    org_id uuid NOT NULL,
    CONSTRAINT indexation_clauses_cap_floor_ordered CHECK (((cap_pct IS NULL) OR (floor_pct IS NULL) OR (floor_pct <= cap_pct))),
    CONSTRAINT indexation_clauses_passthrough_pct_check CHECK (((passthrough_pct >= (0)::numeric) AND (passthrough_pct <= (100)::numeric))),
    CONSTRAINT indexation_clauses_review_cadence_check CHECK ((review_cadence = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'semiannual'::text]))),
    CONSTRAINT indexation_clauses_rounding_rule_check CHECK ((length(rounding_rule) > 0))
);


--
-- Name: TABLE indexation_clauses; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.indexation_clauses IS 'Spec 09 §1.3: dynamic carbon contract indexation MECHANICS AND ARITHMETIC ONLY (spec 09 §5 open decision 2, conservative default) — this table and src/lib/spec09/indexation.mjs never produce drafted clause TEXT. "The product supplies the obligation, the index and the computation; the customer''s counsel supplies the contract".';


--
-- Name: COLUMN indexation_clauses.corridor_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.indexation_clauses.corridor_id IS 'entities(entity_id), kind expected = corridor. Nullable (a contract need not be corridor-specific). Not DB-enforced.';


--
-- Name: COLUMN indexation_clauses.index_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.indexation_clauses.index_id IS 'entities(entity_id), kind expected = instrument (EUA front-Dec, UKA, TTF). Not DB-enforced.';


--
-- Name: COLUMN indexation_clauses.org_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.indexation_clauses.org_id IS 'organizations(id) — the uploading customer org. NOT NULL (migration 311). RLS-enforced via user_belongs_to_org(org_id).';


--
-- Name: inference_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inference_records (
    inference_id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_id text,
    claim_text text NOT NULL,
    status_token text NOT NULL,
    confidence numeric NOT NULL,
    cited_item_ids uuid[] NOT NULL,
    origin_class text NOT NULL,
    supersedes uuid,
    trigger_question_ref text,
    method_id text NOT NULL,
    method_version text NOT NULL,
    admissibility text DEFAULT 'current'::text NOT NULL,
    invalidated_at timestamp with time zone,
    invalidated_by_event bigint,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    computed_by text NOT NULL,
    CONSTRAINT inference_records_admissibility_check CHECK ((admissibility = ANY (ARRAY['current'::text, 'stale'::text]))),
    CONSTRAINT inference_records_cited_item_ids_check CHECK ((cardinality(cited_item_ids) > 0)),
    CONSTRAINT inference_records_claim_text_check CHECK ((length(claim_text) > 0)),
    CONSTRAINT inference_records_confidence_check CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric))),
    CONSTRAINT inference_records_not_self_superseded CHECK (((supersedes IS NULL) OR (supersedes <> inference_id))),
    CONSTRAINT inference_records_origin_class_check CHECK ((origin_class = ANY (ARRAY['derived'::text, 'modelled'::text]))),
    CONSTRAINT inference_records_status_token_check CHECK ((status_token = ANY (ARRAY['CONFIRMED'::text, 'HYPOTHESIS'::text, 'REFUTED'::text])))
);


--
-- Name: TABLE inference_records; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.inference_records IS 'ADR-036 decision 2: the narrative counterpart to derived_values (migration 285), a machine-written inference (status_token + cited_item_ids, never a bare numeric value) with its own append-mostly, never-overwritten-in-place lifecycle (a recompute inserts a NEW row, supersedes points at the prior one). Read through a service-role API route; no client-facing admissible view in this migration.';


--
-- Name: COLUMN inference_records.subject_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inference_records.subject_id IS 'The entity this inference is ABOUT, when it has one addressable subject (nullable, same progressive re-keying posture as derived_values.entity_id, migration 283/ADR-024 decision 5).';


--
-- Name: COLUMN inference_records.status_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inference_records.status_token IS 'Rule 14''s three tokens (CLAUDE.md standing rule 14), mirrored verbatim as this column''s CHECK (constants.mjs''s STATUS_TOKENS is the JS-side copy, hand-kept in sync).';


--
-- Name: COLUMN inference_records.cited_item_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inference_records.cited_item_ids IS 'Never empty (CHECK cardinality > 0), an uncited inference is never written (learning-loop-design-2026-09-25.md section 3).';


--
-- Name: COLUMN inference_records.origin_class; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inference_records.origin_class IS 'Narrower than derived_values.origin_class: derived (a template-question answer) or modelled (a narrative conclusion), NEVER verified for a machine-written inference (ADR-036 decision 2).';


--
-- Name: COLUMN inference_records.method_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inference_records.method_id IS 'The (method_id, method_version) pair drain.ts Pass 2 looks up in INFERENCE_METHODS (methods/infer-from-question.ts). Migration 339 widens invalidate_dependents() so a stale row of THIS table is reached by the same governed drain.';


--
-- Name: COLUMN inference_records.admissibility; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.inference_records.admissibility IS 'Two-state staleness marker (current vs stale). Set to stale ONLY by the governed drain (invalidate_dependents(), migration 339).';


--
-- Name: ingest_rejections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ingest_rejections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    raw_value text NOT NULL,
    rejection_reason text NOT NULL,
    source_url text,
    source_id uuid,
    ingest_attempted_at timestamp with time zone DEFAULT now() NOT NULL,
    triaged_by uuid,
    triaged_at timestamp with time zone,
    triage_action text,
    triage_notes text,
    CONSTRAINT ingest_rejections_triage_consistency CHECK ((((triage_action IS NULL) AND (triaged_by IS NULL) AND (triaged_at IS NULL)) OR ((triage_action IS NOT NULL) AND (triaged_by IS NOT NULL) AND (triaged_at IS NOT NULL)))),
    CONSTRAINT ingest_rejections_valid_reason CHECK ((rejection_reason = ANY (ARRAY['below_granularity'::text, 'non_geographic'::text, 'institutional'::text, 'unparseable'::text]))),
    CONSTRAINT ingest_rejections_valid_triage_action CHECK (((triage_action IS NULL) OR (triage_action = ANY (ARRAY['discarded'::text, 'reclassified'::text, 'escalated'::text]))))
);


--
-- Name: TABLE ingest_rejections; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.ingest_rejections IS 'RC-7 fragment audit log. Each row records one rejected jurisdiction token from an ingest attempt: hydrological features (CARSON_RIVER_WATERSHED), agency names (EPA, MINISTRY OF X), sub-jurisdictional fragments (BIHOR COUNTY), or unparseable strings. Populated by the BEFORE INSERT/UPDATE trigger on intelligence_items per migration 082. Read/Update gated to profiles.is_platform_admin via RLS. No DELETE policy (audit integrity). Phase 7 triage queue reads this for the ingest-rejection tab; operator triages each row to discarded / reclassified / escalated.';


--
-- Name: COLUMN ingest_rejections.rejection_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ingest_rejections.rejection_reason IS 'One of: below_granularity (county/sub-jurisdictional), non_geographic (hydrological/natural features), institutional (agency/ministry/court names), unparseable (default fallback). Set by _classify_jurisdiction_token at the trigger.';


--
-- Name: COLUMN ingest_rejections.triage_action; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ingest_rejections.triage_action IS 'Operator decision: discarded (drop), reclassified (operator-mapped to canonical and item updated), escalated (needs further review). Null while untriaged. Triage_consistency CHECK enforces full triage state when set.';


--
-- Name: institutions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.institutions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    registrable_domain text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE institutions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.institutions IS 'Source grouping/identity dimension (migration 122): WHO published, keyed by registrable_domain (eTLD+1). A GROUPING tag, never a merge key — sources sharing an institution stay distinct sources. Orthogonal to source_role/category.';


--
-- Name: integrity_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integrity_flags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    category text NOT NULL,
    subject_type text NOT NULL,
    subject_ref text NOT NULL,
    description text NOT NULL,
    recommended_actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by text,
    resolution_note text,
    CONSTRAINT integrity_flags_category_check CHECK ((category = ANY (ARRAY['design_drift'::text, 'data_quality'::text, 'source_issue'::text, 'coverage_gap'::text, 'data_integrity'::text, 'surface_concern'::text, 'workflow_gap'::text]))),
    CONSTRAINT integrity_flags_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_review'::text, 'resolved'::text, 'archived'::text]))),
    CONSTRAINT integrity_flags_subject_type_check CHECK ((subject_type = ANY (ARRAY['surface'::text, 'item'::text, 'source'::text, 'jurisdiction'::text, 'system'::text])))
);


--
-- Name: TABLE integrity_flags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.integrity_flags IS 'Platform-level integrity flags — durable queue for agent-detected concerns the dispatch context cannot resolve. Distinct from intelligence_items.agent_integrity_flag* (per-brief flags from migration 035). Agent contract documented in fsi-app/.claude/CLAUDE.md.';


--
-- Name: COLUMN integrity_flags.category; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.integrity_flags.category IS 'design_drift | data_quality | source_issue | coverage_gap | data_integrity | surface_concern';


--
-- Name: COLUMN integrity_flags.subject_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.integrity_flags.subject_type IS 'surface | item | source | jurisdiction | system — the kind of thing subject_ref points at';


--
-- Name: COLUMN integrity_flags.subject_ref; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.integrity_flags.subject_ref IS 'Stable reference to the affected entity: route path for surface, intelligence_items.id or legacy_id for item, sources.id or canonical name for source, ISO code for jurisdiction, free-text component name for system.';


--
-- Name: COLUMN integrity_flags.recommended_actions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.integrity_flags.recommended_actions IS 'jsonb array of {action, rationale} objects. Agent populates with possible resolutions when the dispatch context can choose between them but the agent cannot.';


--
-- Name: COLUMN integrity_flags.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.integrity_flags.status IS 'open → in_review → resolved | archived. Admin updates via /admin Integrity flags surface.';


--
-- Name: COLUMN integrity_flags.created_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.integrity_flags.created_by IS 'Agent identifier: e.g., "wave-4-a5-agent", "wave-5-coverage-investigation". Free-text rather than auth.users FK because the writer is a service-role worker, not an authenticated user.';


--
-- Name: intelligence_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intelligence_changes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    change_type text NOT NULL,
    change_severity text NOT NULL,
    previous_value jsonb,
    new_value jsonb,
    change_summary text,
    raw_diff text,
    CONSTRAINT intelligence_changes_change_severity_check CHECK ((change_severity = ANY (ARRAY['critical'::text, 'significant'::text, 'minor'::text, 'administrative'::text]))),
    CONSTRAINT intelligence_changes_change_type_check CHECK ((change_type = ANY (ARRAY['new'::text, 'status_change'::text, 'deadline_change'::text, 'scope_change'::text, 'penalty_change'::text, 'provision_added'::text, 'provision_amended'::text, 'administrative'::text])))
);


--
-- Name: intelligence_item_citations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intelligence_item_citations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    intelligence_item_id uuid NOT NULL,
    source_id uuid NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    origin text NOT NULL,
    CONSTRAINT intelligence_item_citations_origin_check CHECK ((origin = ANY (ARRAY['sources_used_backfill'::text, 'agent_extraction'::text, 'manual'::text])))
);


--
-- Name: TABLE intelligence_item_citations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.intelligence_item_citations IS 'Q1: brief-to-source edge table parallel to source_citations (source-to-source). Backfilled from intelligence_items.sources_used at migration time (origin=sources_used_backfill). Discovered-source associations (origin=agent_extraction) fill organically when the agent run handler at src/app/api/agent/run/route.ts is updated to write here alongside source_citations and provisional_sources. Manual operator edits use origin=manual. Decisions doc: docs/sprint-2/source-credibility-model-decisions-2026-05-19.md Q1.';


--
-- Name: COLUMN intelligence_item_citations.detected_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_item_citations.detected_at IS 'When the edge was observed. For sources_used_backfill: intelligence_items.created_at. For agent_extraction: now() at agent run write. For manual: now() at operator edit. Consumed by Q6 recency-decay logic in citation-network weight computation.';


--
-- Name: COLUMN intelligence_item_citations.origin; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_item_citations.origin IS 'Provenance tag. sources_used_backfill (migration 089 one-time), agent_extraction (route handler write, pending), manual (operator edit, pending). UNIQUE constraint allows multiple origin tags per (item, source) pair so an agent_extraction row coexists with a prior sources_used_backfill row without conflict; readers dedupe via DISTINCT (intelligence_item_id, source_id).';


--
-- Name: intelligence_item_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intelligence_item_sections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    section_key text NOT NULL,
    section_order integer NOT NULL,
    content_md text NOT NULL,
    is_conditional boolean DEFAULT false NOT NULL,
    source_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE intelligence_item_sections; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.intelligence_item_sections IS 'Structured per-section projection of intelligence_items.full_brief (Q4, 2026-05-24). One row per (item_id, section_key). Powers the 14-section reader on /regulations/[slug] and the 6/8-section readers on other surfaces.';


--
-- Name: COLUMN intelligence_item_sections.section_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_item_sections.section_key IS 'Stable key per section per format. See SKILL.md format-specific section vocabulary.';


--
-- Name: COLUMN intelligence_item_sections.source_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_item_sections.source_ids IS 'UUIDs of sources this section draws on. Powers per-section citation rendering and reverse-citation queries.';


--
-- Name: intelligence_item_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intelligence_item_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    intelligence_item_id uuid NOT NULL,
    version_number integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    previous_version_id uuid,
    full_brief text,
    severity text,
    priority text,
    urgency_tier text,
    format_type text,
    topic_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    operational_scenario_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    compliance_object_tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    related_items jsonb DEFAULT '[]'::jsonb NOT NULL,
    intersection_summary text,
    sources_used uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    last_regenerated_at timestamp with time zone,
    regeneration_skill_version text
);


--
-- Name: TABLE intelligence_item_versions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.intelligence_item_versions IS 'Append-only version history for intelligence_items. One row per UPDATE via trigger. Never UPDATE or DELETE; new rows only.';


--
-- Name: intelligence_items; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intelligence_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    legacy_id text,
    title text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    what_is_it text DEFAULT ''::text NOT NULL,
    why_matters text DEFAULT ''::text NOT NULL,
    key_data text[] DEFAULT '{}'::text[] NOT NULL,
    operational_impact text DEFAULT ''::text NOT NULL,
    open_questions text[] DEFAULT '{}'::text[] NOT NULL,
    tags text[] DEFAULT '{}'::text[] NOT NULL,
    domain integer NOT NULL,
    category text,
    item_type text DEFAULT 'regulation'::text NOT NULL,
    source_id uuid,
    source_url text DEFAULT ''::text NOT NULL,
    jurisdictions text[] DEFAULT '{}'::text[] NOT NULL,
    transport_modes text[] DEFAULT '{}'::text[] NOT NULL,
    verticals text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'monitoring'::text NOT NULL,
    severity text,
    confidence text DEFAULT 'confirmed'::text NOT NULL,
    priority text DEFAULT 'MODERATE'::text NOT NULL,
    reasoning text DEFAULT ''::text NOT NULL,
    entry_into_force date,
    compliance_deadline date,
    next_review_date date,
    added_date date DEFAULT CURRENT_DATE NOT NULL,
    last_verified timestamp with time zone,
    is_archived boolean DEFAULT false NOT NULL,
    archive_reason text,
    archive_note text,
    archived_date date,
    replaced_by uuid,
    version_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    region_tags text[] DEFAULT '{}'::text[],
    topic_tags text[] DEFAULT '{}'::text[],
    vertical_tags text[] DEFAULT '{}'::text[],
    full_brief text,
    urgency_tier text,
    format_type text,
    last_regenerated_at timestamp with time zone,
    regeneration_skill_version text,
    sources_used uuid[] DEFAULT '{}'::uuid[],
    operational_scenario_tags text[] DEFAULT '{}'::text[],
    compliance_object_tags text[] DEFAULT '{}'::text[],
    related_items uuid[] DEFAULT '{}'::uuid[],
    intersection_summary text,
    jurisdiction_iso text[] DEFAULT '{}'::text[],
    agent_integrity_flag boolean DEFAULT false NOT NULL,
    agent_integrity_phrase text,
    agent_integrity_flagged_at timestamp with time zone,
    agent_integrity_resolved_at timestamp with time zone,
    agent_integrity_resolved_by uuid,
    pipeline_stage text,
    hidden_reason text,
    instrument_type text,
    instrument_identifier text,
    signal_band text,
    theme text,
    trajectory_points jsonb,
    what_it_changes text,
    does_not_resolve text,
    conversion_trigger text,
    cross_references text,
    provenance_status public.provenance_status DEFAULT 'unverified'::public.provenance_status NOT NULL,
    provenance_verified_at timestamp with time zone,
    theme_candidate text,
    search_tsv tsvector GENERATED ALWAYS AS (((setweight(to_tsvector('english'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE(summary, ''::text)), 'B'::"char")) || setweight(to_tsvector('english'::regconfig, COALESCE(full_brief, ''::text)), 'C'::"char"))) STORED,
    canonical_instrument_key text,
    origin_class text,
    item_grade text DEFAULT 'brief'::text NOT NULL,
    instrument_entity_id text,
    cost_mechanism text,
    penalty_range text,
    enforcement_body text,
    requirement_trajectory jsonb,
    recommended_actions jsonb DEFAULT '[]'::jsonb NOT NULL,
    compliance_object_candidates text[] DEFAULT '{}'::text[],
    CONSTRAINT intelligence_items_confidence_check CHECK ((confidence = ANY (ARRAY['confirmed'::text, 'unconfirmed'::text]))),
    CONSTRAINT intelligence_items_domain_check CHECK (((domain >= 1) AND (domain <= 7))),
    CONSTRAINT intelligence_items_format_type_check CHECK (((format_type IS NULL) OR (format_type = ANY (ARRAY['regulatory_fact_document'::text, 'technology_profile'::text, 'operations_profile'::text, 'market_signal_brief'::text, 'research_summary'::text])))),
    CONSTRAINT intelligence_items_instrument_type_check CHECK (((instrument_type IS NULL) OR (instrument_type = ANY (ARRAY['local_law'::text, 'state_statute'::text, 'national_regulation'::text, 'federal_statute'::text, 'federal_rule'::text, 'federal_executive_order'::text, 'eu_regulation'::text, 'eu_directive'::text, 'municipal_ordinance'::text, 'agency_guidance'::text, 'court_decision'::text, 'industry_standard'::text, 'market_signal'::text, 'research_item'::text, 'voluntary_initiative'::text])))),
    CONSTRAINT intelligence_items_item_grade_check CHECK ((item_grade = ANY (ARRAY['record'::text, 'brief'::text]))),
    CONSTRAINT intelligence_items_item_type_check CHECK ((item_type = ANY (ARRAY['regulation'::text, 'directive'::text, 'standard'::text, 'guidance'::text, 'technology'::text, 'market_signal'::text, 'regional_data'::text, 'research_finding'::text, 'innovation'::text, 'framework'::text, 'tool'::text, 'initiative'::text]))),
    CONSTRAINT intelligence_items_origin_class_check CHECK ((origin_class = ANY (ARRAY['community'::text, 'community-corroborated'::text, 'modelled'::text, 'derived'::text, 'partner'::text, 'verified'::text, 'official'::text]))),
    CONSTRAINT intelligence_items_pipeline_stage_check CHECK (((pipeline_stage IS NULL) OR (pipeline_stage = ANY (ARRAY['draft'::text, 'active_review'::text, 'published'::text, 'archived'::text])))),
    CONSTRAINT intelligence_items_priority_check CHECK ((priority = ANY (ARRAY['CRITICAL'::text, 'HIGH'::text, 'MODERATE'::text, 'LOW'::text]))),
    CONSTRAINT intelligence_items_requirement_trajectory_check CHECK (((requirement_trajectory IS NULL) OR (jsonb_typeof((requirement_trajectory -> 'steps'::text)) = 'array'::text))),
    CONSTRAINT intelligence_items_severity_check CHECK (((severity IS NULL) OR (severity = ANY (ARRAY['action_required'::text, 'cost_alert'::text, 'window_closing'::text, 'competitive_edge'::text, 'monitoring'::text, 'critical'::text, 'high'::text, 'moderate'::text, 'low'::text, 'immediate'::text, 'watch'::text, 'reference'::text, 'background'::text])))),
    CONSTRAINT intelligence_items_signal_band_check CHECK (((signal_band IS NULL) OR (signal_band = ANY (ARRAY['price'::text, 'corporate'::text, 'corridor'::text])))),
    CONSTRAINT intelligence_items_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'adopted'::text, 'in_force'::text, 'monitoring'::text, 'superseded'::text, 'repealed'::text, 'expired'::text]))),
    CONSTRAINT intelligence_items_trajectory_band_check CHECK (((trajectory_points IS NULL) OR (signal_band = 'price'::text))),
    CONSTRAINT intelligence_items_urgency_tier_check CHECK (((urgency_tier IS NULL) OR (urgency_tier = ANY (ARRAY['watch'::text, 'elevated'::text, 'stable'::text, 'informational'::text]))))
);


--
-- Name: TABLE intelligence_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.intelligence_items IS 'Layer 2: Specific regulations, standards, findings that live INSIDE sources. Linked to their source via source_id.';


--
-- Name: COLUMN intelligence_items.legacy_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.legacy_id IS 'Maps to old resources.id (e.g. "o1", "a3") for migration continuity. NULL for new items.';


--
-- Name: COLUMN intelligence_items.source_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.source_id IS 'THE critical FK. Links this regulation/finding to the source portal it lives in. Every item must trace back to a source.';


--
-- Name: COLUMN intelligence_items.severity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.severity IS 'Per-surface severity vocabulary, single column with broad enum (Q1, 2026-05-24). Allows action_required / cost_alert / window_closing / competitive_edge / monitoring (Market Intel), critical / high / moderate / low (Operations, Regulations), immediate / watch / reference / background (other). Nullable.';


--
-- Name: COLUMN intelligence_items.urgency_tier; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.urgency_tier IS 'Dashboard counter tier (Watch/Elevated/Stable/Informational). Mapped from severity by agent during regeneration.';


--
-- Name: COLUMN intelligence_items.format_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.format_type IS 'SKILL.md format used to generate this brief. Determines section structure for rendering.';


--
-- Name: COLUMN intelligence_items.last_regenerated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.last_regenerated_at IS 'Timestamp of most recent agent regeneration under new SKILL.md contract.';


--
-- Name: COLUMN intelligence_items.regeneration_skill_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.regeneration_skill_version IS 'Identifier (date stamp or SKILL.md SHA) of contract version used for last regeneration.';


--
-- Name: COLUMN intelligence_items.sources_used; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.sources_used IS 'Array of source IDs the agent referenced when generating this brief. Populated by citation extraction.';


--
-- Name: COLUMN intelligence_items.operational_scenario_tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.operational_scenario_tags IS 'Open vocabulary of operational scenarios this item touches. Agents prefer the core glossary in SKILL.md but may emit new scenarios. Drives intersection detection: items sharing scenario tags are intersection candidates.';


--
-- Name: COLUMN intelligence_items.compliance_object_tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.compliance_object_tags IS 'Closed vocabulary of supply-chain roles/entities this item imposes obligations on. ~18 values per SKILL.md. Drives intersection detection: items imposing on the same role are intersection candidates.';


--
-- Name: COLUMN intelligence_items.related_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.related_items IS 'UUID array of intelligence_items the agent recognised as topically/operationally related during brief composition. Populated from the source pool. Drives the intersection link graph.';


--
-- Name: COLUMN intelligence_items.intersection_summary; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.intersection_summary IS 'Short markdown (≤500 chars) describing how this item interacts with adjacent regulations the agent identified. Sourced; integrity rule applies. NULL when no intersections were identified during composition.';


--
-- Name: COLUMN intelligence_items.jurisdiction_iso; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.jurisdiction_iso IS 'Sub-national-aware jurisdiction codes. ISO 3166-1 alpha-2, ISO 3166-2, or free-text supranational/IGO codes (EU, GLOBAL, IMO, ICAO). Coexists with legacy jurisdictions during 60-day transition window.';


--
-- Name: COLUMN intelligence_items.agent_integrity_flag; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.agent_integrity_flag IS 'TRUE when full_brief contains agent-emitted integrity concern phrase. Auto-recomputed via trigger on full_brief change.';


--
-- Name: COLUMN intelligence_items.agent_integrity_phrase; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.agent_integrity_phrase IS 'The canonical phrase pattern that matched. NULL when flag is FALSE.';


--
-- Name: COLUMN intelligence_items.agent_integrity_flagged_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.agent_integrity_flagged_at IS 'Timestamp of the first detection — set only on the FALSE→TRUE edge.';


--
-- Name: COLUMN intelligence_items.agent_integrity_resolved_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.agent_integrity_resolved_at IS 'Timestamp of admin resolution (replace_url / regenerate / mark_resolved).';


--
-- Name: COLUMN intelligence_items.agent_integrity_resolved_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.agent_integrity_resolved_by IS 'auth.users.id of the admin who resolved the flag.';


--
-- Name: COLUMN intelligence_items.pipeline_stage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.pipeline_stage IS 'Editorial pipeline stage. Values: draft, active_review, published, archived. Backfilled to published for legacy rows. NULL on new rows means unstaged.';


--
-- Name: COLUMN intelligence_items.hidden_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.hidden_reason IS 'Operator-drafted reason text when an item is flagged and hidden, typically used together with pipeline_stage=archived for off-topic hides. Distinct from agent_integrity_phrase which is reserved for the integrity-flag mechanism. NULL when no hide reason applies.';


--
-- Name: COLUMN intelligence_items.instrument_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.instrument_type IS 'Canonical instrument type per the 15-value closed vocabulary. Populated by classifier-item-type at ingest (Phase 6) and backfilled for existing regulation-style rows in Phase 5. NULL for non-regulatory items (regional_data, tool, technology, innovation).';


--
-- Name: COLUMN intelligence_items.instrument_identifier; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.instrument_identifier IS 'Free-text identifier for the canonical instrument. Picking rule per docs/sprint-1/phase-2-dedup-plan.md § 7: (1) authoritative public identifier (RIN, EU OJ citation, public law number, ISO standard number), (2) CFR/agency-publication citation, (3) court-decision citation per Bluebook, (4) lowercase kebab-case slug derived from the title scoped to the jurisdiction. NOT auto-normalized at write; the partial unique index throws on near-matches with different formatting and forces operator review.';


--
-- Name: COLUMN intelligence_items.signal_band; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.signal_band IS 'Market Intel band routing (Q2, 2026-05-24). price / corporate / corridor. Nullable for non-market items.';


--
-- Name: COLUMN intelligence_items.theme; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.theme IS 'Research theme grouping (Q3, 2026-05-24). 7 canonical themes per ResearchView.tsx vocabulary. Nullable for non-research items. Explicit column (NOT topic_tags[0] reuse) per operator guidance.';


--
-- Name: COLUMN intelligence_items.trajectory_points; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.trajectory_points IS 'B1 Price signal time-series for TrajectoryBars rendering. JSONB shape: { "points": [{"date":"YYYY-MM-DD","value":Number}, ...], "base_date":"YYYY-MM-DD", "base_label": "Base 100 = ..." }. Nullable. Constrained to signal_band = ''price'' via intelligence_items_trajectory_band_check.';


--
-- Name: COLUMN intelligence_items.what_it_changes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.what_it_changes IS 'Editorial callout (every card, all surfaces): "what this finding/signal changes for your operations". Optional TEXT. Renders as a card right-column block per R-A + M-A mockup.';


--
-- Name: COLUMN intelligence_items.does_not_resolve; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.does_not_resolve IS 'Editorial callout (Research featured items): "Does NOT resolve" muted callout naming scope limits. Optional TEXT.';


--
-- Name: COLUMN intelligence_items.conversion_trigger; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.conversion_trigger IS 'Editorial callout (Market featured B1/B2 items): event that flips the signal from observation to commercial pressure. Optional TEXT.';


--
-- Name: COLUMN intelligence_items.cross_references; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.cross_references IS 'Editorial callout (Market featured B3 corridor items): links to canonical Operations/Regulations briefs. Optional TEXT.';


--
-- Name: COLUMN intelligence_items.provenance_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.provenance_status IS 'Provenance invariant status (Sprint 4). Default unverified at insert; trigger (task 1.4) sets terminal status verified / pending_human_verify / quarantined on future writes. Block 1 task 1.1 only lands the column with default; no existing item status flips until Phase 2 reconciliation.';


--
-- Name: COLUMN intelligence_items.provenance_verified_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.provenance_verified_at IS 'Timestamp the item reached provenance_status = verified, populated by the trigger or by the admin verification queue (Component 6).';


--
-- Name: COLUMN intelligence_items.theme_candidate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.theme_candidate IS 'Capture-not-null residual (Emergence-Capture INV-1): the agent-proposed theme value that matched no live theme_check vocabulary, banked with the row''s provenance instead of being dropped. NULL when theme is DB-valid or absent. Mined by the (follow-on) recurrence detector; not a customer-facing field.';


--
-- Name: COLUMN intelligence_items.canonical_instrument_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.canonical_instrument_key IS 'Normalized instrument identity (bare CELEX number, e.g. 32019R1242) derived from instrument_identifier or source_url by derive_canonical_instrument_key(); NULL when not confidently derivable. The join key for dedup-before-grounding; two verified+live items may not share one (uq_..._canonical_key_verified_live).';


--
-- Name: COLUMN intelligence_items.origin_class; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.origin_class IS 'Where the content came from (spec 00 s3.6): community | community-corroborated | modelled | derived | partner | verified | official. Same 7-value vocabulary as emission_factors.origin_class (migration 258), owned by src/lib/contracts/vocabularies.mjs ORIGIN_CLASS. Nullable here: the vocabulary is NOT widened for pre-existing rows (operator ruling, Addendum 26) - a row this migration cannot confidently classify stays NULL, documented as pre-vocabulary.';


--
-- Name: COLUMN intelligence_items.item_grade; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.item_grade IS 'Item tier (Lane POP, 2026-09-01). ''brief'' = a synthesized, grounded brief (the historical default every existing row carries — 5-8 authored per batch, LLM- or session-authored). ''record'' = a catalogue record: identity + dates + forward events + tags + a short description made ONLY of verbatim FACT/GAP spans extracted from the captured source, no synthesis, $0 — clears the exact same validate_item_provenance C1-C7 gate a brief does (this column changes no gate logic; it only labels what already passed honestly). Operator ruling 2026-09-01: record-grade items MAY appear on customer surfaces, labeled (see RecordGradeBadge). Upgrades from ''record'' to ''brief'' in place (same row, same id) once grounding is armed and a real brief is authored over it — never a second row.';


--
-- Name: COLUMN intelligence_items.instrument_entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.instrument_entity_id IS 'Progressive re-keying (ADR-024): the instrument entity for canonical_instrument_key, nullable, backfilled by scripts/entities/backfill-entities.mjs; the text key stays.';


--
-- Name: COLUMN intelligence_items.cost_mechanism; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.cost_mechanism IS 'Who pays and how the cost reaches a forwarder''s invoice (surcharge, levy, allowance cost, penalty, pass-through). One sentence, verbatim-grounded. Nullable; populated only when the source states the mechanism (regulatory_fact_document format -- task 2.2). Read by RegulationDetailSurface''s Who-pays cell.';


--
-- Name: COLUMN intelligence_items.penalty_range; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.penalty_range IS 'Verbatim-grounded penalty figure or range from the source''s penalty material (S3/S8). Nullable; renders in PenaltyFacts alongside enforcement_body when either is present.';


--
-- Name: COLUMN intelligence_items.enforcement_body; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.enforcement_body IS 'Verbatim-grounded name of the body that enforces the instrument, from the source''s penalty material. Nullable; renders in PenaltyFacts alongside penalty_range when either is present.';


--
-- Name: COLUMN intelligence_items.requirement_trajectory; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.requirement_trajectory IS 'The regulation''s per-year requirement path (deliberately NOT trajectory_points, migration 107''s numeric price series -- a different shape, a different renderer). JSONB shape: { "steps": [{"date": "2025" | "2026-09-30" | "2027", "value": "40%", "label": "of verified emissions"}, ...], "note": "free text, e.g. scope changes across steps" }. Nullable; null when the instrument has no phase-in. Constrained to steps being a JSON array (when present) via intelligence_items_requirement_trajectory_check. Read by RequirementTrajectory.tsx (task 2.3).';


--
-- Name: COLUMN intelligence_items.recommended_actions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.recommended_actions IS 'Structured actions extracted from the brief''s "do now" sections (lane STRUCTURED-ACTIONS, 2026-09-28). Array of {action_text, verb, timeframe_days, owner, due_date, source_section}; owner/due_date/timeframe_days are null when the source prose does not state them (never invented, CLAUDE.md rule 2). Written by scripts/turns/apply-record-briefs.mjs''s "structured-actions" step via src/lib/agent/extract-recommended-actions.mjs. Not to be confused with integrity_flags.recommended_actions (migration 048), an unrelated internal-admin-remediation {action, rationale} shape.';


--
-- Name: COLUMN intelligence_items.compliance_object_candidates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.intelligence_items.compliance_object_candidates IS 'Capture-not-null residual (the compliance_object_tags twin of theme_candidate, migration 136): the compliance-object values the agent emitted that matched none of the 19 closed compliance_object_tags values, banked instead of dropped by parse-output.ts. Mined by scripts/connections/term-recurrence.mjs (kind compliance_object); not a customer-facing field.';


--
-- Name: CONSTRAINT intelligence_items_instrument_type_check ON intelligence_items; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT intelligence_items_instrument_type_check ON public.intelligence_items IS 'Closed-vocabulary enum of 15 instrument types per docs/sprint-1/phase-2-dedup-plan.md § 6 (operator-approved). NULL allowed because regional_data/tool/technology/innovation item types do not carry an instrument identity. Combined with jurisdiction_iso + instrument_identifier in the partial unique index, this forms the canonical-entity key that prevents future RC-9 duplicates.';


--
-- Name: intelligence_summaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intelligence_summaries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid,
    sector text NOT NULL,
    summary text NOT NULL,
    urgency_score numeric(3,2),
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    model_version text,
    CONSTRAINT intelligence_summaries_urgency_score_check CHECK (((urgency_score >= (0)::numeric) AND (urgency_score <= (1)::numeric)))
);


--
-- Name: item_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    item_id uuid NOT NULL,
    assignee_user_id uuid NOT NULL,
    assigned_by uuid,
    due_on date,
    state text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT item_assignments_state_check CHECK ((state = ANY (ARRAY['open'::text, 'done'::text])))
);


--
-- Name: TABLE item_assignments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.item_assignments IS 'Migration 359. Multi-person assignment of an intelligence item to members of the caller''s own org, with an optional due date and an open or done state. Coordination metadata only: never analysed, never read by another page or the flywheel (ADR-042, ADR-043). Distinct from workspace_item_overrides.owner_user_id (migration 234), the single owner.';


--
-- Name: item_changelog; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_changelog (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    change_date date DEFAULT CURRENT_DATE NOT NULL,
    change_type text DEFAULT 'UPDATED'::text NOT NULL,
    field text NOT NULL,
    previous_value text DEFAULT ''::text NOT NULL,
    new_value text DEFAULT ''::text NOT NULL,
    impact text,
    impact_level text DEFAULT 'MODERATE'::text,
    detected_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT item_changelog_change_type_check CHECK ((change_type = ANY (ARRAY['NEW'::text, 'UPDATED'::text, 'STATUS_CHANGE'::text, 'SEVERITY_CHANGE'::text, 'ARCHIVED'::text]))),
    CONSTRAINT item_changelog_impact_level_check CHECK ((impact_level = ANY (ARRAY['CRITICAL'::text, 'HIGH'::text, 'MODERATE'::text, 'LOW'::text])))
);


--
-- Name: item_correction_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_correction_evidence (
    correction_id uuid NOT NULL,
    latest_machine_value jsonb,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    observed_count integer DEFAULT 1 NOT NULL
);


--
-- Name: TABLE item_correction_evidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.item_correction_evidence IS 'Migration 356. The latest machine value a writer tried to store where a correction overrode it (one row per correction, upserted by item_corrections_note()). Evidence for the admin screen; never read by a customer surface.';


--
-- Name: item_cross_references; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_cross_references (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_item_id uuid NOT NULL,
    target_item_id uuid NOT NULL,
    relationship text DEFAULT 'related'::text NOT NULL,
    origin text DEFAULT 'manual'::text NOT NULL,
    basis jsonb,
    score real,
    CONSTRAINT item_cross_references_origin_check CHECK ((origin = ANY (ARRAY['manual'::text, 'agent_semantic'::text, 'entity_extraction'::text, 'provenance_discovery'::text]))),
    CONSTRAINT item_cross_references_relationship_check CHECK ((relationship = ANY (ARRAY['related'::text, 'supersedes'::text, 'implements'::text, 'conflicts'::text, 'amends'::text, 'depends_on'::text])))
);


--
-- Name: COLUMN item_cross_references.basis; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_cross_references.basis IS 'Grounded connection basis (mig 252): array of {signal, detail, weight} — the real shared attributes that justify this edge. No edge without a basis. Written by provenance-discovery + available to entity/semantic origins.';


--
-- Name: item_disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_disputes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    note text NOT NULL,
    disputing_sources jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: item_forward_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_forward_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    intelligence_item_id uuid NOT NULL,
    event_date date NOT NULL,
    date_precision text NOT NULL,
    event_kind text NOT NULL,
    obligation_text text NOT NULL,
    source_kind text NOT NULL,
    source_claim_id uuid,
    source_section_id uuid,
    source_span text NOT NULL,
    confidence text NOT NULL,
    extractor_version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT item_forward_events_claim_id_matches_source_kind_check CHECK (((source_kind = 'claim'::text) = (source_claim_id IS NOT NULL))),
    CONSTRAINT item_forward_events_confidence_check CHECK ((confidence = ANY (ARRAY['high'::text, 'medium'::text]))),
    CONSTRAINT item_forward_events_date_precision_check CHECK ((date_precision = ANY (ARRAY['day'::text, 'month'::text, 'year'::text]))),
    CONSTRAINT item_forward_events_event_kind_check CHECK ((event_kind = ANY (ARRAY['entry_into_force'::text, 'compliance_deadline'::text, 'review_or_report'::text, 'phase_step'::text, 'consultation_close'::text, 'other'::text]))),
    CONSTRAINT item_forward_events_high_confidence_requires_claim_check CHECK (((confidence <> 'high'::text) OR (source_kind = 'claim'::text))),
    CONSTRAINT item_forward_events_source_kind_check CHECK ((source_kind = ANY (ARRAY['claim'::text, 'section'::text]))),
    CONSTRAINT item_forward_events_source_span_not_empty_check CHECK ((length(source_span) > 0))
);


--
-- Name: TABLE item_forward_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.item_forward_events IS 'One row per dated, obligation-bound event lifted from an already-grounded FACT/GAP claim span or rendered section markdown by scripts/forward-events/extract-forward-events.mjs (FE-1). Never invents a date; a bare date with no obligation-binding trigger phrase nearby is never promoted to a row here. An item can have many rows (a phase-out schedule is several). See this migration''s own header for the grounding-rule constraints and the RLS posture this table mirrors (migration 103, intelligence_item_sections).';


--
-- Name: COLUMN item_forward_events.event_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_forward_events.event_date IS 'The obligation date, normalized to a real calendar date even at reduced precision: a bare year (e.g. "by 2030") normalizes to YYYY-01-01, a month+year to YYYY-MM-01. date_precision is what stops a consumer reading that normalized day as a real, source-stated day.';


--
-- Name: COLUMN item_forward_events.date_precision; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_forward_events.date_precision IS 'day | month | year — how much of event_date the source text actually specified. A "year" row''s January 1st is a normalization artifact, not a claim the source made about January 1st.';


--
-- Name: COLUMN item_forward_events.event_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_forward_events.event_kind IS 'entry_into_force | compliance_deadline | review_or_report | phase_step | consultation_close | other — the extractor''s own trigger-rule vocabulary (verified against every literal kind its rule table can emit). "other" covers deontic-adjacent dates the extractor deliberately declines to over-classify (a validity-window end, an institutional delegated-powers start) rather than guessing a more specific kind it cannot support from the trigger phrase alone.';


--
-- Name: COLUMN item_forward_events.obligation_text; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_forward_events.obligation_text IS 'The clause/sentence around the date (source text, whitespace-collapsed), giving a reader the obligation in context without re-opening the full brief or claim.';


--
-- Name: COLUMN item_forward_events.source_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_forward_events.source_kind IS 'claim | section — which corpus object the date was lifted from. Governs confidence: claim-sourced rows may reach ''high'' (the claim.span is already source-grounded with a verbatim quote); section-sourced rows are capped at ''medium'' (rendered markdown, not itself a per-claim verbatim citation). Enforced by this table''s CHECK constraints, not left to the writer to keep consistent.';


--
-- Name: COLUMN item_forward_events.source_claim_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_forward_events.source_claim_id IS 'FK to section_claim_provenance(id) when source_kind = ''claim''; NULL when source_kind = ''section''. ON DELETE SET NULL: if the claim itself is later deleted, this event row survives as an orphaned-but-still-dated record rather than vanishing along with a provenance row it does not own.';


--
-- Name: COLUMN item_forward_events.source_section_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_forward_events.source_section_id IS 'FK to intelligence_item_sections(id) when source_kind = ''section''; NULL when source_kind = ''claim''. ON DELETE CASCADE: unlike source_claim_id, a forward event lifted from a section''s rendered markdown has no independent existence once that section row is gone — the text it quoted no longer exists anywhere else to re-verify against.';


--
-- Name: COLUMN item_forward_events.source_span; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_forward_events.source_span IS 'The verbatim substring of the source claim.span or section.md that the date came from — never reconstructed or normalized. The extractor''s own assertVerbatim guard throws rather than silently drops a violation before this row is ever produced; this column is NOT NULL and non-empty by that same construction.';


--
-- Name: COLUMN item_forward_events.confidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_forward_events.confidence IS 'high (claim-sourced, source-grounded verbatim quote) | medium (section-sourced, rendered markdown). Nothing else is ever emitted by the extractor; the CHECK constraints hold the column to that even if a future writer''s logic does not.';


--
-- Name: COLUMN item_forward_events.extractor_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_forward_events.extractor_version IS 'scripts/forward-events/extract-forward-events.mjs EXTRACTOR_VERSION at write time (e.g. ''fe1-2026-09-01.1''), bumped whenever a rule changes semantics. Lets a downstream consumer tell events produced by different extractor rule generations apart without re-deriving it from created_at.';


--
-- Name: item_gate_a_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_gate_a_state (
    intelligence_item_id uuid NOT NULL,
    scanned_hash text NOT NULL,
    orphan_count integer DEFAULT 0 NOT NULL,
    orphans jsonb DEFAULT '[]'::jsonb NOT NULL,
    gate_a_version text NOT NULL,
    scanned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT item_gate_a_state_orphan_count_check CHECK ((orphan_count >= 0))
);


--
-- Name: TABLE item_gate_a_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.item_gate_a_state IS 'Gate A per-item prose-fact scan state. scanned_hash = md5(full_brief at scan time); validate_item_provenance Gate-A criterion rejects stale state (hash mismatch) and orphan_count>0. Refreshed on every mint/ground write; backfilled for existing corpus. Landed before the criterion so no grounding window breaks.';


--
-- Name: item_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    item_id uuid NOT NULL,
    author_user_id uuid,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    legacy_override_id uuid,
    CONSTRAINT item_notes_body_check CHECK (((btrim(body) <> ''::text) AND (char_length(body) <= 20000)))
);


--
-- Name: TABLE item_notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.item_notes IS 'Migration 358. Private-per-workspace notes on an intelligence item. Org members read; the author edits their own; owner or admin soft deletes (deleted_at). Workspace commentary only: never analysed, never read by another page or the flywheel (ADR-042, ADR-043). Supersedes workspace_item_overrides.notes for threaded notes.';


--
-- Name: COLUMN item_notes.author_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_notes.author_user_id IS 'NULL for a note moved from workspace_item_overrides.notes (no author existed) and after the author''s profile is deleted. Nobody can edit an authorless note; an owner or admin can delete it.';


--
-- Name: COLUMN item_notes.legacy_override_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.item_notes.legacy_override_id IS 'The workspace_item_overrides row whose notes text this row was copied from by move_override_notes_to_item_notes(); UNIQUE so the move is idempotent.';


--
-- Name: item_supersessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_supersessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    old_item_id uuid NOT NULL,
    new_item_id uuid NOT NULL,
    supersession_date date NOT NULL,
    severity text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT item_supersessions_severity_check CHECK ((severity = ANY (ARRAY['major'::text, 'minor'::text, 'replacement'::text])))
);


--
-- Name: item_timelines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_timelines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    milestone_date date NOT NULL,
    label text NOT NULL,
    is_completed boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: item_type_required_slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_type_required_slots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_type text NOT NULL,
    slot_key text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE item_type_required_slots; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.item_type_required_slots IS 'Declarative required-slot vocabulary per item_type (Sprint 4 criterion 5). For each item_type, every listed slot_key must be addressed by at least one section_claim_provenance row (FACT span-grounded OR explicit GAP). Seeded in task 1.2; this migration creates the empty table only.';


--
-- Name: item_workspace_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.item_workspace_tags (
    tag_id uuid NOT NULL,
    intelligence_item_id uuid NOT NULL,
    org_id uuid NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE item_workspace_tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.item_workspace_tags IS 'Applies a workspace_tags row to an intelligence_items row (migration 313). Deleting either side CASCADEs, a tag is never soft-hidden, so facet counts stay a live COUNT(*).';


--
-- Name: market_series; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_series (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    series_key text NOT NULL,
    label text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    value_numeric numeric,
    unit text,
    currency text,
    derivation text,
    origin_class text,
    source_key text,
    source_ref text,
    n_observations integer,
    method_version text,
    as_at_date date,
    reference_period text,
    entity_id text,
    CONSTRAINT market_series_derivation_check CHECK ((derivation = ANY (ARRAY['statutory_fixed'::text, 'statutory_formula'::text, 'observed'::text, 'transacted_index'::text, 'assessed'::text, 'calculated'::text, 'interpolated'::text, 'modelled'::text, 'estimated'::text]))),
    CONSTRAINT market_series_n_observations_positive_check CHECK (((n_observations IS NULL) OR (n_observations > 0))),
    CONSTRAINT market_series_origin_class_check CHECK ((origin_class = ANY (ARRAY['community'::text, 'community-corroborated'::text, 'modelled'::text, 'derived'::text, 'partner'::text, 'verified'::text, 'official'::text]))),
    CONSTRAINT market_series_series_key_format_check CHECK ((series_key ~ '^[a-z0-9]+(?:[:_-][a-z0-9]+)*$'::text))
);


--
-- Name: TABLE market_series; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.market_series IS 'WO-16 time-series spine: one row per published observation of one named series for one reference period. series_key namespaces by producer (e.g. eu-oil-bulletin:automotive-diesel). Feeds published_price_statistics via a separate refresher (WO-16.2 ruling, option a); does not replace it.';


--
-- Name: COLUMN market_series.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.market_series.entity_id IS 'The entity this series describes (a jurisdiction for a regional price index), set by the producer from its registry entry at write time and by scripts/migrations/data/backfill-market-series-entity.mjs for older rows. Nullable: a series about no single entity (an FX rate, a global dataset) stays NULL. FK to entities, so an unknown id cannot be stored. The outbox trigger (emit_propagation_event, migration 284/352) records it as propagation_events.entity_id, which is what lets a change to the series reach the items linked to that entity (migration 373).';


--
-- Name: moderation_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.moderation_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    reporter_user_id uuid,
    reason text,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by_user_id uuid,
    CONSTRAINT moderation_reports_status_check CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'dismissed'::text]))),
    CONSTRAINT moderation_reports_target_kind_check CHECK ((target_kind = ANY (ARRAY['post'::text, 'group'::text, 'user'::text])))
);


--
-- Name: TABLE moderation_reports; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.moderation_reports IS 'Reports filed against posts, groups, or users. target_id is a soft FK whose target table is determined by target_kind (post -> community_posts; group -> community_groups; user -> auth.users). Soft because reports outlive their targets — a deleted post still has a historical report row.';


--
-- Name: monitoring_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.monitoring_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    item_id uuid,
    scheduled_check timestamp with time zone NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    last_result text,
    change_detected boolean DEFAULT false NOT NULL,
    checked_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reconciled_at timestamp with time zone,
    CONSTRAINT monitoring_queue_last_result_check CHECK (((last_result IS NULL) OR (last_result = ANY (ARRAY['no_change'::text, 'updated'::text, 'new_item'::text, 'error'::text, 'inaccessible'::text])))),
    CONSTRAINT monitoring_queue_priority_check CHECK ((priority = ANY (ARRAY['urgent'::text, 'high'::text, 'normal'::text, 'low'::text])))
);


--
-- Name: TABLE monitoring_queue; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.monitoring_queue IS 'Scheduled source scans. Worker reads this to know what to check next.';


--
-- Name: COLUMN monitoring_queue.reconciled_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.monitoring_queue.reconciled_at IS 'Migration 124: stamped by the reconcile worker (/api/worker/reconcile) after it processes a change_detected=true row. NULL = pending reconciliation.';


--
-- Name: mutation_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mutation_leases (
    intelligence_item_id uuid NOT NULL,
    holder text NOT NULL,
    lane text,
    acquired_at timestamp with time zone DEFAULT now() NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE mutation_leases; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.mutation_leases IS 'Per-item mutation lease (H5, operator ruling 2026-07-16). Acquire before touching an item, release at bank; a live lease blocks the other session. heartbeat_at drives stale takeover. Row exists only while leased.';


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    user_id uuid NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    on_mention boolean DEFAULT true NOT NULL,
    on_reply_in_my_threads boolean DEFAULT true NOT NULL,
    on_new_post_in_joined_groups boolean DEFAULT false NOT NULL,
    on_invite boolean DEFAULT true NOT NULL,
    on_promote boolean DEFAULT true NOT NULL,
    channels text[] DEFAULT ARRAY['in_app'::text] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE notification_preferences; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification_preferences IS 'Per-user notification toggles. Soft-enforces that on_invite cannot truly be disabled — the application worker ignores this column for kind=''invite'' notifications, ensuring an invitee always learns of a pending invite. (Documenting here because the constraint is not in the schema; trigger-level enforcement was deemed too rigid.)';


--
-- Name: COLUMN notification_preferences.on_invite; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.on_invite IS 'Soft-enforced at the worker layer: invite notifications are always delivered regardless of this flag. The toggle is preserved in the schema to keep the column shape consistent for future relaxation.';


--
-- Name: COLUMN notification_preferences.channels; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.channels IS 'Delivery channels: in_app | email | slack. Phase C ships in_app only; email/slack pipelines are deferred. Application code falls back to in_app if a configured channel is not yet supported.';


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT notifications_kind_check CHECK ((kind = ANY (ARRAY['mention'::text, 'reply'::text, 'promote'::text, 'invite'::text, 'moderation'::text, 'archive'::text, 'assignment'::text])))
);


--
-- Name: TABLE notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notifications IS 'Per-user in-app inbox (bell icon). Distinct from notification_events (migration 007) which tracks platform-wide event dispatch. Application code inserts rows here when a matching subscription fires.';


--
-- Name: COLUMN notifications.kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.kind IS 'Notification category. Drives UI grouping and overrides on notification_preferences (e.g. on_invite cannot be disabled).';


--
-- Name: COLUMN notifications.payload; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.payload IS 'Free-form jsonb for the source of truth: post_id, group_id, inviter_user_id, etc. UI links and copy are rendered from this.';


--
-- Name: obligation_objects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.obligation_objects (
    obligation_id text NOT NULL,
    instrument_item_id uuid NOT NULL,
    instrument_entity_id text,
    version integer DEFAULT 1 NOT NULL,
    supersedes text,
    pinpoint_citation text NOT NULL,
    verbatim_text text NOT NULL,
    plain_language text,
    binding_position text NOT NULL,
    duty_holder_class text[] NOT NULL,
    applicability_trigger jsonb NOT NULL,
    jurisdiction text[],
    mode text[],
    vertical text[],
    frequency text,
    entry_into_force date,
    date_of_application date,
    first_deadline date,
    enforcement_start date,
    evidence_required text,
    retention_period text,
    sanction_class text,
    severity_score integer,
    statutory_maximum text,
    cost_formula text,
    direct_compliance_cost jsonb,
    effort jsonb,
    status text DEFAULT 'not_assessed'::text NOT NULL,
    date_reviewed date,
    next_review_due date,
    source_id uuid,
    capture_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT obligation_objects_binding_position_check CHECK ((binding_position = ANY (ARRAY['direct_duty'::text, 'carrier_passthrough'::text, 'customer_contract'::text, 'monitoring_only'::text]))),
    CONSTRAINT obligation_objects_direct_cost_shape_check CHECK (((direct_compliance_cost IS NULL) OR ((jsonb_typeof(direct_compliance_cost) = 'object'::text) AND (direct_compliance_cost ?& ARRAY['amount'::text, 'currency'::text, 'basis'::text, 'source'::text]) AND (jsonb_typeof((direct_compliance_cost -> 'amount'::text)) = 'number'::text)))),
    CONSTRAINT obligation_objects_duty_holder_nonempty_check CHECK ((cardinality(duty_holder_class) >= 1)),
    CONSTRAINT obligation_objects_effort_not_money_check CHECK (((effort IS NULL) OR (NOT (effort ?| ARRAY['amount'::text, 'currency'::text, 'price'::text, 'cost'::text])))),
    CONSTRAINT obligation_objects_effort_shape_check CHECK (((effort IS NULL) OR ((jsonb_typeof(effort) = 'object'::text) AND (effort ?& ARRAY['person_days'::text, 'recurrence'::text]) AND (jsonb_typeof((effort -> 'person_days'::text)) = 'number'::text)))),
    CONSTRAINT obligation_objects_frequency_check CHECK (((frequency IS NULL) OR (frequency = ANY (ARRAY['annual'::text, 'per_consignment'::text, 'per_voyage'::text, 'event_triggered'::text])))),
    CONSTRAINT obligation_objects_id_shape_check CHECK ((obligation_id ~ '^cl:obligation:[0-9a-f]{16}$'::text)),
    CONSTRAINT obligation_objects_mode_no_alias_check CHECK (((mode IS NULL) OR (NOT (mode && ARRAY['sea'::text, 'maritime'::text, 'water'::text, 'vessel'::text, 'marine'::text, 'truck'::text, 'lorry'::text, 'hgv'::text, 'barge'::text, 'iww'::text, 'inland-waterway'::text, 'freighter'::text, 'airfreight'::text])))),
    CONSTRAINT obligation_objects_not_self_superseding_check CHECK (((supersedes IS NULL) OR (supersedes <> obligation_id))),
    CONSTRAINT obligation_objects_pinpoint_nonblank_check CHECK ((btrim(pinpoint_citation) <> ''::text)),
    CONSTRAINT obligation_objects_status_check CHECK ((status = ANY (ARRAY['yes'::text, 'no'::text, 'not_assessed'::text]))),
    CONSTRAINT obligation_objects_trigger_shape_check CHECK (((jsonb_typeof(applicability_trigger) = 'object'::text) AND (applicability_trigger ? 'attribute'::text) AND (applicability_trigger ? 'value'::text) AND (jsonb_typeof((applicability_trigger -> 'attribute'::text)) = 'string'::text) AND (jsonb_typeof((applicability_trigger -> 'value'::text)) = 'string'::text) AND (btrim((applicability_trigger ->> 'attribute'::text)) <> ''::text) AND (btrim((applicability_trigger ->> 'value'::text)) <> ''::text))),
    CONSTRAINT obligation_objects_verbatim_nonblank_check CHECK ((btrim(verbatim_text) <> ''::text)),
    CONSTRAINT obligation_objects_version_check CHECK ((version >= 1))
);


--
-- Name: TABLE obligation_objects; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.obligation_objects IS 'The obligation object (spec 01 section 3.2): one row per versioned obligation of one instrument item. The atom of the Regulations surface; migration 290 obligations stays the forward-event record and points here through obligations.obligation_id. verbatim_text is proven verbatim in the held capture by obligation_objects_guard (ADR-016). Cost slots are separate columns and are never merged or summed.';


--
-- Name: COLUMN obligation_objects.obligation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligation_objects.obligation_id IS 'cl:obligation:<16 lowercase hex> (entity kind obligation, migration 282). Registered in entities by the guard trigger. A new version of an obligation is a new row with a new id and supersedes pointing at the old one.';


--
-- Name: COLUMN obligation_objects.verbatim_text; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligation_objects.verbatim_text IS 'The provision text, verbatim in the capture named by capture_id (lower(btrim()) substring of agent_run_searches.result_content, the criterion 3 rule). Never truncated.';


--
-- Name: COLUMN obligation_objects.applicability_trigger; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligation_objects.applicability_trigger IS '{"attribute": <profile attribute>, "value": <value>}: the profile answer that put this row in scope. Read by src/lib/workspace/relevance.mjs at obligation grain and shown on the detail page binding banner.';


--
-- Name: COLUMN obligation_objects.statutory_maximum; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligation_objects.statutory_maximum IS 'Cost slot 1 (penalty exposure), as published. Never a modelled number (spec 01 section 3.4).';


--
-- Name: COLUMN obligation_objects.cost_formula; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligation_objects.cost_formula IS 'Cost slot 1 (penalty exposure), only where a published formula exists.';


--
-- Name: COLUMN obligation_objects.direct_compliance_cost; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligation_objects.direct_compliance_cost IS 'Cost slot 2: {amount, currency, basis, source}. Verifier fees, certificate purchase, registration fees: knowable.';


--
-- Name: COLUMN obligation_objects.effort; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligation_objects.effort IS 'Cost slot 3: {person_days, recurrence}. Never money; a money key is refused by obligation_objects_effort_not_money_check.';


--
-- Name: COLUMN obligation_objects.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligation_objects.status IS 'yes | no | not_assessed. not_assessed is the default and a first-class state.';


--
-- Name: obligations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.obligations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    intelligence_item_id uuid NOT NULL,
    forward_event_id uuid NOT NULL,
    jurisdiction text[] DEFAULT '{}'::text[] NOT NULL,
    modes text[] DEFAULT '{}'::text[] NOT NULL,
    binding_position text,
    due_date date,
    date_precision text,
    event_kind text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    derivation_version text NOT NULL,
    derived_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    obligation_id text,
    CONSTRAINT obligations_binding_position_check CHECK (((binding_position IS NULL) OR (binding_position = ANY (ARRAY['direct_duty'::text, 'carrier_passthrough'::text, 'customer_contract'::text, 'monitoring_only'::text])))),
    CONSTRAINT obligations_date_precision_check CHECK (((date_precision IS NULL) OR (date_precision = ANY (ARRAY['day'::text, 'month'::text, 'year'::text])))),
    CONSTRAINT obligations_due_date_precision_pair_check CHECK (((due_date IS NULL) = (date_precision IS NULL))),
    CONSTRAINT obligations_event_kind_check CHECK ((event_kind = ANY (ARRAY['entry_into_force'::text, 'compliance_deadline'::text, 'review_or_report'::text, 'phase_step'::text, 'consultation_close'::text, 'other'::text]))),
    CONSTRAINT obligations_modes_no_alias_check CHECK ((NOT (modes && ARRAY['sea'::text, 'maritime'::text, 'water'::text, 'vessel'::text, 'marine'::text, 'truck'::text, 'lorry'::text, 'hgv'::text, 'barge'::text, 'iww'::text, 'inland-waterway'::text, 'freighter'::text, 'airfreight'::text, 'multimodal'::text]))),
    CONSTRAINT obligations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))
);


--
-- Name: TABLE obligations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.obligations IS 'The obligation register (surface spec 01 §2/§3.2 core), one row per public.item_forward_events row. Denormalizes the source items jurisdiction / transport mode / a deterministically classified binding_position onto the dated event so the register can be filtered and sorted without a join. Written only by scripts/obligations/derive-obligations.mjs (dry by default, --apply through the guarded db.mjs path). See this migrations own header for the grain, nullability and RLS rationale.';


--
-- Name: COLUMN obligations.jurisdiction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligations.jurisdiction IS 'Denormalized copy of the source items jurisdiction_iso at derivation time (e.g. [''EU''], [''US-CA'']). Empty array, never null, when the item carries none.';


--
-- Name: COLUMN obligations.modes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligations.modes IS 'Denormalized, canonicalized copy of the source items transport_modes (normaliseMode() applied; an unrecognised raw value is DROPPED, never guessed). Canonical ocean freight token is always ''ocean'' -- see obligations_modes_no_alias_check.';


--
-- Name: COLUMN obligations.binding_position; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligations.binding_position IS 'direct_duty | carrier_passthrough | customer_contract | monitoring_only | NULL. Classified deterministically by src/lib/obligations/classify-binding-position.mjs from surface spec 01 1s named instrument table -- never invented, never LLM-derived. NULL means not yet classified (a real, distinct state from monitoring_only, which is itself a classification) and the read model renders it as an explicit "Not classified" state, never a blank or a dropped row.';


--
-- Name: COLUMN obligations.due_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligations.due_date IS 'Copied from the source forward events event_date. NULL only when the source event itself carries no date -- derive-obligations.mjs never invents one. Every row derivable from the live corpus today carries a value (item_forward_events.event_date is NOT NULL); this column stays nullable for a future non-dated obligation source (spec-01 4 item 12, customer-contract obligations) and as a defensive contract the derivation script is tested against.';


--
-- Name: COLUMN obligations.event_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligations.event_kind IS 'Copy of the source forward events event_kind (item_forward_events_event_kind_check, migration 274) -- the register rows own due-window / kind filter reads this column directly rather than joining back to the source event for it.';


--
-- Name: COLUMN obligations.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligations.status IS 'active | archived. Set from the source items is_archived at derivation time (an archived item never produces or keeps an active register row). Not spec-01 3.2s three-value owner-assessed status (Yes/No/Not assessed) -- this is a MACHINE lifecycle flag; the human-assessed status field is future work this migration deliberately does not claim to have built.';


--
-- Name: COLUMN obligations.derivation_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligations.derivation_version IS 'scripts/obligations/derive-obligations.mjs DERIVATION_VERSION at write time, mirroring item_forward_events.extractor_version -- lets a downstream consumer tell rows produced by different classifier/derivation generations apart without re-deriving it from created_at.';


--
-- Name: COLUMN obligations.obligation_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.obligations.obligation_id IS 'The obligation object (migration 376) this forward event belongs to. NULL until a population pass links it; no backfill in the migration.';


--
-- Name: oem_tech_roadmaps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oem_tech_roadmaps (
    roadmap_id uuid DEFAULT gen_random_uuid() NOT NULL,
    manufacturer_id text NOT NULL,
    tech_category text NOT NULL,
    commercial_stage text NOT NULL,
    target_year integer,
    energy_density_wh_kg numeric,
    density_basis text,
    c_rate_max numeric,
    usable_kwh numeric,
    announced_at date,
    source_id uuid NOT NULL,
    origin_class text DEFAULT 'community'::text NOT NULL,
    derivation text DEFAULT 'observed'::text NOT NULL,
    confidence_admiralty text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oem_tech_roadmaps_commercial_stage_check CHECK ((commercial_stage = ANY (ARRAY['announced'::text, 'pilot_demonstration'::text, 'small_batch_fleet'::text, 'mass_series_production'::text]))),
    CONSTRAINT oem_tech_roadmaps_confidence_admiralty_shape CHECK (((confidence_admiralty IS NULL) OR (confidence_admiralty ~ '^[A-F][1-6]$'::text))),
    CONSTRAINT oem_tech_roadmaps_density_basis_check CHECK ((density_basis = ANY (ARRAY['cell'::text, 'module'::text, 'pack'::text]))),
    CONSTRAINT oem_tech_roadmaps_density_requires_basis CHECK (((energy_density_wh_kg IS NULL) OR (density_basis IS NOT NULL))),
    CONSTRAINT oem_tech_roadmaps_derivation_check CHECK ((derivation = ANY (ARRAY['statutory_fixed'::text, 'statutory_formula'::text, 'observed'::text, 'transacted_index'::text, 'assessed'::text, 'calculated'::text, 'interpolated'::text, 'modelled'::text, 'estimated'::text]))),
    CONSTRAINT oem_tech_roadmaps_origin_class_check CHECK ((origin_class = ANY (ARRAY['community'::text, 'community-corroborated'::text, 'modelled'::text, 'derived'::text, 'partner'::text, 'verified'::text, 'official'::text]))),
    CONSTRAINT oem_tech_roadmaps_tech_category_check CHECK ((tech_category = ANY (ARRAY['heavy_battery'::text, 'megawatt_charging'::text, 'hydrogen_fcell'::text, 'ammonia_engine'::text, 'methanol_dualfuel'::text, 'saf_refinery'::text, 'e_axle'::text, 'reefer_electrification'::text])))
);


--
-- Name: TABLE oem_tech_roadmaps; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.oem_tech_roadmaps IS 'Spec 09 §1.1: OEM equipment roadmap, TRL 7-9, the bridge between Research (TRL 1-6) and Market Intel spot rates. An OEM announcement is a VENDOR claim — typically confidence_admiralty B2/C2, never treated as verified capability. Feeds src/lib/spec09/oem-payload.mjs.';


--
-- Name: COLUMN oem_tech_roadmaps.manufacturer_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.oem_tech_roadmaps.manufacturer_id IS 'entities(entity_id), kind expected = organisation. Not DB-enforced.';


--
-- Name: COLUMN oem_tech_roadmaps.energy_density_wh_kg; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.oem_tech_roadmaps.energy_density_wh_kg IS 'PACK level only when density_basis=''pack''. Spec 09 §5 open decision 3, conservative default: src/lib/spec09/oem-payload.mjs computes a payload-penalty delta ONLY when density_basis=''pack''; cell/module-basis rows render M (missing) for that derived figure rather than a flattered pack estimate.';


--
-- Name: COLUMN oem_tech_roadmaps.announced_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.oem_tech_roadmaps.announced_at IS 'The date the OEM announced the item. NULL when the row''s source evidences the stage but not an announcement date (the EEA heavy-duty vehicle CO2 extract, migration 380); a date is never estimated from a registration or dataset date.';


--
-- Name: COLUMN oem_tech_roadmaps.source_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.oem_tech_roadmaps.source_id IS 'public.sources(id) — the registry source that carried the OEM claim. NOT NULL: an OEM announcement with no citable source is not evidence of intent, it is unsourced.';


--
-- Name: COLUMN oem_tech_roadmaps.origin_class; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.oem_tech_roadmaps.origin_class IS 'Full 7-value vocabulary (src/lib/contracts/vocabularies.mjs ORIGIN_CLASSES), NOT spec 09''s own narrower illustrative CHECK.';


--
-- Name: org_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    invited_email text NOT NULL,
    invited_by_user_id uuid NOT NULL,
    proposed_role text DEFAULT 'member'::text NOT NULL,
    token text DEFAULT encode(extensions.gen_random_bytes(32), 'hex'::text) NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '14 days'::interval) NOT NULL,
    accepted_at timestamp with time zone,
    accepted_by_user_id uuid,
    declined_at timestamp with time zone,
    revoked_at timestamp with time zone,
    revoked_by_user_id uuid,
    CONSTRAINT org_invitations_email_lower_chk CHECK ((invited_email = lower(invited_email))),
    CONSTRAINT org_invitations_proposed_role_check CHECK ((proposed_role = ANY (ARRAY['admin'::text, 'member'::text, 'viewer'::text]))),
    CONSTRAINT org_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text, 'expired'::text, 'revoked'::text])))
);


--
-- Name: TABLE org_invitations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.org_invitations IS 'Invitation lifecycle for adding people to an org. Bearer-token model: anyone with the token can accept or decline. Migration 076 / Workstream B.';


--
-- Name: COLUMN org_invitations.proposed_role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.org_invitations.proposed_role IS 'Role the invitee gets in org_memberships on accept. Constrained to admin/member/viewer (owner is reserved for org creator).';


--
-- Name: COLUMN org_invitations.token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.org_invitations.token IS '32-byte hex string. Bearer credential — anyone holding the token can accept or decline. Created with pgcrypto gen_random_bytes(32). Single-use: status flips to accepted/declined on action.';


--
-- Name: COLUMN org_invitations.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.org_invitations.expires_at IS 'Default now() + 14 days. Lookup endpoints treat status pending + now() > expires_at as "expired" without writing a row update (lazy expiry).';


--
-- Name: org_member_bans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_member_bans (
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    banned_by uuid,
    banned_at timestamp with time zone DEFAULT now() NOT NULL,
    reason text
);


--
-- Name: TABLE org_member_bans; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.org_member_bans IS 'Org-scoped member bans (operator ruling 2026-07-07). A row means (user_id) may not rejoin (org_id) — enforced in accept_invitation() and the members-route add path. NOT a platform-wide account ban; the account is unaffected in every other workspace. Lifting a ban = DELETE the row.';


--
-- Name: org_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT org_memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text, 'viewer'::text])))
);


--
-- Name: TABLE org_memberships; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.org_memberships IS 'Maps users to organizations. A user can belong to multiple orgs.';


--
-- Name: COLUMN org_memberships.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.org_memberships.role IS 'Org-internal role. CHECK constraint values: owner | admin | member | viewer (per migration 006:45). owner = org creator; admin = org administrator (can invite/remove members, edit workspace_settings); member = default (read intelligence, assign actions on own watchlist); viewer = read-only. This signal does NOT grant platform-admin access. Customer org owners and admins administer their own org only. For Caro''s Ledge internal staff status, see profiles.is_platform_admin. Phase 7 introduces requireOrgAdmin(org_id) helper that reads this column scoped to a specific org_id; the legacy isPlatformAdmin() helper at src/lib/auth/admin.ts is misnamed (reads this column) and is being split per docs/sprint-1/phase-1-admin-signals.md Option C.';


--
-- Name: org_watchlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.org_watchlist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    added_by_user_id uuid,
    item_type text NOT NULL,
    item_id text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT org_watchlist_item_type_check CHECK ((item_type = ANY (ARRAY['source'::text, 'reg'::text, 'signal'::text, 'research'::text, 'operations'::text, 'market_series'::text])))
);


--
-- Name: TABLE org_watchlist; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.org_watchlist IS 'Team-shared watchlist (visible to all org members). Complements user_watchlist (personal). Migration 077 / Workstream C.';


--
-- Name: COLUMN org_watchlist.item_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.org_watchlist.item_type IS 'Kind of watched item. Vocabulary mirrors user_watchlist (migration 233): source|reg|signal|research|operations. Kept in lockstep, the two tables are the team and personal scopes of one feature.';


--
-- Name: COLUMN org_watchlist.note; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.org_watchlist.note IS 'Optional rationale shown to every org member on the team watchlist. Personal watches carry no note.';


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    plan text DEFAULT 'free'::text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organizations_plan_check CHECK ((plan = ANY (ARRAY['free'::text, 'pro'::text, 'enterprise'::text])))
);


--
-- Name: TABLE organizations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.organizations IS 'Multi-tenant root entity. Every workspace belongs to one org.';


--
-- Name: pending_first_fetch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_first_fetch (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    queued_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    last_attempt_at timestamp with time zone,
    last_error_text text,
    CONSTRAINT pending_first_fetch_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'fetching'::text, 'done'::text, 'error'::text, 'skipped'::text])))
);


--
-- Name: TABLE pending_first_fetch; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pending_first_fetch IS 'Wave 1b first-fetch queue. One row per source eligible for first ingestion. Trigger on sources INSERT/UPDATE OF auto_run_enabled enqueues; /api/worker/drain-first-fetch drains.';


--
-- Name: COLUMN pending_first_fetch.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pending_first_fetch.status IS 'Lifecycle: queued (waiting), fetching (drain worker claimed), done (success), error (last attempt failed, may retry), skipped (terminal skip e.g. provisional source or pre-existing intelligence_items row).';


--
-- Name: pending_jurisdiction_review; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_jurisdiction_review (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    intelligence_item_id uuid NOT NULL,
    current_value text NOT NULL,
    flagged_reason text NOT NULL,
    source_column text DEFAULT 'jurisdictions'::text NOT NULL,
    flagged_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    resolution_value text,
    CONSTRAINT pjr_resolution_consistency CHECK ((((resolved_at IS NULL) AND (resolved_by IS NULL) AND (resolution_value IS NULL)) OR ((resolved_at IS NOT NULL) AND (resolved_by IS NOT NULL)))),
    CONSTRAINT pjr_valid_flagged_reason CHECK ((flagged_reason = ANY (ARRAY['continent'::text, 'region_bucket'::text, 'undefined_group'::text]))),
    CONSTRAINT pjr_valid_source_column CHECK ((source_column = ANY (ARRAY['jurisdictions'::text, 'jurisdiction_iso'::text])))
);


--
-- Name: TABLE pending_jurisdiction_review; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.pending_jurisdiction_review IS 'Existing-row jurisdiction reclassification queue. One row per (intelligence_item, flagged_token, source_column) tuple needing operator triage: continents (ASIA, EUROPE, AFRICA, ...), region buckets (LATAM, MEAF, APAC, EMEA, CARIBBEAN, AMERICAS, ...), undefined groups (DEVELOPING_COUNTRIES, G7, BRICS, ...). Populated initially by migration 082 with ~107 token-rows across ~72 items per Phase 3 operator decisions 2/3/4 (the 84-item estimate). Subsequently populated by the BEFORE INSERT/UPDATE trigger on intelligence_items. Read/Update gated to profiles.is_platform_admin via RLS. No DELETE policy (audit integrity). Phase 7 triage UI consumes this for the reclassification tab.';


--
-- Name: COLUMN pending_jurisdiction_review.source_column; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pending_jurisdiction_review.source_column IS 'Which column on intelligence_items the flagged token came from: jurisdictions or jurisdiction_iso. Phase 7 triage writes the chosen canonical back to the same column. Per OBS-4 in docs/sprint-1/followups.md.';


--
-- Name: COLUMN pending_jurisdiction_review.resolution_value; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.pending_jurisdiction_review.resolution_value IS 'Operator-chosen canonical replacement, OR NULL if operator chose to discard the flagged value entirely. resolution_consistency CHECK allows NULL here when resolved_at and resolved_by are set.';


--
-- Name: portal_link_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portal_link_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    url text NOT NULL,
    anchor_text text,
    status text DEFAULT 'candidate'::text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    disposition_reason text,
    dispositioned_at timestamp with time zone,
    item_id uuid,
    CONSTRAINT portal_link_candidates_status_check CHECK ((status = ANY (ARRAY['candidate'::text, 'promoted'::text, 'rejected'::text])))
);


--
-- Name: TABLE portal_link_candidates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portal_link_candidates IS 'P2-5 portal deep-link discovery: candidate instrument URLs extracted from portal-source renders by check-sources (portal-links.mjs). Discovery only — classification/staging rides the loop flip.';


--
-- Name: COLUMN portal_link_candidates.disposition_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.portal_link_candidates.disposition_reason IS 'B1 consumer (mig 220): why the row left candidate — entity-gate verdict, chokepoint reject reason, or mint trail. A disposition without a reason is the RD-6 silent-backlog shape.';


--
-- Name: COLUMN portal_link_candidates.item_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.portal_link_candidates.item_id IS 'B1 consumer (mig 220): the intelligence_item a promoted candidate minted; NULL for rejected rows.';


--
-- Name: portfolio_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portfolio_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    portfolio_id uuid NOT NULL,
    org_id uuid NOT NULL,
    member_kind text NOT NULL,
    item_id uuid,
    entity_id text,
    added_by uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT portfolio_members_kind_check CHECK ((member_kind = ANY (ARRAY['item'::text, 'corridor'::text, 'entity'::text]))),
    CONSTRAINT portfolio_members_shape_check CHECK ((((member_kind = 'item'::text) AND (item_id IS NOT NULL) AND (entity_id IS NULL)) OR ((member_kind = 'corridor'::text) AND (item_id IS NULL) AND (entity_id ~~ 'cl:corridor:%'::text)) OR ((member_kind = 'entity'::text) AND (item_id IS NULL) AND (entity_id IS NOT NULL) AND (entity_id !~~ 'cl:corridor:%'::text))))
);


--
-- Name: TABLE portfolio_members; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portfolio_members IS 'One held item, corridor or spine entity chosen into a portfolio (migration 362). Immutable: added or removed, never edited. The composite FK to portfolios(id, org_id) pins the member to its portfolio''s org.';


--
-- Name: portfolios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.portfolios (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    name_key text GENERATED ALWAYS AS (lower(btrim(name))) STORED,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT portfolios_name_len CHECK ((length(name) <= 80)),
    CONSTRAINT portfolios_name_not_blank CHECK ((length(btrim(name)) > 0))
);


--
-- Name: TABLE portfolios; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.portfolios IS 'Workspace-owned "my things" selections (migration 362, spec 00 section 5). A selection of held items and spine entities, never customer-entered data (ADR-042). Roll-ups are computed at read time, never stored.';


--
-- Name: COLUMN portfolios.name_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.portfolios.name_key IS 'GENERATED lower(btrim(name)): case-insensitive uniqueness per org via portfolios_org_name_key_uidx.';


--
-- Name: propagation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.propagation_events (
    event_id bigint NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    table_name text NOT NULL,
    row_pk text NOT NULL,
    entity_id text,
    change_kind text NOT NULL,
    old_row jsonb,
    new_row jsonb,
    txid bigint DEFAULT txid_current() NOT NULL,
    drained_at timestamp with time zone,
    drain_run_id text,
    CONSTRAINT propagation_events_change_kind_check CHECK ((change_kind = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text, 'supersede'::text])))
);


--
-- Name: TABLE propagation_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.propagation_events IS 'The transactional outbox (spec 08 §2.2 Part 1): one row per material change to a propagation source table, written in the SAME transaction as the change by emit_propagation_event(). The queue depth (count WHERE drained_at IS NULL) IS the visible flywheel tension (spec''s own words) — see the propagation_queue_depth view below. NEVER written to by anything except the trigger below and the governed drain (which only sets drained_at/drain_run_id, never touches the event''s own facts).';


--
-- Name: COLUMN propagation_events.table_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.propagation_events.table_name IS 'The changed table, e.g. ''emission_factors''. Paired with row_pk, this is the SAME (table,pk) address shape derivation_edges.(from_table,from_pk) uses (migration 285) — the join between an event and its dependents is a plain equality, no translation layer.';


--
-- Name: COLUMN propagation_events.row_pk; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.propagation_events.row_pk IS 'The changed row''s own primary key value, stringified (factor_id/id/value_id/entity_id depending on table_name — never re-derived, always the literal PK column TG_ARGV[0] names for that trigger).';


--
-- Name: COLUMN propagation_events.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.propagation_events.entity_id IS 'NULLABLE. Populated only when the changed row itself carries an entity_id column (derived_values, statutory_computations, estimated_values — migrations 285/286). NULL for emission_factors/market_series/regional_data_facts today: none of the three carries an entity_id column yet (progressive re-keying, ADR-024).';


--
-- Name: COLUMN propagation_events.change_kind; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.propagation_events.change_kind IS '''insert''/''delete'' mirror TG_OP directly. ''supersede'' is a structurally-detected UPDATE where a superseded_by-shaped column moved from NULL to NOT NULL (a correction, not an ordinary edit — spec §2.3''s worked example narrates this case in prose; this column makes it queryable). Every other UPDATE is ''update''.';


--
-- Name: COLUMN propagation_events.txid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.propagation_events.txid IS 'txid_current() of the writing transaction — lets a reader confirm two events landed atomically together, or diagnose a partial batch.';


--
-- Name: COLUMN propagation_events.drained_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.propagation_events.drained_at IS 'NULL = pending (the default, and the queue-depth signal). Set once by the governed drain (drain.ts), never by the trigger, never reset.';


--
-- Name: COLUMN propagation_events.drain_run_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.propagation_events.drain_run_id IS 'The drain run (scripts/harness-runs/propagation/propagation-run-NNN.json''s run_id) that drained this event. NULL exactly when drained_at is NULL.';


--
-- Name: propagation_events_event_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.propagation_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: propagation_events_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.propagation_events_event_id_seq OWNED BY public.propagation_events.event_id;


--
-- Name: propagation_queue_depth; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.propagation_queue_depth WITH (security_invoker='on') AS
 SELECT count(*) AS pending_count,
    min(propagation_events.occurred_at) AS oldest_pending_at
   FROM public.propagation_events
  WHERE (propagation_events.drained_at IS NULL);


--
-- Name: provisional_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provisional_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    domain integer,
    discovered_via text DEFAULT 'citation_detection'::text NOT NULL,
    cited_by_source_id uuid,
    cited_by_source_tier integer,
    citation_count integer DEFAULT 1 NOT NULL,
    independent_citers integer DEFAULT 0 NOT NULL,
    citing_source_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    highest_citing_tier integer,
    provisional_tier integer DEFAULT 7 NOT NULL,
    recommended_tier integer,
    accessibility_verified boolean DEFAULT false NOT NULL,
    publishes_structured_content boolean DEFAULT false NOT NULL,
    entity_identified boolean DEFAULT false NOT NULL,
    status text DEFAULT 'pending_review'::text NOT NULL,
    reviewer_notes text DEFAULT ''::text NOT NULL,
    promoted_to_source_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reviewed_at timestamp with time zone,
    recommended_classification jsonb,
    discovered_for_jurisdiction text,
    CONSTRAINT provisional_sources_discovered_via_check CHECK ((discovered_via = ANY (ARRAY['skill_recommendation'::text, 'citation_detection'::text, 'worker_search'::text, 'manual_add'::text]))),
    CONSTRAINT provisional_sources_domain_check CHECK (((domain IS NULL) OR ((domain >= 1) AND (domain <= 7)))),
    CONSTRAINT provisional_sources_highest_citing_tier_check CHECK (((highest_citing_tier IS NULL) OR ((highest_citing_tier >= 1) AND (highest_citing_tier <= 7)))),
    CONSTRAINT provisional_sources_provisional_tier_check CHECK (((provisional_tier >= 1) AND (provisional_tier <= 7))),
    CONSTRAINT provisional_sources_recommended_tier_check CHECK (((recommended_tier IS NULL) OR ((recommended_tier >= 1) AND (recommended_tier <= 7)))),
    CONSTRAINT provisional_sources_status_check CHECK ((status = ANY (ARRAY['pending_review'::text, 'confirmed'::text, 'rejected'::text, 'needs_more_data'::text, 'promoted'::text])))
);


--
-- Name: TABLE provisional_sources; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.provisional_sources IS 'Sources discovered via citation that await human review before entering the active registry.';


--
-- Name: COLUMN provisional_sources.url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.provisional_sources.url IS 'Canonical form (Q10, migration 087). All writes must pass through canonicalizeUrl() from src/lib/sources/url-canonicalize.ts.';


--
-- Name: COLUMN provisional_sources.recommended_classification; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.provisional_sources.recommended_classification IS 'AI-recommended classification produced by /api/admin/sources/recommend-classification. Schema: { tier: 1..7,    
  domains: int[], jurisdictions: text[], transport_modes: text[], topic_tags: text[], rationale: text, model: text, 
  computed_at: ISO timestamp }. Null until the route runs for this row. Cleared if the row''s URL changes.';


--
-- Name: COLUMN provisional_sources.discovered_for_jurisdiction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.provisional_sources.discovered_for_jurisdiction IS 'W2.B: ISO 3166-1 / 3166-2 / supranational code that the discovery agent was running against when this candidate was surfaced. NULL for rows added before W2.B or via channels that do not carry a jurisdiction context (citation extraction, manual add).';


--
-- Name: published_price_statistics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.published_price_statistics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    label text NOT NULL,
    value_display text NOT NULL,
    unit text,
    context_line text,
    severity_tone text,
    source_tier smallint,
    released_at date,
    next_release_at date,
    next_release_label text,
    sort_order smallint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT published_price_statistics_severity_tone_check CHECK (((severity_tone IS NULL) OR (severity_tone = ANY (ARRAY['critical'::text, 'high'::text, 'moderate'::text, 'low'::text, 'neutral'::text])))),
    CONSTRAINT published_price_statistics_source_tier_check CHECK (((source_tier IS NULL) OR ((source_tier >= 1) AND (source_tier <= 7))))
);


--
-- Name: TABLE published_price_statistics; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.published_price_statistics IS 'Redesign T05 signal-detail price board (HANDOFF §6.5 / §7 KNOWN NEW BACKEND). Published statistics (release-cadence anchored), NOT live ticks. One row per board figure keyed to a signal item. Empty until the price feed writer populates it — the surface renders the honest §4 published-statistics pending frame while empty (never faked figures).';


--
-- Name: raw_fetches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.raw_fetches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    content_hash text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    file_path text NOT NULL,
    http_status integer,
    html_bytes bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE raw_fetches; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.raw_fetches IS 'Immutable per-fetch provenance row. One row per successful Browserless render. file_path points at gzipped HTML in Storage bucket raw_fetches.';


--
-- Name: COLUMN raw_fetches.content_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.raw_fetches.content_hash IS 'SHA-256 hex of the raw HTML body. Used for idempotency (UNIQUE with source_id) and Wave 1b dedupe.';


--
-- Name: region_dimension_coverage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.region_dimension_coverage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    region_id uuid NOT NULL,
    dimension text NOT NULL,
    state text DEFAULT 'missing'::text NOT NULL,
    notes text,
    fact_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT region_dimension_coverage_dimension_check CHECK ((dimension = ANY (ARRAY['regulatory_feasibility'::text, 'regional_resources'::text, 'labor_markets'::text, 'materials_sourcing'::text, 'infrastructure'::text, 'operational_cost'::text, 'grid_intensity'::text]))),
    CONSTRAINT region_dimension_coverage_state_check CHECK ((state = ANY (ARRAY['populated'::text, 'partial'::text, 'pending'::text, 'missing'::text])))
);


--
-- Name: TABLE region_dimension_coverage; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.region_dimension_coverage IS 'Per-(region, dimension) coverage state index. 4 states: populated / partial / pending / missing. Powers OperationsPage coverage gap callouts + side-rail By-dimension badges. fact_count is trigger-maintained from regional_data_facts.';


--
-- Name: COLUMN region_dimension_coverage.state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.region_dimension_coverage.state IS 'populated = has sourced facts; partial = some facts but operator-marked incomplete; pending = find-new in progress; missing = no facts, not yet investigated.';


--
-- Name: COLUMN region_dimension_coverage.notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.region_dimension_coverage.notes IS 'Operator narrative for why state is partial/pending/missing. Optional. Surfaced in admin coverage review UI; not rendered to customers directly.';


--
-- Name: regional_data_facts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.regional_data_facts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    region_id uuid NOT NULL,
    dimension text NOT NULL,
    fact_label text NOT NULL,
    value text NOT NULL,
    status text,
    trend text,
    source_id uuid,
    source_note text,
    last_updated timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    value_numeric numeric,
    unit text,
    currency text,
    derivation text,
    origin_class text,
    source_key text,
    source_ref text,
    n_observations integer,
    method_version text,
    as_at_date date,
    reference_period text,
    CONSTRAINT regional_data_facts_derivation_check CHECK ((derivation = ANY (ARRAY['statutory_fixed'::text, 'statutory_formula'::text, 'observed'::text, 'transacted_index'::text, 'assessed'::text, 'calculated'::text, 'interpolated'::text, 'modelled'::text, 'estimated'::text]))),
    CONSTRAINT regional_data_facts_dimension_check CHECK ((dimension = ANY (ARRAY['regulatory_feasibility'::text, 'regional_resources'::text, 'labor_markets'::text, 'materials_sourcing'::text, 'infrastructure'::text, 'operational_cost'::text, 'grid_intensity'::text]))),
    CONSTRAINT regional_data_facts_n_observations_positive_check CHECK (((n_observations IS NULL) OR (n_observations > 0))),
    CONSTRAINT regional_data_facts_origin_class_check CHECK ((origin_class = ANY (ARRAY['community'::text, 'community-corroborated'::text, 'modelled'::text, 'derived'::text, 'partner'::text, 'verified'::text, 'official'::text]))),
    CONSTRAINT regional_data_facts_trend_check CHECK (((trend IS NULL) OR (trend = ANY (ARRAY['up'::text, 'down'::text, 'flat'::text]))))
);


--
-- Name: TABLE regional_data_facts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.regional_data_facts IS 'Per-cell fact store for Operations D2-D6 fact tables (Q7, 2026-05-24). One row per (region, dimension, fact_label). Source-cited and timestamped. Replaces the hard-coded EU/US facts currently in OperationsPage.tsx.';


--
-- Name: COLUMN regional_data_facts.dimension; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regional_data_facts.dimension IS 'One of 7 Operations dimensions. D1 regulatory_feasibility is rendered via Regulations cross-refs (no rows here); D2-D6 store actual facts; grid_intensity (migration 378) stores grid carbon intensity in gCO2/kWh per region, from a public grid operator or statistics body.';


--
-- Name: COLUMN regional_data_facts.trend; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regional_data_facts.trend IS 'up / down / flat for week-over-week or quarter-over-quarter direction. NULL when trend is not tracked.';


--
-- Name: COLUMN regional_data_facts.value_numeric; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regional_data_facts.value_numeric IS 'The number itself, decomposed out of a legacy free-text display column. NULL means this row has not been re-keyed through the envelope yet; the legacy value text column remains the display source until it is.';


--
-- Name: COLUMN regional_data_facts.unit; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regional_data_facts.unit IS 'Unit of value_numeric (e.g. EUR/tonne, index_points, USD/hour). Required to interpret value_numeric.';


--
-- Name: COLUMN regional_data_facts.currency; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regional_data_facts.currency IS 'ISO 4217 currency code, where unit denotes a monetary rate. NULL for a non-monetary fact.';


--
-- Name: COLUMN regional_data_facts.derivation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regional_data_facts.derivation IS 'How value_numeric was produced (IOSCO PD391 2.3(a)). Same 9-value vocabulary as emission_factors.derivation (migration 258), owned by src/lib/contracts/envelope.mjs DERIVATION.';


--
-- Name: COLUMN regional_data_facts.origin_class; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regional_data_facts.origin_class IS 'Where the content came from (spec 00 s3.6). Same 7-value vocabulary as emission_factors.origin_class (migration 258), owned by src/lib/contracts/vocabularies.mjs ORIGIN_CLASS. Nullable: pre-vocabulary rows stay NULL.';


--
-- Name: COLUMN regional_data_facts.source_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regional_data_facts.source_key IS 'The licence-cleared external dataset this value came from, joined through the SAME licence register emission_factors.source_key uses (public.data_sources / licence_clear_sources). Deliberately not the sources FK, which is the editorial trust-tier register - a different question.';


--
-- Name: COLUMN regional_data_facts.source_ref; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regional_data_facts.source_ref IS 'The table, row, page or series id within the source, so a reader can check the figure without re-deriving it.';


--
-- Name: COLUMN regional_data_facts.n_observations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regional_data_facts.n_observations IS 'Sample size behind an aggregated figure. Governs significant-figure rounding at render (envelope.mjs significantFigures()).';


--
-- Name: COLUMN regional_data_facts.method_version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regional_data_facts.method_version IS 'Version tag of the method that produced value_numeric, when derivation is calculated/modelled/estimated.';


--
-- Name: COLUMN regional_data_facts.as_at_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regional_data_facts.as_at_date IS 'When the source asserted this value (not ingest time, not event time - envelope.mjs as-of triple keeps the three separate).';


--
-- Name: COLUMN regional_data_facts.reference_period; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regional_data_facts.reference_period IS 'The period value_numeric describes (e.g. 2026-Q2, 2026-07), for a period aggregate rather than a point observation.';


--
-- Name: regions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.regions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    label text NOT NULL,
    severity text,
    iso_codes text[] DEFAULT '{}'::text[] NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT regions_severity_check CHECK (((severity IS NULL) OR (severity = ANY (ARRAY['critical'::text, 'high'::text, 'moderate'::text, 'low'::text]))))
);


--
-- Name: TABLE regions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.regions IS 'Canonical region rows the Operations surface pivots on (Q7, 2026-05-24). Today: EU, US, ASIA, UK, UAE. Expansion-friendly.';


--
-- Name: COLUMN regions.iso_codes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.regions.iso_codes IS 'ISO 3166 codes this region groups (e.g. EU groups DE, NL, BE, FR, IT, ES). Used by the Operations regional grouping logic to match resource.jurisdiction to a canonical region.';


--
-- Name: reroute_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reroute_events (
    reroute_id uuid DEFAULT gen_random_uuid() NOT NULL,
    baseline_corridor_id text NOT NULL,
    reroute_corridor_id text NOT NULL,
    cause text NOT NULL,
    distance_delta_nm numeric,
    transit_delta_days numeric,
    fuel_burn_multiplier numeric NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reroute_events_cause_check CHECK ((length(cause) > 0)),
    CONSTRAINT reroute_events_distinct_corridors CHECK ((baseline_corridor_id <> reroute_corridor_id)),
    CONSTRAINT reroute_events_effective_range_ordered CHECK (((effective_to IS NULL) OR (effective_to >= effective_from))),
    CONSTRAINT reroute_events_fuel_burn_multiplier_check CHECK ((fuel_burn_multiplier > (0)::numeric))
);


--
-- Name: TABLE reroute_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.reroute_events IS 'Spec 09 §1.7: the corridor-fix motivator (spec 09 §0). baseline_corridor_id and reroute_corridor_id are DIFFERENT entities.kind=''corridor'' rows by construction (reroute_events_distinct_corridors). src/lib/spec09/reroute.mjs applies fuel_burn_multiplier as a scaling function and names the five-surface compounding chain for the UI notice; it does NOT compute the bracketed FuelEU/EU-ETS penalty itself.';


--
-- Name: COLUMN reroute_events.baseline_corridor_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.reroute_events.baseline_corridor_id IS 'entities(entity_id), kind expected = corridor. Not DB-enforced.';


--
-- Name: COLUMN reroute_events.reroute_corridor_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.reroute_events.reroute_corridor_id IS 'entities(entity_id), kind expected = corridor, and REQUIRED to differ from baseline_corridor_id.';


--
-- Name: research_assessments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_assessments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid NOT NULL,
    supersedes uuid,
    is_current boolean DEFAULT true NOT NULL,
    technical_maturity_low smallint,
    technical_maturity_high smallint,
    technical_maturity_method text,
    technical_maturity_evidence_ids text[] DEFAULT '{}'::text[] NOT NULL,
    commercial_maturity_low smallint,
    commercial_maturity_high smallint,
    commercial_maturity_method text,
    commercial_maturity_evidence_ids text[] DEFAULT '{}'::text[] NOT NULL,
    horizon_kind text,
    horizon_band text,
    horizon_rule text,
    horizon_confidence text,
    horizon_trigger_note text,
    refusal_reason text,
    credibility_evidence_score text,
    credibility_authority_score jsonb,
    computed_by text NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    status_token text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    entity_id text,
    lifecycle_state text DEFAULT 'emerging'::text NOT NULL,
    CONSTRAINT research_assessments_commercial_corridor_order CHECK (((commercial_maturity_low IS NULL) OR (commercial_maturity_high IS NULL) OR (commercial_maturity_low <= commercial_maturity_high))),
    CONSTRAINT research_assessments_commercial_maturity_high_check CHECK (((commercial_maturity_high >= 1) AND (commercial_maturity_high <= 6))),
    CONSTRAINT research_assessments_commercial_maturity_low_check CHECK (((commercial_maturity_low >= 1) AND (commercial_maturity_low <= 6))),
    CONSTRAINT research_assessments_credibility_evidence_score_check CHECK ((credibility_evidence_score = ANY (ARRAY['limited'::text, 'medium'::text, 'robust'::text]))),
    CONSTRAINT research_assessments_horizon_band_check CHECK ((horizon_band = ANY (ARRAY['NOW'::text, 'NEAR'::text, 'MID'::text, 'FAR'::text]))),
    CONSTRAINT research_assessments_horizon_confidence_check CHECK ((horizon_confidence = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text]))),
    CONSTRAINT research_assessments_horizon_kind_check CHECK ((horizon_kind = ANY (ARRAY['availability'::text, 'economic'::text, 'obligation'::text]))),
    CONSTRAINT research_assessments_horizon_or_refusal CHECK ((((horizon_band IS NOT NULL) AND (horizon_rule IS NOT NULL) AND (refusal_reason IS NULL)) OR ((horizon_band IS NULL) AND (horizon_rule IS NULL) AND (refusal_reason IS NOT NULL)))),
    CONSTRAINT research_assessments_horizon_rule_check CHECK ((horizon_rule = ANY (ARRAY['R1'::text, 'R2'::text, 'R3'::text, 'R4'::text]))),
    CONSTRAINT research_assessments_lifecycle_state_check CHECK ((lifecycle_state = ANY (ARRAY['emerging'::text, 'strengthening'::text, 'corroborated'::text, 'verified'::text, 'stalled'::text, 'falsified'::text, 'superseded'::text, 'obsolete'::text]))),
    CONSTRAINT research_assessments_status_token_check CHECK ((status_token = ANY (ARRAY['CONFIRMED'::text, 'HYPOTHESIS'::text]))),
    CONSTRAINT research_assessments_technical_corridor_order CHECK (((technical_maturity_low IS NULL) OR (technical_maturity_high IS NULL) OR (technical_maturity_low <= technical_maturity_high))),
    CONSTRAINT research_assessments_technical_maturity_high_check CHECK (((technical_maturity_high >= 1) AND (technical_maturity_high <= 11))),
    CONSTRAINT research_assessments_technical_maturity_low_check CHECK (((technical_maturity_low >= 1) AND (technical_maturity_low <= 11)))
);


--
-- Name: TABLE research_assessments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.research_assessments IS 'Lane W2-R, migration 344. Spec 03''s atomic unit for /research: one current row per item_id (research_finding, plus technology/innovation items surfaceOf() routes to research), superseded chain carried via `supersedes` (spec section 7 row 11, append-only history). Never hand-edited; written only by scripts/producers/research/research-assessment-producer.mjs through the guarded path.';


--
-- Name: COLUMN research_assessments.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.research_assessments.entity_id IS 'Progressive-re-keying FK (ADR-024/ADR-039(e), pattern = migration 283''s instrument_entity_id/organisation_entity_id). Nullable, additive, backfilled by a SEPARATE later guarded script (not this migration). Lets a research assessment be found FROM the entity (corridor, instrument, technology) it is about. Does NOT make "assessment" an entity kind -- research_assessments keeps its own uuid PK, unchanged.';


--
-- Name: COLUMN research_assessments.lifecycle_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.research_assessments.lifecycle_state IS 'Spec 08 section 3.1''s lifecycle axis (what the evidence has DONE), reused verbatim from the SAME 8-value vocabulary derived_values.lifecycle already carries (src/lib/propagation/types.ts Lifecycle). Written only by src/lib/propagation/methods/signpost-watch.ts''s fireSignpost() on a signpost firing, per the transitions that file documents (direction=refutes -> falsified per spec 08''s own table; direction=confirms advances one step toward corroborated, never auto-promoting to verified, which spec 08''s table reserves for an editor+PROV action; direction=delays -> stalled, [RULED 2026-10-02, coordinator, under ADR-039] -- see signpost-watch.ts header). Added by migration 346, not migration 344 -- that table shipped before this lifecycle concept existed on it.';


--
-- Name: research_assessments_current; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.research_assessments_current WITH (security_invoker='on') AS
 SELECT ra.id,
    ra.item_id,
    ra.supersedes,
    ra.is_current,
    ra.technical_maturity_low,
    ra.technical_maturity_high,
    ra.technical_maturity_method,
    ra.technical_maturity_evidence_ids,
    ra.commercial_maturity_low,
    ra.commercial_maturity_high,
    ra.commercial_maturity_method,
    ra.commercial_maturity_evidence_ids,
    ra.horizon_kind,
    ra.horizon_band,
    ra.horizon_rule,
    ra.horizon_confidence,
    ra.horizon_trigger_note,
    ra.refusal_reason,
    ra.credibility_evidence_score,
    ra.credibility_authority_score,
    ra.computed_by,
    ra.computed_at,
    ra.status_token,
    ra.created_at,
    ra.entity_id,
    ra.lifecycle_state
   FROM public.research_assessments ra
  WHERE ra.is_current;


--
-- Name: VIEW research_assessments_current; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.research_assessments_current IS 'The ONE view Research''s read path selects from (src/lib/research/read-assessments.mjs). Runs with the DEFINER''s row-visibility, not the querying role''s -- deliberately NOT security_invoker, the same mechanism migration 285''s derived_values_admissible documents for itself. Enforce via code review: a new reader of research_assessments (the raw table) outside src/lib/research/ is the defect class this view exists to prevent.';


--
-- Name: section_claim_provenance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.section_claim_provenance (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    section_row_id uuid,
    intelligence_item_id uuid,
    claim_text text NOT NULL,
    claim_kind text NOT NULL,
    source_span text,
    source_id uuid,
    search_result_id uuid,
    source_tier_at_grounding integer,
    extracted_at timestamp with time zone DEFAULT now() NOT NULL,
    verified_at timestamp with time zone,
    mint_hold_reason text,
    basis_claim_id uuid,
    CONSTRAINT scp_derived_requires_basis CHECK (((claim_kind <> 'DERIVED'::text) OR (basis_claim_id IS NOT NULL))),
    CONSTRAINT section_claim_provenance_claim_kind_check CHECK ((claim_kind = ANY (ARRAY['FACT'::text, 'ANALYSIS'::text, 'LEGAL'::text, 'GAP'::text, 'DERIVED'::text])))
);


--
-- Name: TABLE section_claim_provenance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.section_claim_provenance IS 'Per-claim provenance (Sprint 4 Addition A core). One row per substantive claim emitted in a section. claim_kind in (FACT, ANALYSIS, LEGAL, GAP). FACT claims must carry a source_span + source_id grounded in the cited source; CRITICAL/HIGH items require source_tier_at_grounding in (1,2) (enforced by validate_item_provenance, task 1.3). verified_by / verified_at populated by the admin verification queue (Component 6).';


--
-- Name: COLUMN section_claim_provenance.source_tier_at_grounding; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.section_claim_provenance.source_tier_at_grounding IS 'Snapshot of the grounding source effective_tier at validation time, used for the CRITICAL/HIGH per-claim authority floor.';


--
-- Name: COLUMN section_claim_provenance.mint_hold_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.section_claim_provenance.mint_hold_reason IS 'Hardening A1 flip (2026-07-16). Set by the mint-time S-CONFLATE HARD gate to hold a FACT (held-not-verified until re-ground clears it). validate_item_provenance criterion 3 fails on any non-null value. NULL on every pre-flip fact (non-regressive by construction). S-NUMERIC is a SOFT hold (integrity_flag, item stays verified-eligible) and does NOT set this.';


--
-- Name: COLUMN section_claim_provenance.basis_claim_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.section_claim_provenance.basis_claim_id IS 'Gate B (mig 227): for a claim_kind=DERIVED row, the FK to the FACT claim (recurring rule) this derived instance is computed from. The Gate-A scanner credits the DERIVED token ONLY while this basis FACT exists and its span still verbatim-matches its stored capture (staleness reverts the derived token to orphan).';


--
-- Name: sector_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sector_contexts (
    sector text NOT NULL,
    display_name text NOT NULL,
    transport_modes text[] DEFAULT '{}'::text[] NOT NULL,
    cargo_types text[] DEFAULT '{}'::text[] NOT NULL,
    compliance_roles text[] DEFAULT '{}'::text[] NOT NULL,
    synopsis_prompt text NOT NULL,
    urgency_weights jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: sensitive_field_policy; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sensitive_field_policy (
    table_name text NOT NULL,
    column_name text NOT NULL,
    k_min integer DEFAULT 10 NOT NULL,
    max_share_pct numeric DEFAULT 25.0 NOT NULL,
    min_lag_days integer DEFAULT 90 NOT NULL,
    forward_looking_allowed boolean DEFAULT false NOT NULL,
    bucket_scheme text DEFAULT 'undefined'::text NOT NULL,
    policy text,
    CONSTRAINT sensitive_field_policy_k_min_adr035 CHECK ((k_min >= 10)),
    CONSTRAINT sensitive_field_policy_max_share_pct_check CHECK (((max_share_pct > (0)::numeric) AND (max_share_pct <= (100)::numeric))),
    CONSTRAINT sensitive_field_policy_min_lag_days_check CHECK ((min_lag_days >= 0))
);


--
-- Name: TABLE sensitive_field_policy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sensitive_field_policy IS 'Spec 08 §5.1: per-field write-time policy for any commercially sensitive aggregate. k_min >= 5 is the floor; max_share_pct is the dominance cap; min_lag_days is both the publication lag and the §5.2(c) freeze window; forward_looking_allowed=false refuses future periods; bucket_scheme (pct:N | abs:N | log2) is how a granted value is rounded, never raw. Enforced by publish_aggregate(); the JS mirror is src/lib/propagation/aggregate-safeguards.mjs.';


--
-- Name: signposts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signposts (
    entity_id text NOT NULL,
    assessment_id uuid NOT NULL,
    watches text NOT NULL,
    predicate jsonb NOT NULL,
    direction text NOT NULL,
    fired_at timestamp with time zone,
    inference_record_id uuid,
    outcome text,
    outcome_assessed_at timestamp with time zone,
    scored_by text,
    lifecycle_applied_at timestamp with time zone,
    CONSTRAINT predicate_is_evaluable CHECK ((predicate ? 'op'::text)),
    CONSTRAINT signposts_direction_check CHECK ((direction = ANY (ARRAY['confirms'::text, 'refutes'::text, 'delays'::text]))),
    CONSTRAINT signposts_outcome_check CHECK ((outcome = ANY (ARRAY['held'::text, 'refuted'::text, 'partial'::text]))),
    CONSTRAINT signposts_score_columns_together CHECK ((((outcome IS NULL) AND (outcome_assessed_at IS NULL) AND (scored_by IS NULL)) OR ((outcome IS NOT NULL) AND (outcome_assessed_at IS NOT NULL) AND (scored_by IS NOT NULL))))
);


--
-- Name: TABLE signposts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.signposts IS 'Spec 08 section 1.2''s signpost DDL, amended by the coordinator''s 2026-10-02 schema ruling: assessment_id is a direct uuid FK to research_assessments(id), not a detour through the entity spine (research_assessments is outside the spine proper, joined only via its own entity_id progressive-re-keying column above). watches keeps its original text REFERENCES entities(entity_id) shape. A machine-observable predicate whose firing changes a Research assessment''s lifecycle_state -- the mechanism that closes Loop B on the Research surface with zero human-approval affordance anywhere in the firing path (doctrine research-is-horizon-scan). Written by src/lib/propagation/methods/signpost-watch.ts.';


--
-- Name: COLUMN signposts.predicate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.signposts.predicate IS 'jsonb, must carry an "op" key (predicate_is_evaluable CHECK). Shapes signpost-watch.ts evaluates: {op:"date_passed", field:"..."} | {op:"threshold", metric:"...", gte:N} | {op:"count_gte", relation:"...", n:N}.';


--
-- Name: COLUMN signposts.direction; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.signposts.direction IS 'confirms | refutes | delays -- see research_assessments.lifecycle_state''s comment for the transition each direction drives on firing.';


--
-- Name: COLUMN signposts.inference_record_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.signposts.inference_record_id IS 'Nullable FK to the inference_records row whose forward-looking claim this signpost tracks (learning-loop-design section 3). Unset for an assessment-derived signpost.';


--
-- Name: COLUMN signposts.outcome; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.signposts.outcome IS 'held | refuted | partial, NULL until scored. A fired signpost scores by direction (confirms held, refutes refuted, delays partial); an expectation date (predicate.by) that passes with no firing scores refuted. Written once by src/lib/learning/prediction-scoring.mjs.';


--
-- Name: COLUMN signposts.outcome_assessed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.signposts.outcome_assessed_at IS 'When the outcome was scored.';


--
-- Name: COLUMN signposts.scored_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.signposts.scored_by IS 'The method id and version that scored the outcome, e.g. signpost_watch@1.0.0.';


--
-- Name: COLUMN signposts.lifecycle_applied_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.signposts.lifecycle_applied_at IS 'NULL until the assessment lifecycle update for this signpost''s firing has been recorded as made, then when it was made; never cleared. Set only by src/lib/learning/prediction-scoring.mjs, only where still NULL: right after fireSignpost moves research_assessments.lifecycle_state for a firing, or by the repair pass after it applies nextLifecycleState to a signpost found fired with this column NULL. The repair applies the transition only where this is NULL, so a failed lifecycle update is retried once and a succeeded one is never applied twice. A signpost that never fired never has it set.';


--
-- Name: source_bias_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_bias_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    dimension text NOT NULL,
    tag text NOT NULL,
    confidence numeric(3,2),
    assignment_source text NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_bias_tags_assignment_source_chk CHECK ((assignment_source = ANY (ARRAY['haiku_auto_high_confidence'::text, 'haiku_proposed_low_confidence'::text, 'operator_confirmed'::text, 'operator_set'::text]))),
    CONSTRAINT source_bias_tags_confidence_check CHECK (((confidence IS NULL) OR ((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))),
    CONSTRAINT source_bias_tags_dimension_chk CHECK ((dimension = ANY (ARRAY['funding'::text, 'methodology'::text, 'stakeholder'::text]))),
    CONSTRAINT source_bias_tags_vocabulary_chk CHECK ((((dimension = 'funding'::text) AND (tag = ANY (ARRAY['industry-funded'::text, 'government-funded'::text, 'foundation-funded'::text, 'subscription-supported'::text, 'academic-institutional'::text, 'mixed-funded'::text, 'funding-opaque'::text]))) OR ((dimension = 'methodology'::text) AND (tag = ANY (ARRAY['peer-reviewed'::text, 'methodologically-transparent'::text, 'analytical-synthesis'::text, 'editorial-opinion'::text, 'advocacy'::text, 'factual-reporting'::text, 'standards-defining'::text]))) OR ((dimension = 'stakeholder'::text) AND (tag = ANY (ARRAY['industry-incumbent'::text, 'industry-challenger'::text, 'regulator-aligned'::text, 'environmental-advocate'::text, 'independent-research'::text, 'customer-perspective'::text, 'labor-perspective'::text, 'investor-perspective'::text])))))
);


--
-- Name: TABLE source_bias_tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.source_bias_tags IS 'Q4: bias tags on sources, three dimensions (funding / methodology / stakeholder), multi-value within each. Per source-credibility-model SKILL.md Section 6. Vocabulary verbatim from operator decision.';


--
-- Name: COLUMN source_bias_tags.dimension; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_bias_tags.dimension IS 'One of funding / methodology / stakeholder. Vocabulary partitioned per source_bias_tags_vocabulary_chk.';


--
-- Name: COLUMN source_bias_tags.tag; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_bias_tags.tag IS 'Lower-case kebab-case bias tag from the Q4 vocabulary. Validity enforced per dimension by source_bias_tags_vocabulary_chk.';


--
-- Name: COLUMN source_bias_tags.confidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_bias_tags.confidence IS 'Classifier confidence in this assignment, 0.00 to 1.00. NULL for operator_set rows where confidence is not applicable.';


--
-- Name: COLUMN source_bias_tags.assignment_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_bias_tags.assignment_source IS 'How this row was created: haiku_auto_high_confidence (>=0.80), haiku_proposed_low_confidence (0.65-0.80, awaits operator confirm), operator_confirmed (operator accepted a haiku proposal), operator_set (operator-authored).';


--
-- Name: source_citations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_citations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    citing_source_id uuid NOT NULL,
    cited_source_id uuid NOT NULL,
    context text DEFAULT ''::text NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE source_citations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.source_citations IS 'Which sources cite which other sources. Drives independent_citers metric and trust scoring.';


--
-- Name: source_reliability_ledger; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_reliability_ledger (
    id bigint NOT NULL,
    source_id uuid NOT NULL,
    signpost_entity_id text NOT NULL,
    assessment_id uuid NOT NULL,
    outcome text NOT NULL,
    scored_at timestamp with time zone DEFAULT now() NOT NULL,
    scored_by text NOT NULL,
    CONSTRAINT source_reliability_ledger_outcome_check CHECK ((outcome = ANY (ARRAY['held'::text, 'refuted'::text, 'partial'::text])))
);


--
-- Name: TABLE source_reliability_ledger; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.source_reliability_ledger IS 'Append-only evidence (ADR-044 decision 4): one row per source per scored prediction. The sources are those of the assessed item''s grounded FACT and LEGAL claims. Written only by src/lib/learning/prediction-scoring.mjs. Never writes a tier: src/lib/trust.ts tallies it as one more delta inside the existing clamp, and tier_override wins.';


--
-- Name: source_reliability_ledger_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.source_reliability_ledger_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: source_reliability_ledger_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.source_reliability_ledger_id_seq OWNED BY public.source_reliability_ledger.id;


--
-- Name: source_tier_opinions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_tier_opinions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    target_source_id uuid NOT NULL,
    opining_source_id uuid,
    intelligence_item_id uuid,
    opined_tier integer NOT NULL,
    opinion_source text NOT NULL,
    opined_at timestamp with time zone DEFAULT now() NOT NULL,
    dismissed_at timestamp with time zone,
    dismissed_by uuid,
    dismissed_reason text,
    CONSTRAINT source_tier_opinions_opined_tier_check CHECK (((opined_tier >= 1) AND (opined_tier <= 7))),
    CONSTRAINT source_tier_opinions_opinion_source_check CHECK ((opinion_source = ANY (ARRAY['haiku_brief_classifier'::text, 'haiku_verification'::text, 'operator_review'::text, 'host_class_table'::text])))
);


--
-- Name: TABLE source_tier_opinions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.source_tier_opinions IS 'Q3 tier-opinion preservation per source-credibility-model skill Section 5. Records every tier estimate observed for an existing source (target_source_id) so recurring estimates that disagree with the source''s currently-stored tier can be aggregated and surfaced for operator review. Opinions accumulate independently of the source_citations edge (one edge, many opinions over time). Disagreement detection lives in public.get_tier_opinion_disagreements(window_days).';


--
-- Name: COLUMN source_tier_opinions.target_source_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_tier_opinions.target_source_id IS 'The source the opinion is ABOUT. References public.sources(id).';


--
-- Name: COLUMN source_tier_opinions.opining_source_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_tier_opinions.opining_source_id IS 'The source that produced the opinion (the citing source whose brief generation emitted the tier estimate). Nullable for non-source-attributed opinions (e.g. operator_review). SET NULL on source delete to preserve the opinion as evidence even if the opining source is later removed.';


--
-- Name: COLUMN source_tier_opinions.intelligence_item_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_tier_opinions.intelligence_item_id IS 'The intelligence_items row whose generation produced the opinion. Nullable for opinion sources that do not originate from a brief (e.g. operator_review). SET NULL on item delete to preserve the opinion.';


--
-- Name: COLUMN source_tier_opinions.opined_tier; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_tier_opinions.opined_tier IS 'The tier (1-7) the opining process estimated for target_source_id. CHECK mirrors the existing sources.tier domain.';


--
-- Name: COLUMN source_tier_opinions.opinion_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_tier_opinions.opinion_source IS 'Which process emitted the opinion. Enumerated: haiku_brief_classifier (the brief-generation agent''s "New Sources Identified" table), haiku_verification (future Haiku spot-check), operator_review (future operator-driven evidence).';


--
-- Name: COLUMN source_tier_opinions.opined_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_tier_opinions.opined_at IS 'When the opinion was recorded. Drives the 90-day window in the aggregator.';


--
-- Name: COLUMN source_tier_opinions.dismissed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_tier_opinions.dismissed_at IS 'Operator dismissal timestamp. NULL means the opinion is still in the active disagreement pool. Set via /api/admin/sources/tier-opinions reject action (Phase 7 admin chrome).';


--
-- Name: COLUMN source_tier_opinions.dismissed_by; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_tier_opinions.dismissed_by IS 'auth.users.id of the operator who dismissed the opinion.';


--
-- Name: COLUMN source_tier_opinions.dismissed_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_tier_opinions.dismissed_reason IS 'Optional free-text reason the operator dismissed this opinion. Captured for audit.';


--
-- Name: CONSTRAINT source_tier_opinions_opinion_source_check ON source_tier_opinions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT source_tier_opinions_opinion_source_check ON public.source_tier_opinions IS 'opinion_source enum, migration 091 + 309. host_class_table (309, Lane ATTACH-SOURCES W3.3) is the first deterministic, $0, no-LLM upstream: scripts/maintenance/tier-opinions.mjs comparing sources.base_tier against src/lib/sources/host-authority.ts''s classTierForHost(hostOf(url)) -- the same SC-13 class table STEP SOURCE and institution-canonicalize.mjs Part C already use.';


--
-- Name: source_trust_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_trust_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    event_type text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_by text DEFAULT 'system'::text NOT NULL,
    reviewer_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_trust_events_created_by_check CHECK ((created_by = ANY (ARRAY['system'::text, 'worker'::text, 'human'::text]))),
    CONSTRAINT source_trust_events_event_type_check CHECK ((event_type = ANY (ARRAY['confirmation'::text, 'conflict_opened'::text, 'conflict_resolved'::text, 'accessibility_check'::text, 'citation_received'::text, 'tier_promotion'::text, 'tier_demotion'::text, 'manual_review'::text, 'stale_flag'::text, 'paywall_change'::text, 'self_citation'::text, 'discovery'::text, 'tier_override'::text, 'tier_override_revert'::text])))
);


--
-- Name: TABLE source_trust_events; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.source_trust_events IS 'Immutable audit trail of every action affecting source trust. Insert-only — no updates or deletes.';


--
-- Name: source_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_verifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    candidate_url text NOT NULL,
    candidate_name text,
    jurisdiction_iso text[] DEFAULT '{}'::text[] NOT NULL,
    language text,
    ai_relevance_score integer,
    ai_freight_score integer,
    ai_trust_tier text,
    verification_tier text NOT NULL,
    action_taken text NOT NULL,
    rejection_reason text,
    verification_log jsonb DEFAULT '{}'::jsonb NOT NULL,
    resulting_source_id uuid,
    resulting_provisional_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_verifications_action_taken_check CHECK ((action_taken = ANY (ARRAY['auto-approved'::text, 'queued-provisional'::text, 'rejected'::text]))),
    CONSTRAINT source_verifications_ai_freight_score_check CHECK (((ai_freight_score IS NULL) OR ((ai_freight_score >= 0) AND (ai_freight_score <= 100)))),
    CONSTRAINT source_verifications_ai_relevance_score_check CHECK (((ai_relevance_score IS NULL) OR ((ai_relevance_score >= 0) AND (ai_relevance_score <= 100)))),
    CONSTRAINT source_verifications_ai_trust_tier_check CHECK (((ai_trust_tier IS NULL) OR (ai_trust_tier = ANY (ARRAY['T1'::text, 'T2'::text, 'T3'::text])))),
    CONSTRAINT source_verifications_verification_tier_check CHECK ((verification_tier = ANY (ARRAY['H'::text, 'M'::text, 'L'::text])))
);


--
-- Name: TABLE source_verifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.source_verifications IS 'W2.F: Audit log for the auto-verification pipeline. Every discovered candidate writes one row regardless of action_taken (auto-approved / queued-provisional / rejected). Tier L rows are noise-suppressed in human review surfaces but remain queryable for forensics.';


--
-- Name: COLUMN source_verifications.verification_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.source_verifications.verification_log IS 'JSONB log of every pipeline step: { reachability: {status, finalUrl, attempts}, content: {fetched, length}, domain: {pattern, confidence}, duplicate: {match}, language: {detected}, ai: {raw, ...}, aggregation: {triggers, decision} }.';


--
-- Name: sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    base_tier integer NOT NULL,
    tier_at_creation integer NOT NULL,
    intelligence_types text[] DEFAULT '{}'::text[] NOT NULL,
    domains integer[] DEFAULT '{}'::integer[] NOT NULL,
    jurisdictions text[] DEFAULT '{}'::text[] NOT NULL,
    transport_modes text[] DEFAULT '{}'::text[] NOT NULL,
    update_frequency text DEFAULT 'weekly'::text NOT NULL,
    last_checked timestamp with time zone,
    last_substantive_change timestamp with time zone,
    next_scheduled_check timestamp with time zone,
    status text DEFAULT 'active'::text NOT NULL,
    paywalled boolean DEFAULT false NOT NULL,
    access_method text DEFAULT 'manual'::text NOT NULL,
    api_endpoint text,
    rss_feed_url text,
    confirmation_count integer DEFAULT 0 NOT NULL,
    conflict_count integer DEFAULT 0 NOT NULL,
    conflict_total integer DEFAULT 0 NOT NULL,
    accuracy_rate numeric(5,4) DEFAULT 0.5000 NOT NULL,
    avg_lead_time_days numeric(8,2) DEFAULT 0.00 NOT NULL,
    lead_time_samples integer DEFAULT 0 NOT NULL,
    consecutive_accessible integer DEFAULT 0 NOT NULL,
    total_checks integer DEFAULT 0 NOT NULL,
    successful_checks integer DEFAULT 0 NOT NULL,
    accessibility_rate numeric(5,4) DEFAULT 1.0000 NOT NULL,
    last_accessible timestamp with time zone,
    last_inaccessible timestamp with time zone,
    independent_citers integer DEFAULT 0 NOT NULL,
    total_citations integer DEFAULT 0 NOT NULL,
    highest_citing_tier integer,
    self_citation_count integer DEFAULT 0 NOT NULL,
    trust_score_overall integer DEFAULT 50 NOT NULL,
    trust_score_accuracy numeric(5,1) DEFAULT 20.0 NOT NULL,
    trust_score_timeliness numeric(5,1) DEFAULT 10.0 NOT NULL,
    trust_score_reliability numeric(5,1) DEFAULT 10.0 NOT NULL,
    trust_score_citation numeric(5,1) DEFAULT 10.0 NOT NULL,
    trust_score_computed_at timestamp with time zone DEFAULT now() NOT NULL,
    tier_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    cited_by text,
    notes text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    topic_tags text[] DEFAULT '{}'::text[],
    vertical_tags text[] DEFAULT '{}'::text[],
    processing_paused boolean DEFAULT false NOT NULL,
    admin_only boolean DEFAULT false NOT NULL,
    jurisdiction_iso text[] DEFAULT '{}'::text[],
    spotchecked boolean DEFAULT false NOT NULL,
    last_content_hash text,
    last_intelligence_item_at timestamp with time zone,
    auto_run_enabled boolean DEFAULT true NOT NULL,
    api_endpoint_url text,
    api_auth_method text,
    api_response_format text,
    source_role text,
    secondary_roles text[] DEFAULT '{}'::text[],
    scope_topics text[] DEFAULT '{}'::text[],
    scope_modes text[] DEFAULT '{}'::text[],
    scope_verticals text[] DEFAULT '{}'::text[],
    expected_output jsonb,
    classification_assigned_at timestamp with time zone,
    observed_correctness_count integer DEFAULT 0 NOT NULL,
    classification_confidence text,
    classification_rationale text,
    category text,
    effective_tier integer,
    tier_override integer,
    override_reason text,
    override_date timestamp with time zone,
    tier integer,
    institution_id uuid,
    fetch_status text,
    fetch_status_at timestamp with time zone,
    last_content_changed_at timestamp with time zone,
    organisation_entity_id text,
    source_type text[],
    sitemap_url text,
    sitemap_last_walked_at timestamp with time zone,
    sitemap_url_count integer,
    sitemap_walk_outcome text,
    feed_last_probed_at timestamp with time zone,
    CONSTRAINT sources_access_method_check CHECK ((access_method = ANY (ARRAY['api'::text, 'rss'::text, 'html_scrape'::text, 'scrape'::text, 'gazette'::text, 'manual'::text]))),
    CONSTRAINT sources_api_auth_method_check CHECK (((api_auth_method IS NULL) OR (api_auth_method = ANY (ARRAY['none'::text, 'api_key_header'::text, 'api_key_query'::text, 'bearer'::text, 'basic'::text, 'oauth2'::text])))),
    CONSTRAINT sources_api_response_format_check CHECK (((api_response_format IS NULL) OR (api_response_format = ANY (ARRAY['json'::text, 'xml'::text, 'rss'::text, 'atom'::text, 'html'::text, 'text'::text])))),
    CONSTRAINT sources_base_tier_check CHECK (((base_tier >= 1) AND (base_tier <= 7))),
    CONSTRAINT sources_category_check CHECK (((category IS NULL) OR (category = ANY (ARRAY['regulatory'::text, 'research'::text, 'market_news'::text, 'operational_data'::text])))),
    CONSTRAINT sources_effective_tier_check CHECK (((effective_tier >= 1) AND (effective_tier <= 7))),
    CONSTRAINT sources_fetch_status_check CHECK (((fetch_status IS NULL) OR (fetch_status = ANY (ARRAY['ok'::text, 'cdn_block'::text, 'soft_404'::text, 'blocked'::text, 'error'::text])))),
    CONSTRAINT sources_highest_citing_tier_check CHECK (((highest_citing_tier IS NULL) OR ((highest_citing_tier >= 1) AND (highest_citing_tier <= 7)))),
    CONSTRAINT sources_sitemap_walk_outcome_valid CHECK (((sitemap_walk_outcome IS NULL) OR (sitemap_walk_outcome = ANY (ARRAY['walked'::text, 'no_sitemap'::text, 'bot_wall'::text, 'feed_only'::text, 'unfetchable'::text])))),
    CONSTRAINT sources_source_type_valid CHECK (((source_type IS NULL) OR (source_type <@ ARRAY['environmental_body'::text, 'legislature'::text, 'gazette'::text, 'regulatory_executive'::text, 'judiciary'::text, 'standards_body'::text, 'industry_assoc'::text, 'treaty_org'::text, 'research_institute'::text, 'news'::text, 'data_aggregator'::text]))),
    CONSTRAINT sources_status_check CHECK ((status = ANY (ARRAY['active'::text, 'stale'::text, 'inaccessible'::text, 'provisional'::text, 'suspended'::text]))),
    CONSTRAINT sources_tier_at_creation_check CHECK (((tier_at_creation >= 1) AND (tier_at_creation <= 7))),
    CONSTRAINT sources_tier_check CHECK (((tier >= 1) AND (tier <= 7))),
    CONSTRAINT sources_tier_matches_base_tier CHECK ((NOT (tier IS DISTINCT FROM base_tier))),
    CONSTRAINT sources_tier_override_check CHECK (((tier_override IS NULL) OR ((tier_override >= 1) AND (tier_override <= 7))))
);


--
-- Name: TABLE sources; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.sources IS 'Layer 1: Public portals where legislation is published. EUR-Lex, Federal Register, IMO.org. The system monitors SOURCES, not individual regulations.';


--
-- Name: COLUMN sources.url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.url IS 'Canonical form (Q10, migration 087). All writes must pass through canonicalizeUrl() from src/lib/sources/url-canonicalize.ts. No UNIQUE constraint yet — see Q10 duplicate report at scripts/tmp/q10-duplicate-report.json.';


--
-- Name: COLUMN sources.base_tier; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.base_tier IS 'Static tier classification (1-7) from classifier or operator at registration. Source of provenance for credibility computation. Rarely changes. Preserves classifier judgment for audit. See source-credibility-model skill Section 3.';


--
-- Name: COLUMN sources.tier_at_creation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.tier_at_creation IS 'Captures the tier value at source creation time. Migration 004 schema. CHECK (tier_at_creation BETWEEN 1 AND 7). Mirrors sources.tier shape; not affected by migration 063 shadowing attempt.';


--
-- Name: COLUMN sources.jurisdictions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.jurisdictions IS 'Text array of jurisdiction codes (lowercase region codes like us, eu, uk, ca, au, jp, us-ca, us-federal, us-state) for the source. NOT NULL DEFAULT empty array. Migration 063 attempted to allow NULL but the ADD COLUMN IF NOT EXISTS silently no-op''d. Decision (D16, 2026-05-19): accept divergence per migration 085 header. Empty array functions equivalently to NULL for "unknown" cases; no consumer differentiates.';


--
-- Name: COLUMN sources.highest_citing_tier; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.highest_citing_tier IS 'Optional integer 1-7 noting the highest tier that has cited this source. NULL allowed. Migration 004 schema. Not affected by migration 063 shadowing attempt.';


--
-- Name: COLUMN sources.trust_score_overall; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.trust_score_overall IS 'Composite trust score 0-100. Computed from accuracy (40%), timeliness (20%), reliability (20%), citation (20%).';


--
-- Name: COLUMN sources.processing_paused; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.processing_paused IS 'When true, automated processing skips this source (worker scan, agent runs, trust recompute). Manual fetch and
  regenerate actions still work — they bypass pause state by design.';


--
-- Name: COLUMN sources.admin_only; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.admin_only IS 'When true, this source is visible only to platform admins. Workspace-facing reads gate on (status = active AND
  admin_only = false). Admin contexts (SourceHealthDashboard, /api/admin/*) read without the admin_only filter.';


--
-- Name: COLUMN sources.jurisdiction_iso; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.jurisdiction_iso IS 'Sub-national-aware jurisdiction codes. ISO 3166-1 alpha-2, ISO 3166-2, or free-text supranational/IGO codes.';


--
-- Name: COLUMN sources.spotchecked; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.spotchecked IS 'W2.E: Marks a source as having been spot-checked by a platform admin. Sources with spotchecked=FALSE created within the last 7 days are surfaced in the auto_approved_awaiting_spotcheck queue.';


--
-- Name: COLUMN sources.last_content_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.last_content_hash IS 'P2-6 change detection: sha256 of the last successful render''s normalized text (content-change.mjs). Thin/error captures never overwrite it.';


--
-- Name: COLUMN sources.last_intelligence_item_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.last_intelligence_item_at IS 'Timestamp of the last intelligence_items create or regenerate against this source. Drives the cold-start backfill skip and source-health staleness signal.';


--
-- Name: COLUMN sources.auto_run_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.auto_run_enabled IS 'Per-source kill switch for the scheduled worker. Default TRUE for new sources. Cold-start script flips all 718 active sources to FALSE on first run; operators re-enable per source after vetting.';


--
-- Name: COLUMN sources.api_endpoint_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.api_endpoint_url IS 'reserved for API-fed sources: when a source publishes an API for pulling its data, the endpoint, auth method and response format are registered here and the API is preferred over page walking (operator ruling 2026-10-08, post-build capability)';


--
-- Name: COLUMN sources.api_auth_method; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.api_auth_method IS 'reserved for API-fed sources: when a source publishes an API for pulling its data, the endpoint, auth method and response format are registered here and the API is preferred over page walking (operator ruling 2026-10-08, post-build capability)';


--
-- Name: COLUMN sources.api_response_format; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.api_response_format IS 'reserved for API-fed sources: when a source publishes an API for pulling its data, the endpoint, auth method and response format are registered here and the API is preferred over page walking (operator ruling 2026-10-08, post-build capability)';


--
-- Name: COLUMN sources.source_role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.source_role IS 'Axis 1 primary role per framework. Valid values v1: primary_legal_authority, intergovernmental_body, standards_body, academic_research, statistical_data_agency, industry_data_provider, trade_press, industry_association, vendor_corporate, government_press. CHECK constraint deferred to a follow-up migration once value set stabilizes.';


--
-- Name: COLUMN sources.secondary_roles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.secondary_roles IS 'Axis 1 secondary roles, fallback only. Multi-role situations should prefer the URL-path split mechanism (separate registered sources per URL pattern) per framework. This array is the single-source multi-role fallback.';


--
-- Name: COLUMN sources.scope_topics; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.scope_topics IS 'Axis 4a content topics. Multi-valued. Example values: regulatory, finance, technology, fuel, labor, infrastructure, environmental, social, governance, transport, packaging, customs, conservation, materials_science.';


--
-- Name: COLUMN sources.scope_modes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.scope_modes IS 'Axis 4b transport modes covered. Example values: air, road, ocean, rail, all, none.';


--
-- Name: COLUMN sources.scope_verticals; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.scope_verticals IS 'Axis 4c Caro''s Ledge verticals covered. Example values: fine_art, live_events, luxury, film_tv, automotive, humanitarian, freight_general, all, none.';


--
-- Name: COLUMN sources.expected_output; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.expected_output IS 'Axis 5 probability distribution across the five item categories. Shape: {"Regulatory":0.5,"Research":0.4,"Market_Intel":0.05,"Operations":0,"Out_of_Scope":0.05}. Set at registration; refined by classification_observed_distribution after 30-90 days of observation.';


--
-- Name: COLUMN sources.classification_assigned_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.classification_assigned_at IS 'When the 5-axis classification was assigned. NULL means not yet classified.';


--
-- Name: COLUMN sources.observed_correctness_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.observed_correctness_count IS 'Increments when the source produces an item later confirmed-correct by downstream review. Used for tier conflict tie-breaking per framework Section 2 (within recency, observed correctness wins).';


--
-- Name: COLUMN sources.classification_confidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.classification_confidence IS 'Classifier confidence per docs/source-classification-framework-2026-05-10.md. Enum-like: HIGH | MEDIUM | LOW | AMBIGUOUS. CHECK constraint deferred until value set stabilizes per migration 063 convention.';


--
-- Name: COLUMN sources.classification_rationale; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.classification_rationale IS 'Free-form classifier rationale per docs/source-classification-framework-2026-05-10.md. Capture the why behind source_role / scope / tier assignments for audit and debugging.';


--
-- Name: COLUMN sources.category; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.category IS 'Canonical four-category taxonomy per caros-ledge-platform-intent SKILL.md Section 3 + environmental-policy-and-innovation source taxonomy. Values: regulatory, research, market_news, operational_data, or NULL (unrouted). Drives /regulations, /research, /market, /operations category routing via get_*_items RPCs. NULL sources are not surfaced on the four category pages (they may still appear via unfiltered fetchers). Item-level status conditionals (standards_body items NOT in_force/adopted, primary_legal_authority items proposed) override category routing in get_research_items RPC.';


--
-- Name: COLUMN sources.effective_tier; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.effective_tier IS 'Computed dynamic tier (1-7) from network + base + override + decay. Recomputed by daily batch (Q7 dispatch). Customer-facing credibility signal per source-credibility-model skill Section 2 formula: COALESCE(tier_override, computed_dynamic_tier, base_tier).';


--
-- Name: COLUMN sources.tier_override; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.tier_override IS 'Operator tier override per source-credibility-model skill Section 7. When non-null, takes precedence in effective_tier formula: COALESCE(tier_override, computed_dynamic_tier, base_tier). Set via POST /api/admin/sources/[id]/tier-override.';


--
-- Name: COLUMN sources.override_reason; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.override_reason IS 'Mandatory operator reason for tier override. Required field on override endpoint.';


--
-- Name: COLUMN sources.override_date; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.override_date IS 'Timestamp of most recent override action (set or revert).';


--
-- Name: COLUMN sources.tier; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.tier IS 'COMPATIBILITY SHIM (added 2026-05-19, migration 094). Q2 (migration 090) renamed tier to base_tier; this column is restored as a synced alias to keep deployed code working until Phase 1.5 consumer migration completes. Trigger sources_sync_tier_columns keeps tier and base_tier in lockstep. To be dropped in a follow-up migration once all src/ consumers explicitly reference base_tier or effective_tier per docs/sprint-2/Phase-1.5-consumer-migration-list.md.';


--
-- Name: COLUMN sources.institution_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.institution_id IS 'FK to the publishing institution (migration 122). Grouping only; does NOT imply two sources are the same source. NULL until backfilled.';


--
-- Name: COLUMN sources.fetch_status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.fetch_status IS 'Last transport fetch outcome for this source (item 5b). ok = readable; cdn_block / soft_404 / blocked / error = the pipeline could not extract usable content (detectRoadblock / fetch-quality). Customer surfaces gate the displayed source link on this — a non-ok status suppresses or labels the link. Written at the detection site in canonical-pipeline (the fetchPrimaryDeep result). NULL = never fetched under this signal (treat as readable/unknown).';


--
-- Name: COLUMN sources.fetch_status_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.fetch_status_at IS 'Timestamp fetch_status was last written (item 5b). Lets a stale block clear on a later successful fetch.';


--
-- Name: COLUMN sources.last_content_changed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.last_content_changed_at IS 'P2-6 change detection: stamped when a render''s fingerprint differs from the prior last_content_hash.';


--
-- Name: COLUMN sources.organisation_entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.organisation_entity_id IS 'Progressive re-keying (ADR-024): the organisation entity for the source host, nullable, backfilled by scripts/entities/backfill-entities.mjs; url stays.';


--
-- Name: COLUMN sources.source_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.source_type IS 'Type-of-body taxonomy (11 values, docs/plans/SOURCE-TYPE-TAXONOMY-PROPOSAL.md §3): what KIND of body this source is (environmental regulator, legislature, gazette, ...), orthogonal to source_role/category (migration 063/084 — WHAT CONTENT it routes to) and institution_id (migration 122 — WHO published). Multi-valued: many T1-T2 sources legitimately carry two tags (e.g. EPA = environmental_body + regulatory_executive). NULL means not yet classified — NOT an assertion of zero types; see migration 288 header. Vocabulary + classifier: src/lib/sources/source-type-taxonomy.mjs. Backfilled by scripts/sources/backfill-source-type.mjs (dry by default; never overwrites an already-classified row). Consumed by src/lib/coverage-gaps.ts, which reads this column first and falls back to the classifier only for a still-NULL row.';


--
-- Name: COLUMN sources.sitemap_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.sitemap_url IS 'The sitemap document this source''s last SUCCESSFUL sitemap walk fetched first (a pointer, not a cache — the walker re-discovers robots.txt/fallback candidates on every run). NULL until the first successful walk; a prior value is never cleared by a later walk whose outcome was feed_only/bot_wall/no_sitemap/unfetchable (that walk determined nothing new about the sitemap itself). Written by buildSitemapCoveragePatch, fsi-app/scripts/turns/run-source-sweep.mjs (migration 304, lane SITEMAP-3, 2026-09-04); read by --walker sitemap --check-coverage.';


--
-- Name: COLUMN sources.sitemap_last_walked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.sitemap_last_walked_at IS 'Stamped on EVERY sitemap-walk attempt for this source (walked / bot_wall / no_sitemap / unfetchable), regardless of outcome -- the resumability clock --walker sitemap --all-hosts orders its host selection by (never-walked hosts first, then oldest sitemap_last_walked_at). NULL means never attempted. Written by buildSitemapCoveragePatch (migration 304, lane SITEMAP-3, 2026-09-04).';


--
-- Name: COLUMN sources.sitemap_url_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.sitemap_url_count IS 'The SCOPED, CURRENT url-entry count sitemap-walk.mjs''s walkSitemap found for this source''s own registered path, as of sitemap_last_walked_at -- written only alongside a successful sitemap_url (same never-clear-on-a-non-sitemap-outcome rule). Migration 304, lane SITEMAP-3, 2026-09-04.';


--
-- Name: COLUMN sources.sitemap_walk_outcome; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.sitemap_walk_outcome IS 'One of walked / no_sitemap / bot_wall / feed_only / unfetchable (CHECK sources_sitemap_walk_outcome_valid) -- the last sitemap-walk attempt''s disposition for this source. NULL means never attempted (not an assertion of "no sitemap," same NULL-is-honest convention as sources.source_type, migration 288). feed_only means a feed was found and used per the operator''s discovery order, so the sitemap itself was not walked THIS run -- a previously-recorded sitemap_url/sitemap_url_count may still be accurate and is left untouched. Migration 304, lane SITEMAP-3, 2026-09-04.';


--
-- Name: COLUMN sources.feed_last_probed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.sources.feed_last_probed_at IS 'Stamped whenever sitemap-walk.mjs''s walkSource DEFINITELY ran its feed-discovery phase to completion (every outcome except unfetchable, where the phase that threw is not reliably known). Distinct from rss_feed_url (migration 056, the discovered feed URL itself, written only when a feed IS found) -- this column is stamped on every probe, feed found or not, so "have we even checked this source for a feed" is answerable independently of whether one exists. Migration 304, lane SITEMAP-3, 2026-09-04.';


--
-- Name: staged_updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.staged_updates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    item_id uuid,
    source_id uuid,
    update_type text NOT NULL,
    proposed_changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    source_url text,
    confidence text DEFAULT 'MEDIUM'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    reviewed_by text,
    reviewed_at timestamp with time zone,
    batch_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    full_brief text,
    jurisdiction_iso text[] DEFAULT '{}'::text[],
    materialization_error text,
    materialized_at timestamp with time zone,
    materialized_item_id uuid,
    reviewer_notes text,
    CONSTRAINT staged_updates_confidence_check CHECK ((confidence = ANY (ARRAY['HIGH'::text, 'MEDIUM'::text, 'LOW'::text]))),
    CONSTRAINT staged_updates_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT staged_updates_update_type_check CHECK ((update_type = ANY (ARRAY['new_item'::text, 'update_item'::text, 'status_change'::text, 'new_source'::text, 'source_conflict'::text, 'archive_item'::text])))
);


--
-- Name: COLUMN staged_updates.materialization_error; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staged_updates.materialization_error IS 'Non-null when an approved staged_update failed to insert into its target table. Populated by /api/staged-updates POST handler.';


--
-- Name: COLUMN staged_updates.materialized_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staged_updates.materialized_at IS 'Timestamp at which the approval successfully wrote the corresponding row(s). NULL for unmaterialized approvals.';


--
-- Name: COLUMN staged_updates.materialized_item_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staged_updates.materialized_item_id IS 'For update_type=new_item only: the intelligence_items.id produced by approval. NULL for other update_types or failed materialization.';


--
-- Name: COLUMN staged_updates.reviewer_notes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.staged_updates.reviewer_notes IS 'Optional free-text reviewer note captured on approve/reject via /api/staged-updates. Added Wave-a Track B4 (2026-07-11) — the route already wrote it; the column was missing (P1 #5 phantom-column class).';


--
-- Name: state_cost_facts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.state_cost_facts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    region_id uuid NOT NULL,
    state_code text NOT NULL,
    state_label text NOT NULL,
    dimension text NOT NULL,
    fact_label text NOT NULL,
    value text NOT NULL,
    unit text,
    trend text,
    source_id uuid,
    statute_citation text,
    effective_date date,
    last_updated timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    origin_class text,
    value_numeric numeric,
    CONSTRAINT state_cost_facts_dimension_check CHECK ((dimension = ANY (ARRAY['regulatory_feasibility'::text, 'regional_resources'::text, 'labor_markets'::text, 'materials_sourcing'::text, 'infrastructure'::text, 'operational_cost'::text]))),
    CONSTRAINT state_cost_facts_origin_class_check CHECK ((origin_class = ANY (ARRAY['community'::text, 'community-corroborated'::text, 'modelled'::text, 'derived'::text, 'partner'::text, 'verified'::text, 'official'::text]))),
    CONSTRAINT state_cost_facts_trend_check CHECK (((trend IS NULL) OR (trend = ANY (ARRAY['up'::text, 'down'::text, 'flat'::text]))))
);


--
-- Name: TABLE state_cost_facts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.state_cost_facts IS 'Sub-national (state / member-state) sourced cost facts for the Operations "By state" sub-list (T07, 2026-07). Each row carries its own statute citation; a state with no row here renders PENDING on the surface, never a national average presented as state law. Region-level facts live in regional_data_facts (106); this table adds the sub-national grain.';


--
-- Name: COLUMN state_cost_facts.state_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.state_cost_facts.state_code IS 'ISO 3166-2 sub-division code (e.g. US-CA). Stable join key for the By-state sub-list.';


--
-- Name: COLUMN state_cost_facts.statute_citation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.state_cost_facts.statute_citation IS 'Human-readable enacted-text reference for this state figure. Paired with source_id. Never inferred — a figure without a citation does not belong in this table (it belongs in the pending frame on the surface).';


--
-- Name: COLUMN state_cost_facts.origin_class; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.state_cost_facts.origin_class IS 'Where the content came from (spec 00 s3.6). Same 7-value vocabulary as emission_factors.origin_class (migration 258), owned by src/lib/contracts/vocabularies.mjs ORIGIN_CLASS. Nullable: pre-vocabulary rows stay NULL.';


--
-- Name: COLUMN state_cost_facts.value_numeric; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.state_cost_facts.value_numeric IS 'Numeric mirror of `value` (TEXT), added so a registered derivation method (automate_vs_hire) can read a state-grain fact the same way it already reads regional_data_facts.value_numeric (migration 267). NULLABLE, ADDITIVE, no backfill in this migration; the state-cost-facts producer (scripts/producers/regional/state-cost-facts-producer.mjs) writes it going forward, mechanically derived from the same candidate.value every row''s `value` TEXT column already carries, never a second authored figure.';


--
-- Name: statutory_computations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.statutory_computations (
    computation_id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_id text NOT NULL,
    scenario_key text DEFAULT 'default'::text NOT NULL,
    obligation_id text NOT NULL,
    formula_id text NOT NULL,
    formula_version text NOT NULL,
    statute_citation text NOT NULL,
    unit_price numeric,
    unit_price_unit text,
    inputs jsonb NOT NULL,
    result numeric NOT NULL,
    result_unit text NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT statutory_needs_citation CHECK ((length(statute_citation) > 0)),
    CONSTRAINT statutory_never_null_result CHECK ((result IS NOT NULL))
);


--
-- Name: TABLE statutory_computations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.statutory_computations IS 'Spec 08 §4 Layer 1: a published formula, published constants, an auditable input set — physically separate from estimated_values so the two cannot be conflated by omission. Surrogate PK + scenario_key (ADR-024 amendment 2026-09-02): the spec''s entity_id PK allowed one computation per entity, which the worked example (several results per factor) contradicts. inputs is the InputRef array [{table, pk, version}] (types.ts); assert_statutory_purity() refuses any input that is an estimate.';


--
-- Name: system_state_flag_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_state_flag_audit (
    id bigint NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by text NOT NULL,
    column_name text NOT NULL,
    old_value text,
    new_value text
);


--
-- Name: system_state_flag_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.system_state_flag_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: system_state_flag_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.system_state_flag_audit_id_seq OWNED BY public.system_state_flag_audit.id;


--
-- Name: theme_briefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.theme_briefs (
    theme_id uuid NOT NULL,
    member_hash text NOT NULL,
    member_count integer NOT NULL,
    title text NOT NULL,
    brief_md text NOT NULL,
    generated_at timestamp with time zone DEFAULT now() NOT NULL,
    generated_by text DEFAULT 'session-executor'::text NOT NULL,
    sections jsonb,
    claims jsonb,
    member_ids uuid[]
);


--
-- Name: TABLE theme_briefs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.theme_briefs IS 'F5 theme-brief synthesis (flywheel U6). Durable per-theme editorial content; survives connection_themes cache replacement. member_hash = md5 of sorted member_ids at generation; hash mismatch against the live theme = stale brief (regeneration candidate).';


--
-- Name: COLUMN theme_briefs.sections; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.theme_briefs.sections IS 'Structured theme brief: {connection, meaning, ramifications, watch, gaps}, each a markdown string. brief_md is these rendered in order under fixed headings. NULL for a brief written before migration 351.';


--
-- Name: COLUMN theme_briefs.claims; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.theme_briefs.claims IS 'Every factual statement in sections: [{section, text, member_id, claim_ids}], claim_ids being grounded section_claim_provenance ids of that member (or, in the watch section, item_forward_events ids). NULL for a brief written before migration 351.';


--
-- Name: COLUMN theme_briefs.member_ids; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.theme_briefs.member_ids IS 'The theme membership the brief was written for (sorted). Lets a drifted theme id find its prior brief by member overlap (brief-staleness.mjs resolveBriefForTheme); member_hash is the md5 of the same set. NULL for a brief written before migration 351.';


--
-- Name: user_item_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_item_state (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    org_id uuid,
    item_id uuid NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    archive_note text,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE user_item_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_item_state IS 'Personal (per-user) item state: the individual archive scope, distinct from the org-scoped workspace_item_overrides. RLS: own rows only (migration 239). Written by /api/workspace/personal-state via the service client.';


--
-- Name: user_watchlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_watchlist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    org_id uuid,
    item_type text NOT NULL,
    item_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_watchlist_item_type_check CHECK ((item_type = ANY (ARRAY['source'::text, 'reg'::text, 'signal'::text, 'research'::text, 'operations'::text])))
);


--
-- Name: vocabulary_mentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vocabulary_mentions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    term_id uuid NOT NULL,
    item_id uuid NOT NULL,
    source_id uuid,
    detector text NOT NULL,
    surface_text text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vocabulary_mentions_detector_check CHECK ((detector = ANY (ARRAY['entity-link'::text, 'theme-candidate'::text, 'scenario-tag'::text, 'compliance-object'::text, 'brief-terms'::text])))
);


--
-- Name: TABLE vocabulary_mentions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.vocabulary_mentions IS 'One row per (term, item, detector): the item that mentioned the term, through which detector, in what words, and the source that item came from (nullable). Written only by scripts/connections/term-recurrence.mjs and scripts/turns/apply-record-briefs.mjs through the guarded path. Admin read only.';


--
-- Name: vocabulary_terms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vocabulary_terms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    term_key text NOT NULL,
    label text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    distinct_items integer DEFAULT 0 NOT NULL,
    distinct_sources integer DEFAULT 0 NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    adopted_at timestamp with time zone,
    adoption_rule text,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT vocabulary_terms_adopted_is_stamped CHECK (((status <> 'adopted'::text) OR ((adopted_at IS NOT NULL) AND (adoption_rule IS NOT NULL)))),
    CONSTRAINT vocabulary_terms_distinct_items_check CHECK ((distinct_items >= 0)),
    CONSTRAINT vocabulary_terms_distinct_sources_check CHECK ((distinct_sources >= 0)),
    CONSTRAINT vocabulary_terms_kind_check CHECK ((kind = ANY (ARRAY['standard'::text, 'material'::text, 'theme'::text, 'scenario'::text, 'compliance_object'::text, 'term'::text]))),
    CONSTRAINT vocabulary_terms_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'adopted'::text, 'retired'::text]))),
    CONSTRAINT vocabulary_terms_term_key_check CHECK (((length(term_key) > 0) AND (term_key = lower(btrim(term_key)))))
);


--
-- Name: TABLE vocabulary_terms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.vocabulary_terms IS 'Terms the system does not hold in a code vocabulary, counted from repeated mentions (lane G5-TERMS, plan Stage 5). status proposed = counted; adopted = past the recurrence threshold by rule (distinct_items >= trust.ts CITATION_FREQUENCY_PROMOTION_THRESHOLD and distinct_sources >= 2), no human; retired = set by an admin, never overwritten by an automatic writer. Written only by scripts/connections/term-recurrence.mjs and scripts/turns/apply-record-briefs.mjs through the guarded path. Admin read only.';


--
-- Name: COLUMN vocabulary_terms.term_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vocabulary_terms.term_key IS 'The normalised mention (lower case, single spaces); unique per kind.';


--
-- Name: COLUMN vocabulary_terms.adoption_rule; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vocabulary_terms.adoption_rule IS 'The rule text that adopted the term, recorded at adoption so a later change to the threshold never rewrites history.';


--
-- Name: COLUMN vocabulary_terms.evidence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.vocabulary_terms.evidence IS 'What was counted: per-detector mention counts and a few sample item ids. Informational; the counts columns are the contract.';


--
-- Name: workspace_item_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_item_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    item_id uuid NOT NULL,
    priority_override text,
    is_archived boolean DEFAULT false NOT NULL,
    archive_reason text,
    archive_note text,
    archived_at timestamp with time zone,
    notes text DEFAULT ''::text NOT NULL,
    workspace_tags text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    dismissed_at timestamp with time zone,
    owner_user_id uuid,
    owner_assigned_by uuid,
    owner_assigned_at timestamp with time zone,
    archived_by uuid,
    CONSTRAINT workspace_item_overrides_priority_override_check CHECK (((priority_override IS NULL) OR (priority_override = ANY (ARRAY['CRITICAL'::text, 'HIGH'::text, 'MODERATE'::text, 'LOW'::text]))))
);


--
-- Name: TABLE workspace_item_overrides; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.workspace_item_overrides IS 'Per-org overrides on platform intelligence items. Priority, archive, notes. Platform data is never mutated.';


--
-- Name: COLUMN workspace_item_overrides.priority_override; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspace_item_overrides.priority_override IS 'NULL = use platform default. Non-null = this org sees this priority instead.';


--
-- Name: COLUMN workspace_item_overrides.dismissed_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspace_item_overrides.dismissed_at IS 'Sprint 3 follow-up Part 2 (migration 111). When non-null, the workspace has dismissed this regulation from the active Kanban view. The regulation surfaces in the collapsed "Dismissed regulations" stash at the bottom of /regulations with a Restore action. Distinct from archived_at, which is a deeper workspace-archive decision with a reason code. Dismissed = "out of sight on the active board"; archived = "shelved for review by reason".';


--
-- Name: COLUMN workspace_item_overrides.owner_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspace_item_overrides.owner_user_id IS 'Org-scoped item assignee (Phase 1 ownership, 2026-08-02). FK profiles(id); API layer enforces org membership at write time.';


--
-- Name: workspace_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    sector_profile text[] DEFAULT '{}'::text[] NOT NULL,
    jurisdiction_weights jsonb,
    default_filters jsonb DEFAULT '{}'::jsonb NOT NULL,
    alert_config jsonb DEFAULT '{"priorities": ["CRITICAL", "HIGH"]}'::jsonb NOT NULL,
    home_sections jsonb DEFAULT '{"topUrgency": true, "whatChanged": true, "summaryStrip": true, "supersessions": true, "dueThisQuarter": true, "weeklyBriefing": true}'::jsonb NOT NULL,
    default_export_format text DEFAULT 'html'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    notify_on_sector_activation boolean DEFAULT false NOT NULL,
    sectors_activation_signup_at timestamp with time zone,
    profile jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT workspace_settings_default_export_format_check CHECK ((default_export_format = ANY (ARRAY['html'::text, 'slack'::text])))
);


--
-- Name: TABLE workspace_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.workspace_settings IS 'Per-org configuration: sector profile, jurisdiction weights, filters, alerts.';


--
-- Name: COLUMN workspace_settings.notify_on_sector_activation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspace_settings.notify_on_sector_activation IS 'True if the workspace opted in to receive notification when per-sector reporting activates. Read at activation-feature launch time to drive a one-time email/in-app announcement.';


--
-- Name: COLUMN workspace_settings.sectors_activation_signup_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspace_settings.sectors_activation_signup_at IS 'When the workspace first opted in. Set on the first transition false→true; never overwritten on subsequent toggles. Null = never opted in.';


--
-- Name: COLUMN workspace_settings.profile; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspace_settings.profile IS 'Read-time anchoring profile (Option B, mig 251): roles/transport_modes/trade_lanes/products/operational_baseline/office_footprint/regulation_scope. Cargo verticals live in sector_profile, jurisdictions in jurisdiction_weights. Consumed by the read-time contextualization layer, never by generation (shared briefs stay role-generic).';


--
-- Name: workspace_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    name_key text GENERATED ALWAYS AS (lower(TRIM(BOTH FROM name))) STORED,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_tags_name_len CHECK ((length(name) <= 60)),
    CONSTRAINT workspace_tags_name_not_blank CHECK ((length(TRIM(BOTH FROM name)) > 0))
);


--
-- Name: TABLE workspace_tags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.workspace_tags IS 'Workspace-owned tags (migration 313, README "Workspace tags"). One row per distinct tag name per org; name_key is the case-insensitive dedupe key. Source for the + Tag popover and saved-search tag filters.';


--
-- Name: COLUMN workspace_tags.name_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.workspace_tags.name_key IS 'GENERATED lower(trim(name)), enforces case-insensitive uniqueness per org via workspace_tags_org_name_key_uidx.';


--
-- Name: propagation_events event_id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.propagation_events ALTER COLUMN event_id SET DEFAULT nextval('public.propagation_events_event_id_seq'::regclass);


--
-- Name: source_reliability_ledger id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_reliability_ledger ALTER COLUMN id SET DEFAULT nextval('public.source_reliability_ledger_id_seq'::regclass);


--
-- Name: system_state_flag_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_state_flag_audit ALTER COLUMN id SET DEFAULT nextval('public.system_state_flag_audit_id_seq'::regclass);


--
-- Name: admin_action_cooldowns admin_action_cooldowns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_action_cooldowns
    ADD CONSTRAINT admin_action_cooldowns_pkey PRIMARY KEY (action_key);


--
-- Name: agent_run_searches agent_run_searches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_searches
    ADD CONSTRAINT agent_run_searches_pkey PRIMARY KEY (id);


--
-- Name: agent_runs agent_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_pkey PRIMARY KEY (id);


--
-- Name: aggregate_query_log aggregate_query_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.aggregate_query_log
    ADD CONSTRAINT aggregate_query_log_pkey PRIMARY KEY (query_id);


--
-- Name: assumption_register assumption_register_assumption_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assumption_register
    ADD CONSTRAINT assumption_register_assumption_key_key UNIQUE (assumption_key);


--
-- Name: assumption_register assumption_register_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assumption_register
    ADD CONSTRAINT assumption_register_pkey PRIMARY KEY (id);


--
-- Name: auxiliary_energy_profiles auxiliary_energy_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auxiliary_energy_profiles
    ADD CONSTRAINT auxiliary_energy_profiles_pkey PRIMARY KEY (profile_id);


--
-- Name: brief_apply_runs brief_apply_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brief_apply_runs
    ADD CONSTRAINT brief_apply_runs_pkey PRIMARY KEY (run_id);


--
-- Name: bulk_imports bulk_imports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_imports
    ADD CONSTRAINT bulk_imports_pkey PRIMARY KEY (id);


--
-- Name: canonical_source_candidates canonical_source_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_source_candidates
    ADD CONSTRAINT canonical_source_candidates_pkey PRIMARY KEY (id);


--
-- Name: census_worklist census_worklist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.census_worklist
    ADD CONSTRAINT census_worklist_pkey PRIMARY KEY (id);


--
-- Name: census_worklist census_worklist_source_id_document_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.census_worklist
    ADD CONSTRAINT census_worklist_source_id_document_url_key UNIQUE (source_id, document_url);


--
-- Name: claim_versions claim_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claim_versions
    ADD CONSTRAINT claim_versions_pkey PRIMARY KEY (id);


--
-- Name: community_group_invitations community_group_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_group_invitations
    ADD CONSTRAINT community_group_invitations_pkey PRIMARY KEY (id);


--
-- Name: community_group_members community_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_group_members
    ADD CONSTRAINT community_group_members_pkey PRIMARY KEY (group_id, user_id);


--
-- Name: community_groups community_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_groups
    ADD CONSTRAINT community_groups_pkey PRIMARY KEY (id);


--
-- Name: community_groups community_groups_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_groups
    ADD CONSTRAINT community_groups_slug_key UNIQUE (slug);


--
-- Name: community_member_profiles community_member_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_member_profiles
    ADD CONSTRAINT community_member_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: community_post_signoff_requests community_post_signoff_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_post_signoff_requests
    ADD CONSTRAINT community_post_signoff_requests_pkey PRIMARY KEY (id);


--
-- Name: community_posts community_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_posts
    ADD CONSTRAINT community_posts_pkey PRIMARY KEY (id);


--
-- Name: community_thread_entities community_thread_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_thread_entities
    ADD CONSTRAINT community_thread_entities_pkey PRIMARY KEY (thread_id, entity_id);


--
-- Name: community_topic_groups community_topic_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_topic_groups
    ADD CONSTRAINT community_topic_groups_pkey PRIMARY KEY (topic_id, group_id);


--
-- Name: community_topics community_topics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_topics
    ADD CONSTRAINT community_topics_pkey PRIMARY KEY (id);


--
-- Name: connection_theme_runs connection_theme_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection_theme_runs
    ADD CONSTRAINT connection_theme_runs_pkey PRIMARY KEY (id);


--
-- Name: connection_themes connection_themes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.connection_themes
    ADD CONSTRAINT connection_themes_pkey PRIMARY KEY (id);


--
-- Name: corpus_census corpus_census_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corpus_census
    ADD CONSTRAINT corpus_census_pkey PRIMARY KEY (intelligence_item_id);


--
-- Name: corpus_turn_requests corpus_turn_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corpus_turn_requests
    ADD CONSTRAINT corpus_turn_requests_pkey PRIMARY KEY (id);


--
-- Name: coverage_gap_candidates coverage_gap_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coverage_gap_candidates
    ADD CONSTRAINT coverage_gap_candidates_pkey PRIMARY KEY (id);


--
-- Name: coverage_gap_census_findings coverage_gap_census_findings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coverage_gap_census_findings
    ADD CONSTRAINT coverage_gap_census_findings_pkey PRIMARY KEY (id);


--
-- Name: coverage_gaps coverage_gaps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coverage_gaps
    ADD CONSTRAINT coverage_gaps_pkey PRIMARY KEY (id);


--
-- Name: data_sources data_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.data_sources
    ADD CONSTRAINT data_sources_pkey PRIMARY KEY (source_key);


--
-- Name: derivation_edges derivation_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.derivation_edges
    ADD CONSTRAINT derivation_edges_pkey PRIMARY KEY (from_table, from_pk, to_value_id, edge_kind);


--
-- Name: derived_values derived_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.derived_values
    ADD CONSTRAINT derived_values_pkey PRIMARY KEY (value_id);


--
-- Name: disposition_ledger disposition_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disposition_ledger
    ADD CONSTRAINT disposition_ledger_pkey PRIMARY KEY (id);


--
-- Name: emission_factors emission_factors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emission_factors
    ADD CONSTRAINT emission_factors_pkey PRIMARY KEY (factor_id);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (entity_id);


--
-- Name: entity_aliases entity_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_aliases
    ADD CONSTRAINT entity_aliases_pkey PRIMARY KEY (entity_id, alias, alias_kind, asserted_by);


--
-- Name: entity_identifiers entity_identifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_identifiers
    ADD CONSTRAINT entity_identifiers_pkey PRIMARY KEY (entity_id, scheme, value);


--
-- Name: entity_refs entity_refs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_refs
    ADD CONSTRAINT entity_refs_pkey PRIMARY KEY (ref_table, ref_id, entity_id, role);


--
-- Name: entity_relations entity_relations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relations
    ADD CONSTRAINT entity_relations_pkey PRIMARY KEY (parent_entity_id, child_entity_id, relation);


--
-- Name: entity_scope entity_scope_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_scope
    ADD CONSTRAINT entity_scope_pkey PRIMARY KEY (subject_id, scope_id, relation);


--
-- Name: error_events error_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.error_events
    ADD CONSTRAINT error_events_pkey PRIMARY KEY (id);


--
-- Name: estimated_values estimated_values_entity_model_scenario_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_values
    ADD CONSTRAINT estimated_values_entity_model_scenario_uniq UNIQUE (entity_id, model_id, model_version, scenario_key);


--
-- Name: estimated_values estimated_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_values
    ADD CONSTRAINT estimated_values_pkey PRIMARY KEY (estimate_id);


--
-- Name: funded_pass_runlock funded_pass_runlock_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funded_pass_runlock
    ADD CONSTRAINT funded_pass_runlock_pkey PRIMARY KEY (lock_key);


--
-- Name: gate_a_health_cache gate_a_health_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gate_a_health_cache
    ADD CONSTRAINT gate_a_health_cache_pkey PRIMARY KEY (singleton);


--
-- Name: grid_connection_queues grid_connection_queues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_connection_queues
    ADD CONSTRAINT grid_connection_queues_pkey PRIMARY KEY (queue_id);


--
-- Name: grid_connection_queues grid_connection_queues_substation_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_connection_queues
    ADD CONSTRAINT grid_connection_queues_substation_key UNIQUE (dso_name, substation_ref, as_of);


--
-- Name: harness_runs harness_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.harness_runs
    ADD CONSTRAINT harness_runs_pkey PRIMARY KEY (run_id);


--
-- Name: holdings_quality holdings_quality_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.holdings_quality
    ADD CONSTRAINT holdings_quality_pkey PRIMARY KEY (id);


--
-- Name: indexation_clauses indexation_clauses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.indexation_clauses
    ADD CONSTRAINT indexation_clauses_pkey PRIMARY KEY (clause_id);


--
-- Name: inference_records inference_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inference_records
    ADD CONSTRAINT inference_records_pkey PRIMARY KEY (inference_id);


--
-- Name: ingest_rejections ingest_rejections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_rejections
    ADD CONSTRAINT ingest_rejections_pkey PRIMARY KEY (id);


--
-- Name: institutions institutions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.institutions
    ADD CONSTRAINT institutions_pkey PRIMARY KEY (id);


--
-- Name: institutions institutions_registrable_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.institutions
    ADD CONSTRAINT institutions_registrable_domain_key UNIQUE (registrable_domain);


--
-- Name: integrity_flags integrity_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrity_flags
    ADD CONSTRAINT integrity_flags_pkey PRIMARY KEY (id);


--
-- Name: intelligence_changes intelligence_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_changes
    ADD CONSTRAINT intelligence_changes_pkey PRIMARY KEY (id);


--
-- Name: intelligence_item_citations intelligence_item_citations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_item_citations
    ADD CONSTRAINT intelligence_item_citations_pkey PRIMARY KEY (id);


--
-- Name: intelligence_item_citations intelligence_item_citations_unique_edge; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_item_citations
    ADD CONSTRAINT intelligence_item_citations_unique_edge UNIQUE (intelligence_item_id, source_id, origin);


--
-- Name: intelligence_item_sections intelligence_item_sections_item_id_section_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_item_sections
    ADD CONSTRAINT intelligence_item_sections_item_id_section_key_key UNIQUE (item_id, section_key);


--
-- Name: intelligence_item_sections intelligence_item_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_item_sections
    ADD CONSTRAINT intelligence_item_sections_pkey PRIMARY KEY (id);


--
-- Name: intelligence_item_versions intelligence_item_versions_intelligence_item_id_version_num_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_item_versions
    ADD CONSTRAINT intelligence_item_versions_intelligence_item_id_version_num_key UNIQUE (intelligence_item_id, version_number);


--
-- Name: intelligence_item_versions intelligence_item_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_item_versions
    ADD CONSTRAINT intelligence_item_versions_pkey PRIMARY KEY (id);


--
-- Name: intelligence_items intelligence_items_legacy_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_items
    ADD CONSTRAINT intelligence_items_legacy_id_key UNIQUE (legacy_id);


--
-- Name: intelligence_items intelligence_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_items
    ADD CONSTRAINT intelligence_items_pkey PRIMARY KEY (id);


--
-- Name: intelligence_summaries intelligence_summaries_item_id_sector_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_summaries
    ADD CONSTRAINT intelligence_summaries_item_id_sector_key UNIQUE (item_id, sector);


--
-- Name: intelligence_summaries intelligence_summaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_summaries
    ADD CONSTRAINT intelligence_summaries_pkey PRIMARY KEY (id);


--
-- Name: item_assignments item_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_assignments
    ADD CONSTRAINT item_assignments_pkey PRIMARY KEY (id);


--
-- Name: item_assignments item_assignments_unique_assignee; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_assignments
    ADD CONSTRAINT item_assignments_unique_assignee UNIQUE (org_id, item_id, assignee_user_id);


--
-- Name: item_changelog item_changelog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_changelog
    ADD CONSTRAINT item_changelog_pkey PRIMARY KEY (id);


--
-- Name: item_correction_evidence item_correction_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_correction_evidence
    ADD CONSTRAINT item_correction_evidence_pkey PRIMARY KEY (correction_id);


--
-- Name: item_corrections item_corrections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_corrections
    ADD CONSTRAINT item_corrections_pkey PRIMARY KEY (id);


--
-- Name: item_cross_references item_cross_references_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_cross_references
    ADD CONSTRAINT item_cross_references_pkey PRIMARY KEY (id);


--
-- Name: item_cross_references item_cross_references_source_item_id_target_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_cross_references
    ADD CONSTRAINT item_cross_references_source_item_id_target_item_id_key UNIQUE (source_item_id, target_item_id);


--
-- Name: item_disputes item_disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_disputes
    ADD CONSTRAINT item_disputes_pkey PRIMARY KEY (id);


--
-- Name: item_forward_events item_forward_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_forward_events
    ADD CONSTRAINT item_forward_events_pkey PRIMARY KEY (id);


--
-- Name: item_gate_a_state item_gate_a_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_gate_a_state
    ADD CONSTRAINT item_gate_a_state_pkey PRIMARY KEY (intelligence_item_id);


--
-- Name: item_notes item_notes_legacy_override_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_notes
    ADD CONSTRAINT item_notes_legacy_override_id_key UNIQUE (legacy_override_id);


--
-- Name: item_notes item_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_notes
    ADD CONSTRAINT item_notes_pkey PRIMARY KEY (id);


--
-- Name: item_supersessions item_supersessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_supersessions
    ADD CONSTRAINT item_supersessions_pkey PRIMARY KEY (id);


--
-- Name: item_timelines item_timelines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_timelines
    ADD CONSTRAINT item_timelines_pkey PRIMARY KEY (id);


--
-- Name: item_type_required_slots item_type_required_slots_item_type_slot_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_type_required_slots
    ADD CONSTRAINT item_type_required_slots_item_type_slot_key_key UNIQUE (item_type, slot_key);


--
-- Name: item_type_required_slots item_type_required_slots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_type_required_slots
    ADD CONSTRAINT item_type_required_slots_pkey PRIMARY KEY (id);


--
-- Name: item_workspace_tags item_workspace_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_workspace_tags
    ADD CONSTRAINT item_workspace_tags_pkey PRIMARY KEY (tag_id, intelligence_item_id);


--
-- Name: market_series market_series_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_series
    ADD CONSTRAINT market_series_pkey PRIMARY KEY (id);


--
-- Name: market_series market_series_series_key_reference_period_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_series
    ADD CONSTRAINT market_series_series_key_reference_period_key UNIQUE (series_key, reference_period);


--
-- Name: moderation_reports moderation_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moderation_reports
    ADD CONSTRAINT moderation_reports_pkey PRIMARY KEY (id);


--
-- Name: monitoring_queue monitoring_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_queue
    ADD CONSTRAINT monitoring_queue_pkey PRIMARY KEY (id);


--
-- Name: mutation_leases mutation_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mutation_leases
    ADD CONSTRAINT mutation_leases_pkey PRIMARY KEY (intelligence_item_id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: obligation_objects obligation_objects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligation_objects
    ADD CONSTRAINT obligation_objects_pkey PRIMARY KEY (obligation_id);


--
-- Name: obligations obligations_forward_event_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligations
    ADD CONSTRAINT obligations_forward_event_unique UNIQUE (forward_event_id);


--
-- Name: obligations obligations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligations
    ADD CONSTRAINT obligations_pkey PRIMARY KEY (id);


--
-- Name: oem_tech_roadmaps oem_tech_roadmaps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oem_tech_roadmaps
    ADD CONSTRAINT oem_tech_roadmaps_pkey PRIMARY KEY (roadmap_id);


--
-- Name: org_invitations org_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_pkey PRIMARY KEY (id);


--
-- Name: org_invitations org_invitations_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_token_key UNIQUE (token);


--
-- Name: org_member_bans org_member_bans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_member_bans
    ADD CONSTRAINT org_member_bans_pkey PRIMARY KEY (org_id, user_id);


--
-- Name: org_memberships org_memberships_org_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_memberships
    ADD CONSTRAINT org_memberships_org_id_user_id_key UNIQUE (org_id, user_id);


--
-- Name: org_memberships org_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_memberships
    ADD CONSTRAINT org_memberships_pkey PRIMARY KEY (id);


--
-- Name: org_watchlist org_watchlist_org_id_item_type_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_watchlist
    ADD CONSTRAINT org_watchlist_org_id_item_type_item_id_key UNIQUE (org_id, item_type, item_id);


--
-- Name: org_watchlist org_watchlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_watchlist
    ADD CONSTRAINT org_watchlist_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_key UNIQUE (slug);


--
-- Name: pending_first_fetch pending_first_fetch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_first_fetch
    ADD CONSTRAINT pending_first_fetch_pkey PRIMARY KEY (id);


--
-- Name: pending_jurisdiction_review pending_jurisdiction_review_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_jurisdiction_review
    ADD CONSTRAINT pending_jurisdiction_review_pkey PRIMARY KEY (id);


--
-- Name: portal_link_candidates portal_link_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_link_candidates
    ADD CONSTRAINT portal_link_candidates_pkey PRIMARY KEY (id);


--
-- Name: portal_link_candidates portal_link_candidates_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_link_candidates
    ADD CONSTRAINT portal_link_candidates_url_key UNIQUE (url);


--
-- Name: portfolio_members portfolio_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_members
    ADD CONSTRAINT portfolio_members_pkey PRIMARY KEY (id);


--
-- Name: portfolios portfolios_id_org_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolios
    ADD CONSTRAINT portfolios_id_org_uniq UNIQUE (id, org_id);


--
-- Name: portfolios portfolios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolios
    ADD CONSTRAINT portfolios_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_email_key UNIQUE (email);


--
-- Name: profiles profiles_linkedin_sub_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_linkedin_sub_key UNIQUE (linkedin_sub);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: propagation_events propagation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.propagation_events
    ADD CONSTRAINT propagation_events_pkey PRIMARY KEY (event_id);


--
-- Name: provisional_sources provisional_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisional_sources
    ADD CONSTRAINT provisional_sources_pkey PRIMARY KEY (id);


--
-- Name: provisional_sources provisional_sources_url_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisional_sources
    ADD CONSTRAINT provisional_sources_url_key UNIQUE (url);


--
-- Name: published_price_statistics published_price_statistics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.published_price_statistics
    ADD CONSTRAINT published_price_statistics_pkey PRIMARY KEY (id);


--
-- Name: raw_fetches raw_fetches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_fetches
    ADD CONSTRAINT raw_fetches_pkey PRIMARY KEY (id);


--
-- Name: region_dimension_coverage region_dimension_coverage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region_dimension_coverage
    ADD CONSTRAINT region_dimension_coverage_pkey PRIMARY KEY (id);


--
-- Name: region_dimension_coverage region_dimension_coverage_region_id_dimension_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region_dimension_coverage
    ADD CONSTRAINT region_dimension_coverage_region_id_dimension_key UNIQUE (region_id, dimension);


--
-- Name: regional_data_facts regional_data_facts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regional_data_facts
    ADD CONSTRAINT regional_data_facts_pkey PRIMARY KEY (id);


--
-- Name: regional_data_facts regional_data_facts_region_id_dimension_fact_label_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regional_data_facts
    ADD CONSTRAINT regional_data_facts_region_id_dimension_fact_label_key UNIQUE (region_id, dimension, fact_label);


--
-- Name: regions regions_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_code_key UNIQUE (code);


--
-- Name: regions regions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regions
    ADD CONSTRAINT regions_pkey PRIMARY KEY (id);


--
-- Name: reroute_events reroute_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reroute_events
    ADD CONSTRAINT reroute_events_pkey PRIMARY KEY (reroute_id);


--
-- Name: research_assessments research_assessments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_assessments
    ADD CONSTRAINT research_assessments_pkey PRIMARY KEY (id);


--
-- Name: section_claim_provenance section_claim_provenance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section_claim_provenance
    ADD CONSTRAINT section_claim_provenance_pkey PRIMARY KEY (id);


--
-- Name: sector_contexts sector_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sector_contexts
    ADD CONSTRAINT sector_contexts_pkey PRIMARY KEY (sector);


--
-- Name: sensitive_field_policy sensitive_field_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sensitive_field_policy
    ADD CONSTRAINT sensitive_field_policy_pkey PRIMARY KEY (table_name, column_name);


--
-- Name: signposts signposts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signposts
    ADD CONSTRAINT signposts_pkey PRIMARY KEY (entity_id);


--
-- Name: source_bias_tags source_bias_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_bias_tags
    ADD CONSTRAINT source_bias_tags_pkey PRIMARY KEY (id);


--
-- Name: source_bias_tags source_bias_tags_unique_per_source; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_bias_tags
    ADD CONSTRAINT source_bias_tags_unique_per_source UNIQUE (source_id, dimension, tag);


--
-- Name: source_citations source_citations_citing_source_id_cited_source_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_citations
    ADD CONSTRAINT source_citations_citing_source_id_cited_source_id_key UNIQUE (citing_source_id, cited_source_id);


--
-- Name: source_citations source_citations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_citations
    ADD CONSTRAINT source_citations_pkey PRIMARY KEY (id);


--
-- Name: source_reliability_ledger source_reliability_ledger_one_per_source_signpost; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_reliability_ledger
    ADD CONSTRAINT source_reliability_ledger_one_per_source_signpost UNIQUE (source_id, signpost_entity_id);


--
-- Name: source_reliability_ledger source_reliability_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_reliability_ledger
    ADD CONSTRAINT source_reliability_ledger_pkey PRIMARY KEY (id);


--
-- Name: source_tier_opinions source_tier_opinions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_tier_opinions
    ADD CONSTRAINT source_tier_opinions_pkey PRIMARY KEY (id);


--
-- Name: source_trust_events source_trust_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_trust_events
    ADD CONSTRAINT source_trust_events_pkey PRIMARY KEY (id);


--
-- Name: source_verifications source_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_verifications
    ADD CONSTRAINT source_verifications_pkey PRIMARY KEY (id);


--
-- Name: sources sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sources
    ADD CONSTRAINT sources_pkey PRIMARY KEY (id);


--
-- Name: staged_updates staged_updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staged_updates
    ADD CONSTRAINT staged_updates_pkey PRIMARY KEY (id);


--
-- Name: state_cost_facts state_cost_facts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_cost_facts
    ADD CONSTRAINT state_cost_facts_pkey PRIMARY KEY (id);


--
-- Name: state_cost_facts state_cost_facts_state_code_dimension_fact_label_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_cost_facts
    ADD CONSTRAINT state_cost_facts_state_code_dimension_fact_label_key UNIQUE (state_code, dimension, fact_label);


--
-- Name: statutory_computations statutory_computations_entity_formula_scenario_uniq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statutory_computations
    ADD CONSTRAINT statutory_computations_entity_formula_scenario_uniq UNIQUE (entity_id, formula_id, formula_version, scenario_key);


--
-- Name: statutory_computations statutory_computations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statutory_computations
    ADD CONSTRAINT statutory_computations_pkey PRIMARY KEY (computation_id);


--
-- Name: system_state_flag_audit system_state_flag_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_state_flag_audit
    ADD CONSTRAINT system_state_flag_audit_pkey PRIMARY KEY (id);


--
-- Name: system_state system_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_state
    ADD CONSTRAINT system_state_pkey PRIMARY KEY (id);


--
-- Name: theme_briefs theme_briefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.theme_briefs
    ADD CONSTRAINT theme_briefs_pkey PRIMARY KEY (theme_id);


--
-- Name: user_item_state user_item_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_item_state
    ADD CONSTRAINT user_item_state_pkey PRIMARY KEY (id);


--
-- Name: user_item_state user_item_state_user_id_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_item_state
    ADD CONSTRAINT user_item_state_user_id_item_id_key UNIQUE (user_id, item_id);


--
-- Name: user_watchlist user_watchlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_watchlist
    ADD CONSTRAINT user_watchlist_pkey PRIMARY KEY (id);


--
-- Name: user_watchlist user_watchlist_user_id_item_type_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_watchlist
    ADD CONSTRAINT user_watchlist_user_id_item_type_item_id_key UNIQUE (user_id, item_type, item_id);


--
-- Name: vocabulary_mentions vocabulary_mentions_one_per_term_item_detector; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vocabulary_mentions
    ADD CONSTRAINT vocabulary_mentions_one_per_term_item_detector UNIQUE (term_id, item_id, detector);


--
-- Name: vocabulary_mentions vocabulary_mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vocabulary_mentions
    ADD CONSTRAINT vocabulary_mentions_pkey PRIMARY KEY (id);


--
-- Name: vocabulary_terms vocabulary_terms_kind_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vocabulary_terms
    ADD CONSTRAINT vocabulary_terms_kind_key_unique UNIQUE (kind, term_key);


--
-- Name: vocabulary_terms vocabulary_terms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vocabulary_terms
    ADD CONSTRAINT vocabulary_terms_pkey PRIMARY KEY (id);


--
-- Name: workspace_item_overrides workspace_item_overrides_org_id_item_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_item_overrides
    ADD CONSTRAINT workspace_item_overrides_org_id_item_id_key UNIQUE (org_id, item_id);


--
-- Name: workspace_item_overrides workspace_item_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_item_overrides
    ADD CONSTRAINT workspace_item_overrides_pkey PRIMARY KEY (id);


--
-- Name: workspace_settings workspace_settings_org_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_settings
    ADD CONSTRAINT workspace_settings_org_id_key UNIQUE (org_id);


--
-- Name: workspace_settings workspace_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_settings
    ADD CONSTRAINT workspace_settings_pkey PRIMARY KEY (id);


--
-- Name: workspace_tags workspace_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tags
    ADD CONSTRAINT workspace_tags_pkey PRIMARY KEY (id);


--
-- Name: admin_action_cooldowns_last_triggered_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_action_cooldowns_last_triggered_idx ON public.admin_action_cooldowns USING btree (last_triggered_at DESC);


--
-- Name: aggregate_query_log_field_hash_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX aggregate_query_log_field_hash_idx ON public.aggregate_query_log USING btree (table_name, column_name, cohort_hash, requested_at DESC);


--
-- Name: aggregate_query_log_requester_field_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX aggregate_query_log_requester_field_idx ON public.aggregate_query_log USING btree (requested_by, table_name, column_name, requested_at DESC);


--
-- Name: assumption_register_subsystem_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX assumption_register_subsystem_idx ON public.assumption_register USING btree (subsystem, assumption_key);


--
-- Name: auxiliary_energy_profiles_load_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auxiliary_energy_profiles_load_type_idx ON public.auxiliary_energy_profiles USING btree (load_type);


--
-- Name: auxiliary_energy_profiles_node_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auxiliary_energy_profiles_node_idx ON public.auxiliary_energy_profiles USING btree (node_id) WHERE (node_id IS NOT NULL);


--
-- Name: auxiliary_energy_profiles_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX auxiliary_energy_profiles_org_idx ON public.auxiliary_energy_profiles USING btree (org_id);


--
-- Name: census_worklist_cap_hit_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX census_worklist_cap_hit_idx ON public.census_worklist USING btree (source_id) WHERE (cap_hit = true);


--
-- Name: census_worklist_flagged_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX census_worklist_flagged_idx ON public.census_worklist USING btree (lane) WHERE (flagged_at IS NOT NULL);


--
-- Name: census_worklist_lane_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX census_worklist_lane_idx ON public.census_worklist USING btree (lane);


--
-- Name: census_worklist_resolved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX census_worklist_resolved_idx ON public.census_worklist USING btree (resolved_into_id) WHERE (resolved_into_id IS NOT NULL);


--
-- Name: census_worklist_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX census_worklist_source_idx ON public.census_worklist USING btree (source_id);


--
-- Name: census_worklist_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX census_worklist_status_idx ON public.census_worklist USING btree (enumeration_status) WHERE (enumeration_status <> 'reconciled'::text);


--
-- Name: census_worklist_surface_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX census_worklist_surface_gin_idx ON public.census_worklist USING gin (surface_tags);


--
-- Name: claim_versions_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX claim_versions_current_idx ON public.claim_versions USING btree (current_claim_id);


--
-- Name: claim_versions_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX claim_versions_item_idx ON public.claim_versions USING btree (intelligence_item_id);


--
-- Name: coverage_gaps_severity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX coverage_gaps_severity_idx ON public.coverage_gaps USING btree (severity);


--
-- Name: derivation_edges_from_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX derivation_edges_from_idx ON public.derivation_edges USING btree (from_table, from_pk);


--
-- Name: derivation_edges_to_table_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX derivation_edges_to_table_idx ON public.derivation_edges USING btree (to_table, to_value_id);


--
-- Name: derivation_edges_to_value_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX derivation_edges_to_value_idx ON public.derivation_edges USING btree (to_value_id);


--
-- Name: derived_values_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX derived_values_current_idx ON public.derived_values USING btree (value_id) WHERE (invalidated_at IS NULL);


--
-- Name: derived_values_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX derived_values_entity_idx ON public.derived_values USING btree (entity_id) WHERE (entity_id IS NOT NULL);


--
-- Name: derived_values_method_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX derived_values_method_idx ON public.derived_values USING btree (method_id, method_version);


--
-- Name: derived_values_stale_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX derived_values_stale_idx ON public.derived_values USING btree (admissibility) WHERE (admissibility = 'stale'::text);


--
-- Name: derived_values_supersedes_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX derived_values_supersedes_idx ON public.derived_values USING btree (supersedes) WHERE (supersedes IS NOT NULL);


--
-- Name: emission_factors_corridor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX emission_factors_corridor_idx ON public.emission_factors USING btree (corridor_id, mode, valid_from DESC) WHERE (corridor_id IS NOT NULL);


--
-- Name: emission_factors_modal_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX emission_factors_modal_lookup_idx ON public.emission_factors USING btree (mode, jurisdiction, energy_carrier, vehicle_class, valid_from DESC) WHERE ((scope_kind = 'modal'::text) AND (superseded_by IS NULL));


--
-- Name: emission_factors_operator_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX emission_factors_operator_idx ON public.emission_factors USING btree (operator_key, mode, valid_from DESC) WHERE (operator_key IS NOT NULL);


--
-- Name: emission_factors_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX emission_factors_source_idx ON public.emission_factors USING btree (source_key);


--
-- Name: entities_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_kind_idx ON public.entities USING btree (kind);


--
-- Name: entities_merged_into_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entities_merged_into_idx ON public.entities USING btree (merged_into) WHERE (merged_into IS NOT NULL);


--
-- Name: entity_refs_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_refs_entity_idx ON public.entity_refs USING btree (entity_id);


--
-- Name: entity_refs_ref_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_refs_ref_idx ON public.entity_refs USING btree (ref_table, ref_id);


--
-- Name: entity_relations_child_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_relations_child_idx ON public.entity_relations USING btree (child_entity_id);


--
-- Name: entity_scope_scope_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX entity_scope_scope_id_idx ON public.entity_scope USING btree (scope_id);


--
-- Name: estimated_values_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX estimated_values_entity_idx ON public.estimated_values USING btree (entity_id);


--
-- Name: estimated_values_model_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX estimated_values_model_idx ON public.estimated_values USING btree (model_id, model_version);


--
-- Name: grid_connection_queues_jurisdiction_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX grid_connection_queues_jurisdiction_idx ON public.grid_connection_queues USING btree (jurisdiction_id);


--
-- Name: harness_runs_family_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harness_runs_family_started_idx ON public.harness_runs USING btree (harness_family, started_at DESC);


--
-- Name: harness_runs_github_run_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX harness_runs_github_run_id_idx ON public.harness_runs USING btree (github_run_id);


--
-- Name: holdings_quality_completeness_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX holdings_quality_completeness_idx ON public.holdings_quality USING btree (completeness);


--
-- Name: holdings_quality_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX holdings_quality_item_idx ON public.holdings_quality USING btree (intelligence_item_id);


--
-- Name: holdings_quality_pool_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX holdings_quality_pool_uq ON public.holdings_quality USING btree (intelligence_item_id) WHERE (capture_kind = 'pool'::text);


--
-- Name: holdings_quality_snapshot_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX holdings_quality_snapshot_uq ON public.holdings_quality USING btree (capture_ref) WHERE (capture_kind = 'snapshot'::text);


--
-- Name: holdings_quality_sufficiency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX holdings_quality_sufficiency_idx ON public.holdings_quality USING btree (sufficiency);


--
-- Name: idx_agent_run_searches_item_chars; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_run_searches_item_chars ON public.agent_run_searches USING btree (intelligence_item_id, result_chars);


--
-- Name: idx_agent_run_searches_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_run_searches_item_id ON public.agent_run_searches USING btree (intelligence_item_id);


--
-- Name: idx_agent_run_searches_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_run_searches_run_id ON public.agent_run_searches USING btree (agent_run_id);


--
-- Name: idx_agent_runs_mtd; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_mtd ON public.agent_runs USING btree (started_at, cost_usd_estimated, status);


--
-- Name: idx_agent_runs_source_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_source_started ON public.agent_runs USING btree (source_id, started_at DESC);


--
-- Name: idx_agent_runs_started_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_started_desc ON public.agent_runs USING btree (started_at DESC);


--
-- Name: idx_agent_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_agent_runs_status ON public.agent_runs USING btree (status, started_at DESC);


--
-- Name: idx_bulk_imports_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bulk_imports_created ON public.bulk_imports USING btree (created_at DESC);


--
-- Name: idx_bulk_imports_imported_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bulk_imports_imported_by ON public.bulk_imports USING btree (imported_by);


--
-- Name: idx_canonical_candidates_classification; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canonical_candidates_classification ON public.canonical_source_candidates USING btree (issue_classification);


--
-- Name: idx_canonical_candidates_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canonical_candidates_item ON public.canonical_source_candidates USING btree (intelligence_item_id);


--
-- Name: idx_canonical_candidates_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_canonical_candidates_pending ON public.canonical_source_candidates USING btree (decision) WHERE (decision = 'pending'::text);


--
-- Name: idx_census_worklist_archived; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_census_worklist_archived ON public.census_worklist USING btree (is_archived) WHERE (is_archived = true);


--
-- Name: idx_census_worklist_would_mint_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_census_worklist_would_mint_identity ON public.census_worklist USING btree (dryrun_disposition, identity_resolves) WHERE (dryrun_disposition = 'would_mint'::text);


--
-- Name: idx_citations_cited; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_citations_cited ON public.source_citations USING btree (cited_source_id);


--
-- Name: idx_citations_citing; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_citations_citing ON public.source_citations USING btree (citing_source_id);


--
-- Name: idx_community_group_invitations_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_group_invitations_group ON public.community_group_invitations USING btree (group_id);


--
-- Name: idx_community_group_invitations_invitee_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_group_invitations_invitee_pending ON public.community_group_invitations USING btree (invitee_user_id) WHERE (status = 'pending'::text);


--
-- Name: idx_community_group_invitations_unique_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_community_group_invitations_unique_pending ON public.community_group_invitations USING btree (group_id, invitee_user_id) WHERE (status = 'pending'::text);


--
-- Name: idx_community_group_members_group_role; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_group_members_group_role ON public.community_group_members USING btree (group_id, role);


--
-- Name: idx_community_group_members_starred; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_group_members_starred ON public.community_group_members USING btree (user_id) WHERE (starred = true);


--
-- Name: idx_community_group_members_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_group_members_user ON public.community_group_members USING btree (user_id);


--
-- Name: idx_community_groups_last_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_groups_last_active ON public.community_groups USING btree (last_active_at DESC);


--
-- Name: idx_community_groups_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_groups_owner ON public.community_groups USING btree (owner_user_id);


--
-- Name: idx_community_groups_privacy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_groups_privacy ON public.community_groups USING btree (privacy);


--
-- Name: idx_community_groups_region; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_groups_region ON public.community_groups USING btree (region);


--
-- Name: idx_community_groups_vertical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_groups_vertical ON public.community_groups USING btree (vertical, last_active_at DESC) WHERE (vertical IS NOT NULL);


--
-- Name: idx_community_member_profiles_verified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_member_profiles_verified ON public.community_member_profiles USING btree (verified);


--
-- Name: idx_community_posts_author; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_posts_author ON public.community_posts USING btree (author_user_id);


--
-- Name: idx_community_posts_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_posts_group ON public.community_posts USING btree (group_id);


--
-- Name: idx_community_posts_group_last_reply; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_posts_group_last_reply ON public.community_posts USING btree (group_id, last_reply_at DESC NULLS LAST);


--
-- Name: idx_community_posts_parent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_posts_parent ON public.community_posts USING btree (parent_post_id);


--
-- Name: idx_community_posts_promoted_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_posts_promoted_from ON public.community_posts USING btree (promoted_from_post_id) WHERE (promoted_from_post_id IS NOT NULL);


--
-- Name: idx_community_posts_ref_intel_ids; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_posts_ref_intel_ids ON public.community_posts USING gin (referenced_intelligence_item_ids);


--
-- Name: idx_community_thread_entities_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_thread_entities_entity ON public.community_thread_entities USING btree (entity_id, thread_id);


--
-- Name: idx_community_topic_groups_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_topic_groups_group ON public.community_topic_groups USING btree (group_id);


--
-- Name: idx_community_topics_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_community_topics_owner ON public.community_topics USING btree (owner_user_id);


--
-- Name: idx_connection_theme_runs_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connection_theme_runs_started ON public.connection_theme_runs USING btree (started_at DESC);


--
-- Name: idx_connection_themes_convergence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_connection_themes_convergence ON public.connection_themes USING btree (convergence DESC);


--
-- Name: idx_corpus_turn_requests_open_requested_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_corpus_turn_requests_open_requested_at ON public.corpus_turn_requests USING btree (requested_at) WHERE (consumed_at IS NULL);


--
-- Name: idx_disposition_ledger_canonical; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_disposition_ledger_canonical ON public.disposition_ledger USING btree (canonical_instrument_key);


--
-- Name: idx_error_events_dedup; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_error_events_dedup ON public.error_events USING btree (stack_hash, release, side, route);


--
-- Name: idx_error_events_hash_release; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_error_events_hash_release ON public.error_events USING btree (stack_hash, release);


--
-- Name: idx_error_events_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_error_events_last_seen ON public.error_events USING btree (last_seen_at DESC);


--
-- Name: idx_iiv_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_iiv_created_at ON public.intelligence_item_versions USING btree (created_at DESC);


--
-- Name: idx_iiv_item_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_iiv_item_version ON public.intelligence_item_versions USING btree (intelligence_item_id, version_number DESC);


--
-- Name: idx_integrity_flags_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integrity_flags_category ON public.integrity_flags USING btree (category);


--
-- Name: idx_integrity_flags_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integrity_flags_status ON public.integrity_flags USING btree (status) WHERE (status = ANY (ARRAY['open'::text, 'in_review'::text]));


--
-- Name: idx_integrity_flags_subject; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integrity_flags_subject ON public.integrity_flags USING btree (subject_type, subject_ref);


--
-- Name: idx_intel_changes_detected_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intel_changes_detected_at ON public.intelligence_changes USING btree (detected_at DESC);


--
-- Name: idx_intel_changes_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intel_changes_item_id ON public.intelligence_changes USING btree (item_id);


--
-- Name: idx_intel_items_added_date_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intel_items_added_date_desc ON public.intelligence_items USING btree (added_date DESC);


--
-- Name: idx_intel_items_agent_integrity_flag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intel_items_agent_integrity_flag ON public.intelligence_items USING btree (agent_integrity_flag) WHERE ((agent_integrity_flag = true) AND (agent_integrity_resolved_at IS NULL));


--
-- Name: idx_intel_items_jurisdiction_iso; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intel_items_jurisdiction_iso ON public.intelligence_items USING gin (jurisdiction_iso);


--
-- Name: idx_intel_summaries_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intel_summaries_item_id ON public.intelligence_summaries USING btree (item_id);


--
-- Name: idx_intel_summaries_sector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intel_summaries_sector ON public.intelligence_summaries USING btree (sector);


--
-- Name: idx_intelligence_items_agent_integrity_resolved_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intelligence_items_agent_integrity_resolved_by ON public.intelligence_items USING btree (agent_integrity_resolved_by);


--
-- Name: idx_intelligence_items_pipeline_stage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intelligence_items_pipeline_stage ON public.intelligence_items USING btree (pipeline_stage);


--
-- Name: idx_intelligence_items_replaced_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intelligence_items_replaced_by ON public.intelligence_items USING btree (replaced_by);


--
-- Name: idx_intelligence_items_search_tsv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intelligence_items_search_tsv ON public.intelligence_items USING gin (search_tsv);


--
-- Name: idx_item_changelog_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_changelog_date ON public.item_changelog USING btree (change_date);


--
-- Name: idx_item_changelog_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_changelog_item ON public.item_changelog USING btree (item_id);


--
-- Name: idx_item_disputes_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_disputes_active ON public.item_disputes USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_item_disputes_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_disputes_item ON public.item_disputes USING btree (item_id);


--
-- Name: idx_item_forward_events_event_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_forward_events_event_date ON public.item_forward_events USING btree (event_date);


--
-- Name: idx_item_forward_events_intelligence_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_forward_events_intelligence_item_id ON public.item_forward_events USING btree (intelligence_item_id);


--
-- Name: idx_item_gate_a_state_orphans; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_gate_a_state_orphans ON public.item_gate_a_state USING btree (orphan_count) WHERE (orphan_count > 0);


--
-- Name: idx_item_sections_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_sections_item_id ON public.intelligence_item_sections USING btree (item_id);


--
-- Name: idx_item_sections_section_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_sections_section_key ON public.intelligence_item_sections USING btree (section_key);


--
-- Name: idx_item_sections_source_ids; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_sections_source_ids ON public.intelligence_item_sections USING gin (source_ids);


--
-- Name: idx_item_supersessions_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_supersessions_new ON public.item_supersessions USING btree (new_item_id);


--
-- Name: idx_item_supersessions_old; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_supersessions_old ON public.item_supersessions USING btree (old_item_id);


--
-- Name: idx_item_timelines_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_timelines_date ON public.item_timelines USING btree (milestone_date);


--
-- Name: idx_item_timelines_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_timelines_item ON public.item_timelines USING btree (item_id);


--
-- Name: idx_item_type_required_slots_item_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_type_required_slots_item_type ON public.item_type_required_slots USING btree (item_type);


--
-- Name: idx_item_xref_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_xref_source ON public.item_cross_references USING btree (source_item_id);


--
-- Name: idx_item_xref_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_item_xref_target ON public.item_cross_references USING btree (target_item_id);


--
-- Name: idx_items_archived; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_archived ON public.intelligence_items USING btree (is_archived) WHERE (is_archived = true);


--
-- Name: idx_items_compliance_object_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_compliance_object_tags ON public.intelligence_items USING gin (compliance_object_tags);


--
-- Name: idx_items_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_domain ON public.intelligence_items USING btree (domain);


--
-- Name: idx_items_format_urgency; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_format_urgency ON public.intelligence_items USING btree (format_type, urgency_tier) WHERE (format_type IS NOT NULL);


--
-- Name: idx_items_jurisdictions; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_jurisdictions ON public.intelligence_items USING gin (jurisdictions);


--
-- Name: idx_items_last_regenerated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_last_regenerated ON public.intelligence_items USING btree (last_regenerated_at) WHERE (last_regenerated_at IS NOT NULL);


--
-- Name: idx_items_legacy; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_legacy ON public.intelligence_items USING btree (legacy_id) WHERE (legacy_id IS NOT NULL);


--
-- Name: idx_items_op_scenario_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_op_scenario_tags ON public.intelligence_items USING gin (operational_scenario_tags);


--
-- Name: idx_items_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_priority ON public.intelligence_items USING btree (priority);


--
-- Name: idx_items_region_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_region_tags ON public.intelligence_items USING gin (region_tags);


--
-- Name: idx_items_related_items; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_related_items ON public.intelligence_items USING gin (related_items);


--
-- Name: idx_items_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_severity ON public.intelligence_items USING btree (severity);


--
-- Name: idx_items_signal_band; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_signal_band ON public.intelligence_items USING btree (signal_band) WHERE (signal_band IS NOT NULL);


--
-- Name: idx_items_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_source ON public.intelligence_items USING btree (source_id);


--
-- Name: idx_items_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_status ON public.intelligence_items USING btree (status);


--
-- Name: idx_items_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_tags ON public.intelligence_items USING gin (tags);


--
-- Name: idx_items_theme; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_theme ON public.intelligence_items USING btree (theme) WHERE (theme IS NOT NULL);


--
-- Name: idx_items_theme_candidate; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_theme_candidate ON public.intelligence_items USING btree (theme_candidate) WHERE (theme_candidate IS NOT NULL);


--
-- Name: idx_items_topic_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_topic_tags ON public.intelligence_items USING gin (topic_tags);


--
-- Name: idx_items_transport; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_transport ON public.intelligence_items USING gin (transport_modes);


--
-- Name: idx_items_urgency_tier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_urgency_tier ON public.intelligence_items USING btree (urgency_tier) WHERE (urgency_tier IS NOT NULL);


--
-- Name: idx_items_vertical_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_vertical_tags ON public.intelligence_items USING gin (vertical_tags);


--
-- Name: idx_items_verticals; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_items_verticals ON public.intelligence_items USING gin (verticals);


--
-- Name: idx_memberships_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_org ON public.org_memberships USING btree (org_id);


--
-- Name: idx_memberships_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memberships_user ON public.org_memberships USING btree (user_id);


--
-- Name: idx_moderation_reports_reporter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moderation_reports_reporter ON public.moderation_reports USING btree (reporter_user_id);


--
-- Name: idx_moderation_reports_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moderation_reports_status ON public.moderation_reports USING btree (status, created_at DESC) WHERE (status = 'open'::text);


--
-- Name: idx_moderation_reports_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_moderation_reports_target ON public.moderation_reports USING btree (target_kind, target_id);


--
-- Name: idx_monitoring_queue_unreconciled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_monitoring_queue_unreconciled ON public.monitoring_queue USING btree (checked_at) WHERE ((change_detected = true) AND (reconciled_at IS NULL));


--
-- Name: idx_mq_priority; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mq_priority ON public.monitoring_queue USING btree (priority, scheduled_check);


--
-- Name: idx_mq_scheduled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mq_scheduled ON public.monitoring_queue USING btree (scheduled_check) WHERE (checked_at IS NULL);


--
-- Name: idx_mq_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mq_source ON public.monitoring_queue USING btree (source_id);


--
-- Name: idx_notifications_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_created ON public.notifications USING btree (user_id, created_at DESC);


--
-- Name: idx_notifications_user_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_unread ON public.notifications USING btree (user_id, created_at DESC) WHERE (read_at IS NULL);


--
-- Name: idx_obligation_objects_capture; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_obligation_objects_capture ON public.obligation_objects USING btree (capture_id);


--
-- Name: idx_obligation_objects_instrument_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_obligation_objects_instrument_entity ON public.obligation_objects USING btree (instrument_entity_id) WHERE (instrument_entity_id IS NOT NULL);


--
-- Name: idx_obligation_objects_instrument_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_obligation_objects_instrument_item ON public.obligation_objects USING btree (instrument_item_id);


--
-- Name: idx_obligation_objects_supersedes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_obligation_objects_supersedes ON public.obligation_objects USING btree (supersedes) WHERE (supersedes IS NOT NULL);


--
-- Name: idx_obligations_due_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_obligations_due_date ON public.obligations USING btree (due_date);


--
-- Name: idx_obligations_intelligence_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_obligations_intelligence_item_id ON public.obligations USING btree (intelligence_item_id);


--
-- Name: idx_obligations_jurisdiction_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_obligations_jurisdiction_gin ON public.obligations USING gin (jurisdiction);


--
-- Name: idx_obligations_modes_gin; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_obligations_modes_gin ON public.obligations USING gin (modes);


--
-- Name: idx_obligations_obligation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_obligations_obligation_id ON public.obligations USING btree (obligation_id) WHERE (obligation_id IS NOT NULL);


--
-- Name: idx_org_invitations_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_invitations_email ON public.org_invitations USING btree (invited_email) WHERE (status = 'pending'::text);


--
-- Name: idx_org_invitations_org_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_invitations_org_status ON public.org_invitations USING btree (org_id, status);


--
-- Name: idx_org_member_bans_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_member_bans_user ON public.org_member_bans USING btree (user_id);


--
-- Name: idx_org_memberships_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_memberships_user_id ON public.org_memberships USING btree (user_id);


--
-- Name: idx_org_watchlist_added_by_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_watchlist_added_by_user_id ON public.org_watchlist USING btree (added_by_user_id);


--
-- Name: idx_org_watchlist_org_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_org_watchlist_org_created ON public.org_watchlist USING btree (org_id, created_at DESC);


--
-- Name: idx_organizations_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organizations_slug ON public.organizations USING btree (slug);


--
-- Name: idx_overrides_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_overrides_item ON public.workspace_item_overrides USING btree (item_id);


--
-- Name: idx_overrides_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_overrides_org ON public.workspace_item_overrides USING btree (org_id);


--
-- Name: idx_overrides_org_archived; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_overrides_org_archived ON public.workspace_item_overrides USING btree (org_id) WHERE (is_archived = true);


--
-- Name: idx_overrides_org_dismissed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_overrides_org_dismissed ON public.workspace_item_overrides USING btree (org_id) WHERE (dismissed_at IS NOT NULL);


--
-- Name: idx_pff_source_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_pff_source_open ON public.pending_first_fetch USING btree (source_id) WHERE (status <> ALL (ARRAY['done'::text, 'skipped'::text]));


--
-- Name: idx_pff_status_queued_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pff_status_queued_at ON public.pending_first_fetch USING btree (status, queued_at);


--
-- Name: idx_plc_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plc_source ON public.portal_link_candidates USING btree (source_id);


--
-- Name: idx_plc_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plc_status ON public.portal_link_candidates USING btree (status) WHERE (status = 'candidate'::text);


--
-- Name: idx_profiles_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_org_id ON public.profiles USING btree (org_id) WHERE (org_id IS NOT NULL);


--
-- Name: idx_profiles_region; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_region ON public.profiles USING gin (region);


--
-- Name: idx_profiles_sector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_sector ON public.profiles USING gin (sector);


--
-- Name: idx_provisional_cited_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisional_cited_by ON public.provisional_sources USING btree (cited_by_source_id);


--
-- Name: idx_provisional_discovered_for_jurisdiction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisional_discovered_for_jurisdiction ON public.provisional_sources USING btree (discovered_for_jurisdiction) WHERE (discovered_for_jurisdiction IS NOT NULL);


--
-- Name: idx_provisional_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_provisional_status ON public.provisional_sources USING btree (status);


--
-- Name: idx_raw_fetches_source_fetched; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_raw_fetches_source_fetched ON public.raw_fetches USING btree (source_id, fetched_at DESC);


--
-- Name: idx_raw_fetches_source_hash_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_raw_fetches_source_hash_uniq ON public.raw_fetches USING btree (source_id, content_hash);


--
-- Name: idx_rdc_region_dim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rdc_region_dim ON public.region_dimension_coverage USING btree (region_id, dimension);


--
-- Name: idx_rdc_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rdc_state ON public.region_dimension_coverage USING btree (state);


--
-- Name: idx_regional_data_facts_region_dim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_regional_data_facts_region_dim ON public.regional_data_facts USING btree (region_id, dimension);


--
-- Name: idx_regional_data_facts_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_regional_data_facts_source ON public.regional_data_facts USING btree (source_id) WHERE (source_id IS NOT NULL);


--
-- Name: idx_regions_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_regions_code ON public.regions USING btree (code);


--
-- Name: idx_regions_iso_codes; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_regions_iso_codes ON public.regions USING gin (iso_codes);


--
-- Name: idx_section_claim_provenance_claim_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_section_claim_provenance_claim_kind ON public.section_claim_provenance USING btree (claim_kind);


--
-- Name: idx_section_claim_provenance_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_section_claim_provenance_item_id ON public.section_claim_provenance USING btree (intelligence_item_id);


--
-- Name: idx_section_claim_provenance_section_row_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_section_claim_provenance_section_row_id ON public.section_claim_provenance USING btree (section_row_id);


--
-- Name: idx_section_claim_provenance_source_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_section_claim_provenance_source_id ON public.section_claim_provenance USING btree (source_id);


--
-- Name: idx_signoff_post; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_signoff_post ON public.community_post_signoff_requests USING btree (post_id);


--
-- Name: idx_source_verifications_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_verifications_created ON public.source_verifications USING btree (created_at DESC);


--
-- Name: idx_source_verifications_resulting_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_verifications_resulting_source ON public.source_verifications USING btree (resulting_source_id) WHERE (resulting_source_id IS NOT NULL);


--
-- Name: idx_source_verifications_tier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_verifications_tier ON public.source_verifications USING btree (verification_tier);


--
-- Name: idx_source_verifications_url; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_source_verifications_url ON public.source_verifications USING btree (candidate_url);


--
-- Name: idx_sources_auto_run_enabled_true; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_auto_run_enabled_true ON public.sources USING btree (id) WHERE (auto_run_enabled = true);


--
-- Name: idx_sources_awaiting_spotcheck; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_awaiting_spotcheck ON public.sources USING btree (created_at) WHERE (spotchecked = false);


--
-- Name: idx_sources_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_category ON public.sources USING btree (category) WHERE (category IS NOT NULL);


--
-- Name: idx_sources_domains; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_domains ON public.sources USING gin (domains);


--
-- Name: idx_sources_institution; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_institution ON public.sources USING btree (institution_id);


--
-- Name: idx_sources_jurisdiction_iso; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_jurisdiction_iso ON public.sources USING gin (jurisdiction_iso);


--
-- Name: idx_sources_jurisdictions; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_jurisdictions ON public.sources USING gin (jurisdictions);


--
-- Name: idx_sources_next_check; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_next_check ON public.sources USING btree (next_scheduled_check) WHERE (status = ANY (ARRAY['active'::text, 'stale'::text]));


--
-- Name: idx_sources_sitemap_last_walked_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_sitemap_last_walked_at ON public.sources USING btree (sitemap_last_walked_at NULLS FIRST) WHERE (status = 'active'::text);


--
-- Name: idx_sources_sitemap_walk_outcome; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_sitemap_walk_outcome ON public.sources USING btree (sitemap_walk_outcome) WHERE (status = 'active'::text);


--
-- Name: idx_sources_source_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_source_type ON public.sources USING gin (source_type);


--
-- Name: idx_sources_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_status ON public.sources USING btree (status);


--
-- Name: idx_sources_tier; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_tier ON public.sources USING btree (base_tier);


--
-- Name: idx_sources_topic_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_topic_tags ON public.sources USING gin (topic_tags);


--
-- Name: idx_sources_transport; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_transport ON public.sources USING gin (transport_modes);


--
-- Name: idx_sources_trust_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_trust_score ON public.sources USING btree (trust_score_overall);


--
-- Name: idx_sources_vertical_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sources_vertical_tags ON public.sources USING gin (vertical_tags);


--
-- Name: idx_staged_item; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staged_item ON public.staged_updates USING btree (item_id);


--
-- Name: idx_staged_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staged_source ON public.staged_updates USING btree (source_id);


--
-- Name: idx_staged_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staged_status ON public.staged_updates USING btree (status) WHERE (status = 'pending'::text);


--
-- Name: idx_staged_updates_unmaterialized; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_staged_updates_unmaterialized ON public.staged_updates USING btree (status, materialized_at) WHERE ((status = 'approved'::text) AND (materialized_at IS NULL));


--
-- Name: idx_state_cost_facts_region_dim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_state_cost_facts_region_dim ON public.state_cost_facts USING btree (region_id, dimension);


--
-- Name: idx_state_cost_facts_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_state_cost_facts_source ON public.state_cost_facts USING btree (source_id) WHERE (source_id IS NOT NULL);


--
-- Name: idx_state_cost_facts_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_state_cost_facts_state ON public.state_cost_facts USING btree (state_code);


--
-- Name: idx_trust_events_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trust_events_date ON public.source_trust_events USING btree (created_at);


--
-- Name: idx_trust_events_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trust_events_source ON public.source_trust_events USING btree (source_id);


--
-- Name: idx_trust_events_source_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trust_events_source_date ON public.source_trust_events USING btree (source_id, created_at DESC);


--
-- Name: idx_trust_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trust_events_type ON public.source_trust_events USING btree (event_type);


--
-- Name: idx_user_item_state_item_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_item_state_item_id ON public.user_item_state USING btree (item_id);


--
-- Name: idx_user_item_state_org_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_item_state_org_id ON public.user_item_state USING btree (org_id);


--
-- Name: idx_user_item_state_user_archived; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_item_state_user_archived ON public.user_item_state USING btree (user_id) WHERE is_archived;


--
-- Name: idx_workspace_item_overrides_archived_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_item_overrides_archived_by ON public.workspace_item_overrides USING btree (archived_by);


--
-- Name: idx_workspace_item_overrides_org_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_item_overrides_org_owner ON public.workspace_item_overrides USING btree (org_id, owner_user_id) WHERE (owner_user_id IS NOT NULL);


--
-- Name: idx_workspace_item_overrides_owner_assigned_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_item_overrides_owner_assigned_by ON public.workspace_item_overrides USING btree (owner_assigned_by);


--
-- Name: idx_workspace_item_overrides_owner_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_item_overrides_owner_user_id ON public.workspace_item_overrides USING btree (owner_user_id);


--
-- Name: idx_workspace_settings_org; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workspace_settings_org ON public.workspace_settings USING btree (org_id);


--
-- Name: indexation_clauses_corridor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX indexation_clauses_corridor_idx ON public.indexation_clauses USING btree (corridor_id) WHERE (corridor_id IS NOT NULL);


--
-- Name: indexation_clauses_index_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX indexation_clauses_index_idx ON public.indexation_clauses USING btree (index_id);


--
-- Name: indexation_clauses_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX indexation_clauses_org_idx ON public.indexation_clauses USING btree (org_id);


--
-- Name: inference_records_cited_item_ids_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inference_records_cited_item_ids_gin_idx ON public.inference_records USING gin (cited_item_ids);


--
-- Name: inference_records_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inference_records_current_idx ON public.inference_records USING btree (inference_id) WHERE (supersedes IS NULL);


--
-- Name: inference_records_method_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inference_records_method_idx ON public.inference_records USING btree (method_id, method_version);


--
-- Name: inference_records_stale_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inference_records_stale_idx ON public.inference_records USING btree (admissibility) WHERE (admissibility = 'stale'::text);


--
-- Name: inference_records_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inference_records_status_idx ON public.inference_records USING btree (status_token);


--
-- Name: inference_records_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inference_records_subject_idx ON public.inference_records USING btree (subject_id) WHERE (subject_id IS NOT NULL);


--
-- Name: inference_records_supersedes_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inference_records_supersedes_idx ON public.inference_records USING btree (supersedes) WHERE (supersedes IS NOT NULL);


--
-- Name: inference_records_trigger_question_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX inference_records_trigger_question_idx ON public.inference_records USING btree (trigger_question_ref) WHERE (trigger_question_ref IS NOT NULL);


--
-- Name: ingest_rejections_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ingest_rejections_source_idx ON public.ingest_rejections USING btree (source_id) WHERE (source_id IS NOT NULL);


--
-- Name: ingest_rejections_untriaged_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ingest_rejections_untriaged_idx ON public.ingest_rejections USING btree (ingest_attempted_at DESC) WHERE (triaged_at IS NULL);


--
-- Name: intelligence_item_citations_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX intelligence_item_citations_item_idx ON public.intelligence_item_citations USING btree (intelligence_item_id);


--
-- Name: intelligence_item_citations_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX intelligence_item_citations_source_idx ON public.intelligence_item_citations USING btree (source_id);


--
-- Name: intelligence_item_citations_source_recency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX intelligence_item_citations_source_recency_idx ON public.intelligence_item_citations USING btree (source_id, detected_at DESC);


--
-- Name: intelligence_items_canonical_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX intelligence_items_canonical_key_idx ON public.intelligence_items USING btree (jurisdiction_iso, instrument_type, instrument_identifier) WHERE ((instrument_type IS NOT NULL) AND (instrument_identifier IS NOT NULL));


--
-- Name: INDEX intelligence_items_canonical_key_idx; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.intelligence_items_canonical_key_idx IS 'Canonical-entity unique key for RC-9 dedup prevention. Partial WHERE requires BOTH instrument_type AND instrument_identifier to be NOT NULL: PostgreSQL treats two NULLs in a unique key as distinct, so without the type check, rows like (US, NULL, ''cfr-40-part-60'') x 2 would BOTH be allowed and defeat the constraint during partial backfills or classifier edge cases. Non-regulatory items (regional_data, tool, technology, innovation) have both fields NULL and coexist freely; only regulatory rows with both fields populated are subject to the canonical-key contract. Phase 6 ingest computes the key before INSERT and UPDATEs existing rows on match.';


--
-- Name: intelligence_items_instrument_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX intelligence_items_instrument_entity_idx ON public.intelligence_items USING btree (instrument_entity_id) WHERE (instrument_entity_id IS NOT NULL);


--
-- Name: intelligence_items_item_grade_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX intelligence_items_item_grade_idx ON public.intelligence_items USING btree (item_grade) WHERE (item_grade = 'record'::text);


--
-- Name: item_assignments_assigned_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX item_assignments_assigned_by_idx ON public.item_assignments USING btree (assigned_by);


--
-- Name: item_assignments_assignee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX item_assignments_assignee_idx ON public.item_assignments USING btree (assignee_user_id, state);


--
-- Name: item_assignments_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX item_assignments_item_idx ON public.item_assignments USING btree (item_id);


--
-- Name: item_assignments_org_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX item_assignments_org_item_idx ON public.item_assignments USING btree (org_id, item_id);


--
-- Name: item_corrections_active_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX item_corrections_active_item_idx ON public.item_corrections USING btree (item_id, target_kind) WHERE (revoked_at IS NULL);


--
-- Name: item_corrections_item_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX item_corrections_item_created_idx ON public.item_corrections USING btree (item_id, created_at DESC);


--
-- Name: item_notes_author_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX item_notes_author_idx ON public.item_notes USING btree (author_user_id);


--
-- Name: item_notes_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX item_notes_item_idx ON public.item_notes USING btree (item_id);


--
-- Name: item_notes_org_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX item_notes_org_item_idx ON public.item_notes USING btree (org_id, item_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: item_workspace_tags_org_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX item_workspace_tags_org_item_idx ON public.item_workspace_tags USING btree (org_id, intelligence_item_id);


--
-- Name: item_workspace_tags_org_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX item_workspace_tags_org_name_idx ON public.item_workspace_tags USING btree (org_id, tag_id);


--
-- Name: market_series_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX market_series_entity_idx ON public.market_series USING btree (entity_id) WHERE (entity_id IS NOT NULL);


--
-- Name: market_series_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX market_series_lookup_idx ON public.market_series USING btree (series_key, reference_period DESC);


--
-- Name: market_series_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX market_series_source_idx ON public.market_series USING btree (source_key) WHERE (source_key IS NOT NULL);


--
-- Name: oem_tech_roadmaps_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oem_tech_roadmaps_category_idx ON public.oem_tech_roadmaps USING btree (tech_category);


--
-- Name: oem_tech_roadmaps_manufacturer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oem_tech_roadmaps_manufacturer_idx ON public.oem_tech_roadmaps USING btree (manufacturer_id);


--
-- Name: one_entity_per_identifier; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX one_entity_per_identifier ON public.entity_identifiers USING btree (scheme, value, COALESCE(scheme_version, ''::text));


--
-- Name: INDEX one_entity_per_identifier; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.one_entity_per_identifier IS 'An external identifier value (within one scheme+version) resolves to at most ONE entity — the crosswalk integrity guarantee spec §8, falsification test 1 depends on.';


--
-- Name: org_invitations_pending_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX org_invitations_pending_unique ON public.org_invitations USING btree (org_id, invited_email) WHERE (status = 'pending'::text);


--
-- Name: pjr_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pjr_item_idx ON public.pending_jurisdiction_review USING btree (intelligence_item_id);


--
-- Name: pjr_unresolved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pjr_unresolved_idx ON public.pending_jurisdiction_review USING btree (flagged_at DESC) WHERE (resolved_at IS NULL);


--
-- Name: pjr_unresolved_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX pjr_unresolved_unique_idx ON public.pending_jurisdiction_review USING btree (intelligence_item_id, current_value, source_column) WHERE (resolved_at IS NULL);


--
-- Name: portfolio_members_entity_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portfolio_members_entity_uidx ON public.portfolio_members USING btree (portfolio_id, entity_id) WHERE (entity_id IS NOT NULL);


--
-- Name: portfolio_members_item_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portfolio_members_item_uidx ON public.portfolio_members USING btree (portfolio_id, item_id) WHERE (item_id IS NOT NULL);


--
-- Name: portfolio_members_org_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portfolio_members_org_entity_idx ON public.portfolio_members USING btree (org_id, entity_id) WHERE (entity_id IS NOT NULL);


--
-- Name: portfolio_members_org_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX portfolio_members_org_item_idx ON public.portfolio_members USING btree (org_id, item_id) WHERE (item_id IS NOT NULL);


--
-- Name: portfolios_org_name_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX portfolios_org_name_key_uidx ON public.portfolios USING btree (org_id, name_key);


--
-- Name: propagation_events_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX propagation_events_entity_idx ON public.propagation_events USING btree (entity_id) WHERE (entity_id IS NOT NULL);


--
-- Name: propagation_events_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX propagation_events_pending_idx ON public.propagation_events USING btree (occurred_at) WHERE (drained_at IS NULL);


--
-- Name: propagation_events_table_pk_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX propagation_events_table_pk_idx ON public.propagation_events USING btree (table_name, row_pk);


--
-- Name: published_price_statistics_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX published_price_statistics_item_idx ON public.published_price_statistics USING btree (item_id, sort_order);


--
-- Name: reroute_events_baseline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reroute_events_baseline_idx ON public.reroute_events USING btree (baseline_corridor_id);


--
-- Name: reroute_events_reroute_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX reroute_events_reroute_idx ON public.reroute_events USING btree (reroute_corridor_id);


--
-- Name: research_assessments_entity_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_assessments_entity_id_idx ON public.research_assessments USING btree (entity_id) WHERE (entity_id IS NOT NULL);


--
-- Name: research_assessments_item_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_assessments_item_id_idx ON public.research_assessments USING btree (item_id);


--
-- Name: research_assessments_one_current_per_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX research_assessments_one_current_per_item_idx ON public.research_assessments USING btree (item_id) WHERE is_current;


--
-- Name: research_assessments_supersedes_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_assessments_supersedes_idx ON public.research_assessments USING btree (supersedes);


--
-- Name: signposts_assessment_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signposts_assessment_id_idx ON public.signposts USING btree (assessment_id);


--
-- Name: signposts_unfired_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signposts_unfired_idx ON public.signposts USING btree (fired_at) WHERE (fired_at IS NULL);


--
-- Name: signposts_unscored_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signposts_unscored_idx ON public.signposts USING btree (watches) WHERE (outcome IS NULL);


--
-- Name: signposts_watches_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX signposts_watches_idx ON public.signposts USING btree (watches);


--
-- Name: source_bias_tags_review_queue_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_bias_tags_review_queue_idx ON public.source_bias_tags USING btree (assignment_source) WHERE (assignment_source = 'haiku_proposed_low_confidence'::text);


--
-- Name: source_bias_tags_source_dimension_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_bias_tags_source_dimension_idx ON public.source_bias_tags USING btree (source_id, dimension);


--
-- Name: source_bias_tags_source_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_bias_tags_source_id_idx ON public.source_bias_tags USING btree (source_id);


--
-- Name: source_reliability_ledger_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_reliability_ledger_source_idx ON public.source_reliability_ledger USING btree (source_id, scored_at);


--
-- Name: source_tier_opinions_active_by_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_tier_opinions_active_by_target_idx ON public.source_tier_opinions USING btree (target_source_id) WHERE (dismissed_at IS NULL);


--
-- Name: source_tier_opinions_opinion_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_tier_opinions_opinion_source_idx ON public.source_tier_opinions USING btree (opinion_source);


--
-- Name: source_tier_opinions_target_opined_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_tier_opinions_target_opined_idx ON public.source_tier_opinions USING btree (target_source_id, opined_at DESC);


--
-- Name: sources_organisation_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sources_organisation_entity_idx ON public.sources USING btree (organisation_entity_id) WHERE (organisation_entity_id IS NOT NULL);


--
-- Name: sources_workspace_visible_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sources_workspace_visible_idx ON public.sources USING btree (status, admin_only) WHERE ((status = 'active'::text) AND (admin_only = false));


--
-- Name: statutory_computations_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statutory_computations_entity_idx ON public.statutory_computations USING btree (entity_id);


--
-- Name: statutory_computations_formula_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statutory_computations_formula_idx ON public.statutory_computations USING btree (formula_id, formula_version);


--
-- Name: statutory_computations_obligation_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX statutory_computations_obligation_idx ON public.statutory_computations USING btree (obligation_id);


--
-- Name: uniq_signoff_open_per_post; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_signoff_open_per_post ON public.community_post_signoff_requests USING btree (post_id) WHERE (status = 'pending'::text);


--
-- Name: uq_corpus_turn_requests_open_per_item; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_corpus_turn_requests_open_per_item ON public.corpus_turn_requests USING btree (intelligence_item_id) WHERE (consumed_at IS NULL);


--
-- Name: uq_intelligence_items_canonical_key_verified_live; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_intelligence_items_canonical_key_verified_live ON public.intelligence_items USING btree (canonical_instrument_key) WHERE ((canonical_instrument_key IS NOT NULL) AND (provenance_status = 'verified'::public.provenance_status) AND (is_archived IS NOT TRUE));


--
-- Name: uq_item_forward_events_text_identity; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_item_forward_events_text_identity ON public.item_forward_events USING btree (intelligence_item_id, event_kind, event_date, md5(obligation_text));


--
-- Name: INDEX uq_item_forward_events_text_identity; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.uq_item_forward_events_text_identity IS 'Dedupe key for forward events, replacing migration 275''s (item, date, kind, md5(text), coalesce(source_claim_id, source_section_id)) index -- the source-object term let a claim-backed row and a section-backed row with byte-identical obligation_text coexist (359 live duplicate groups, lane FE-DEDUP, 2026-09-04). Dropping that term makes any future row sharing (item, event_kind, event_date, obligation_text) with an existing row, regardless of which table backs it, impossible to insert -- a genuinely distinct obligation sharing the same item/date/kind (Euro 7''s phase-out schedule, NZIA''s several 2030-01-01 targets) still coexists freely, because its text differs.';


--
-- Name: user_watchlist_org_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_watchlist_org_idx ON public.user_watchlist USING btree (org_id);


--
-- Name: user_watchlist_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_watchlist_user_idx ON public.user_watchlist USING btree (user_id);


--
-- Name: vocabulary_mentions_item_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vocabulary_mentions_item_idx ON public.vocabulary_mentions USING btree (item_id);


--
-- Name: vocabulary_mentions_term_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vocabulary_mentions_term_idx ON public.vocabulary_mentions USING btree (term_id);


--
-- Name: vocabulary_terms_status_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vocabulary_terms_status_kind_idx ON public.vocabulary_terms USING btree (status, kind);


--
-- Name: workspace_tags_org_name_key_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_tags_org_name_key_uidx ON public.workspace_tags USING btree (org_id, name_key);


--
-- Name: agent_run_searches agent_run_searches_result_chars_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER agent_run_searches_result_chars_trg BEFORE INSERT OR UPDATE OF result_content ON public.agent_run_searches FOR EACH ROW EXECUTE FUNCTION public.agent_run_searches_set_result_chars();


--
-- Name: census_worklist census_worklist_guarded_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER census_worklist_guarded_update BEFORE UPDATE ON public.census_worklist FOR EACH ROW EXECUTE FUNCTION public.census_worklist_guarded_update();


--
-- Name: census_worklist census_worklist_no_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER census_worklist_no_delete BEFORE DELETE ON public.census_worklist FOR EACH ROW EXECUTE FUNCTION public.census_worklist_no_delete();


--
-- Name: community_group_members community_group_members_count_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER community_group_members_count_trigger AFTER INSERT OR DELETE ON public.community_group_members FOR EACH ROW EXECUTE FUNCTION public.update_community_group_member_count();


--
-- Name: community_groups community_groups_owner_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER community_groups_owner_guard_trg BEFORE UPDATE ON public.community_groups FOR EACH ROW EXECUTE FUNCTION public.community_groups_owner_guard();


--
-- Name: community_member_profiles community_member_profiles_verification_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER community_member_profiles_verification_guard_trg BEFORE INSERT OR UPDATE ON public.community_member_profiles FOR EACH ROW EXECUTE FUNCTION public.community_member_profiles_verification_guard();


--
-- Name: community_post_signoff_requests community_post_signoff_requests_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER community_post_signoff_requests_guard_trg BEFORE INSERT OR UPDATE ON public.community_post_signoff_requests FOR EACH ROW EXECUTE FUNCTION public.community_post_signoff_requests_guard();


--
-- Name: community_posts community_posts_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER community_posts_guard_trg BEFORE INSERT OR UPDATE ON public.community_posts FOR EACH ROW EXECUTE FUNCTION public.community_posts_guard();


--
-- Name: community_posts community_posts_reply_count_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER community_posts_reply_count_trigger AFTER INSERT OR DELETE ON public.community_posts FOR EACH ROW EXECUTE FUNCTION public.update_community_post_reply_count();


--
-- Name: derivation_edges derivation_edges_acyclic_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER derivation_edges_acyclic_trg BEFORE INSERT OR UPDATE ON public.derivation_edges FOR EACH ROW EXECUTE FUNCTION public.assert_acyclic();


--
-- Name: emission_factors emission_factors_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER emission_factors_append_only_trg BEFORE DELETE OR UPDATE ON public.emission_factors FOR EACH ROW EXECUTE FUNCTION public.emission_factors_append_only();


--
-- Name: intelligence_items enqueue_corpus_turn_request_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER enqueue_corpus_turn_request_trg AFTER INSERT OR UPDATE OF provenance_status, is_archived, operational_scenario_tags, compliance_object_tags, topic_tags ON public.intelligence_items FOR EACH ROW EXECUTE FUNCTION public.enqueue_corpus_turn_request();


--
-- Name: entity_aliases entity_aliases_insert_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_aliases_insert_only_trg BEFORE DELETE OR UPDATE ON public.entity_aliases FOR EACH ROW EXECUTE FUNCTION public.entity_aliases_refuse_change();


--
-- Name: entity_aliases entity_aliases_no_truncate_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_aliases_no_truncate_trg BEFORE TRUNCATE ON public.entity_aliases FOR EACH STATEMENT EXECUTE FUNCTION public.entity_aliases_refuse_change();


--
-- Name: entity_relations entity_relations_no_cycle_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER entity_relations_no_cycle_trg BEFORE INSERT OR UPDATE OF parent_entity_id, child_entity_id ON public.entity_relations FOR EACH ROW EXECUTE FUNCTION public.entity_relations_refuse_cycle();


--
-- Name: intelligence_items guard_data_audit_block_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_data_audit_block_trg BEFORE INSERT ON public.intelligence_items FOR EACH ROW EXECUTE FUNCTION public.guard_data_audit_block();


--
-- Name: system_state guard_judgement_drain_writer_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_judgement_drain_writer_trg BEFORE UPDATE ON public.system_state FOR EACH ROW EXECUTE FUNCTION public.guard_judgement_drain_writer();


--
-- Name: system_state guard_pause_flag_writer_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_pause_flag_writer_trg BEFORE UPDATE ON public.system_state FOR EACH ROW EXECUTE FUNCTION public.guard_pause_flag_writer();


--
-- Name: intelligence_items guard_provenance_flip_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER guard_provenance_flip_trg BEFORE UPDATE ON public.intelligence_items FOR EACH ROW WHEN (((old.provenance_status IS DISTINCT FROM new.provenance_status) AND (new.provenance_status = 'verified'::public.provenance_status))) EXECUTE FUNCTION public.guard_provenance_flip();


--
-- Name: intelligence_items intelligence_items_theme_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER intelligence_items_theme_guard_trg BEFORE INSERT OR UPDATE ON public.intelligence_items FOR EACH ROW WHEN ((new.theme IS NOT NULL)) EXECUTE FUNCTION public.intelligence_items_theme_guard();


--
-- Name: intelligence_items intelligence_items_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER intelligence_items_updated_at BEFORE UPDATE ON public.intelligence_items FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: intelligence_items intelligence_items_version_snapshot; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER intelligence_items_version_snapshot AFTER UPDATE ON public.intelligence_items FOR EACH ROW WHEN (((old.full_brief IS DISTINCT FROM new.full_brief) OR (old.severity IS DISTINCT FROM new.severity) OR (old.priority IS DISTINCT FROM new.priority) OR (old.urgency_tier IS DISTINCT FROM new.urgency_tier) OR (old.format_type IS DISTINCT FROM new.format_type) OR (old.topic_tags IS DISTINCT FROM new.topic_tags) OR (old.intersection_summary IS DISTINCT FROM new.intersection_summary))) EXECUTE FUNCTION public.trg_intelligence_items_version_snapshot();


--
-- Name: item_assignments item_assignments_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER item_assignments_guard_trg BEFORE UPDATE ON public.item_assignments FOR EACH ROW EXECUTE FUNCTION public.item_assignments_guard();


--
-- Name: item_corrections item_corrections_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER item_corrections_append_only_trg BEFORE DELETE OR UPDATE ON public.item_corrections FOR EACH ROW EXECUTE FUNCTION public.item_corrections_append_only();


--
-- Name: item_corrections item_corrections_before_insert_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER item_corrections_before_insert_trg BEFORE INSERT ON public.item_corrections FOR EACH ROW EXECUTE FUNCTION public.item_corrections_before_insert();


--
-- Name: item_cross_references item_corrections_block_tombstoned_edge_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER item_corrections_block_tombstoned_edge_trg BEFORE INSERT ON public.item_cross_references FOR EACH ROW EXECUTE FUNCTION public.item_corrections_block_tombstoned_edge();


--
-- Name: item_notes item_notes_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER item_notes_guard_trg BEFORE UPDATE ON public.item_notes FOR EACH ROW EXECUTE FUNCTION public.item_notes_guard();


--
-- Name: notification_preferences notification_preferences_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notification_preferences_updated_at BEFORE UPDATE ON public.notification_preferences FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: obligation_objects obligation_objects_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER obligation_objects_guard_trg BEFORE INSERT OR UPDATE ON public.obligation_objects FOR EACH ROW EXECUTE FUNCTION public.obligation_objects_guard();


--
-- Name: org_memberships org_membership_role_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER org_membership_role_guard_trg BEFORE INSERT OR DELETE OR UPDATE ON public.org_memberships FOR EACH ROW EXECUTE FUNCTION public.org_membership_role_guard();


--
-- Name: org_memberships org_memberships_ban_guard_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER org_memberships_ban_guard_trigger BEFORE INSERT OR UPDATE OF user_id, org_id ON public.org_memberships FOR EACH ROW EXECUTE FUNCTION public.org_memberships_ban_guard();


--
-- Name: organizations organizations_plan_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER organizations_plan_guard_trg BEFORE INSERT OR UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.organizations_plan_guard();


--
-- Name: organizations organizations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: portfolio_members portfolio_members_cap_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portfolio_members_cap_trg BEFORE INSERT ON public.portfolio_members FOR EACH ROW EXECUTE FUNCTION public.portfolio_members_cap();


--
-- Name: portfolios portfolios_org_cap_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER portfolios_org_cap_trg BEFORE INSERT ON public.portfolios FOR EACH ROW EXECUTE FUNCTION public.portfolios_org_cap();


--
-- Name: profiles profiles_privilege_guard_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_privilege_guard_trg BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.profiles_privilege_guard();


--
-- Name: derived_values propagation_outbox_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.derived_values FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('value_id');


--
-- Name: emission_factors propagation_outbox_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.emission_factors FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('factor_id', 'corridor_id');


--
-- Name: entity_aliases propagation_outbox_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.entity_aliases FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('entity_id');


--
-- Name: entity_relations propagation_outbox_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.entity_relations FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('parent_entity_id', 'child_entity_id');


--
-- Name: estimated_values propagation_outbox_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.estimated_values FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('estimate_id');


--
-- Name: grid_connection_queues propagation_outbox_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.grid_connection_queues FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('queue_id', 'jurisdiction_id');


--
-- Name: market_series propagation_outbox_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.market_series FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('id', 'entity_id');


--
-- Name: obligation_objects propagation_outbox_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.obligation_objects FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('obligation_id', 'instrument_entity_id');


--
-- Name: oem_tech_roadmaps propagation_outbox_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.oem_tech_roadmaps FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('roadmap_id', 'manufacturer_id');


--
-- Name: regional_data_facts propagation_outbox_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.regional_data_facts FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_events_for_region('id', 'region_id');


--
-- Name: statutory_computations propagation_outbox_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER propagation_outbox_trg AFTER INSERT OR DELETE OR UPDATE ON public.statutory_computations FOR EACH ROW EXECUTE FUNCTION public.emit_propagation_event('computation_id');


--
-- Name: regional_data_facts rdf_sync_coverage; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER rdf_sync_coverage AFTER INSERT OR DELETE OR UPDATE ON public.regional_data_facts FOR EACH ROW EXECUTE FUNCTION public.region_dimension_coverage_sync_fact_count();


--
-- Name: section_claim_provenance set_provenance_status_claims_del_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_provenance_status_claims_del_trg AFTER DELETE ON public.section_claim_provenance FOR EACH ROW EXECUTE FUNCTION public.set_provenance_status();


--
-- Name: section_claim_provenance set_provenance_status_claims_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_provenance_status_claims_trg AFTER INSERT OR UPDATE ON public.section_claim_provenance FOR EACH ROW EXECUTE FUNCTION public.set_provenance_status();


--
-- Name: intelligence_item_sections set_provenance_status_sections_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_provenance_status_sections_trg AFTER INSERT OR UPDATE ON public.intelligence_item_sections FOR EACH ROW EXECUTE FUNCTION public.set_provenance_status();


--
-- Name: intelligence_items set_provenance_status_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_provenance_status_trg AFTER INSERT OR UPDATE ON public.intelligence_items FOR EACH ROW WHEN ((pg_trigger_depth() = 0)) EXECUTE FUNCTION public.set_provenance_status();


--
-- Name: sources set_source_label_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_source_label_trg BEFORE INSERT OR UPDATE ON public.sources FOR EACH ROW EXECUTE FUNCTION public.set_source_label();


--
-- Name: source_reliability_ledger source_reliability_ledger_append_only_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER source_reliability_ledger_append_only_trg BEFORE DELETE OR UPDATE ON public.source_reliability_ledger FOR EACH ROW EXECUTE FUNCTION public.source_reliability_ledger_append_only();


--
-- Name: sources sources_recompute_accuracy; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sources_recompute_accuracy BEFORE UPDATE OF confirmation_count, conflict_count, successful_checks, total_checks ON public.sources FOR EACH ROW EXECUTE FUNCTION public.recompute_source_accuracy();


--
-- Name: sources sources_sync_tier_columns; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sources_sync_tier_columns BEFORE INSERT OR UPDATE ON public.sources FOR EACH ROW EXECUTE FUNCTION public.sync_sources_tier_columns();


--
-- Name: sources sources_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER sources_updated_at BEFORE UPDATE ON public.sources FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: statutory_computations statutory_purity_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER statutory_purity_trg BEFORE INSERT OR UPDATE ON public.statutory_computations FOR EACH ROW EXECUTE FUNCTION public.assert_statutory_purity();


--
-- Name: intelligence_items trg_guard_source_archive; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_guard_source_archive BEFORE INSERT OR UPDATE OF is_archived, archive_reason ON public.intelligence_items FOR EACH ROW EXECUTE FUNCTION public._guard_source_archive();


--
-- Name: intelligence_items trg_intelligence_items_integrity_flag; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_intelligence_items_integrity_flag BEFORE INSERT OR UPDATE OF full_brief ON public.intelligence_items FOR EACH ROW EXECUTE FUNCTION public.recompute_agent_integrity_flag();


--
-- Name: intelligence_items trg_intelligence_items_normalize_jurisdictions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_intelligence_items_normalize_jurisdictions BEFORE INSERT OR UPDATE OF jurisdictions, jurisdiction_iso ON public.intelligence_items FOR EACH ROW EXECUTE FUNCTION public._intelligence_items_normalize_jurisdictions();


--
-- Name: intelligence_items trg_set_canonical_instrument_key; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_set_canonical_instrument_key BEFORE INSERT OR UPDATE ON public.intelligence_items FOR EACH ROW EXECUTE FUNCTION public.set_canonical_instrument_key();


--
-- Name: sources trg_sources_enqueue_first_fetch_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sources_enqueue_first_fetch_insert AFTER INSERT ON public.sources FOR EACH ROW EXECUTE FUNCTION public.enqueue_pending_first_fetch();


--
-- Name: sources trg_sources_enqueue_first_fetch_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sources_enqueue_first_fetch_update AFTER UPDATE OF auto_run_enabled ON public.sources FOR EACH ROW EXECUTE FUNCTION public.enqueue_pending_first_fetch();


--
-- Name: workspace_item_overrides workspace_overrides_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspace_overrides_updated_at BEFORE UPDATE ON public.workspace_item_overrides FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: workspace_settings workspace_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspace_settings_updated_at BEFORE UPDATE ON public.workspace_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: section_claim_provenance zz_item_corrections_apply_claims_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_item_corrections_apply_claims_trg BEFORE INSERT OR UPDATE ON public.section_claim_provenance FOR EACH ROW EXECUTE FUNCTION public.item_corrections_apply_claims();


--
-- Name: intelligence_items zz_item_corrections_apply_items_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_item_corrections_apply_items_trg BEFORE INSERT OR UPDATE ON public.intelligence_items FOR EACH ROW EXECUTE FUNCTION public.item_corrections_apply_items();


--
-- Name: intelligence_item_sections zz_item_corrections_apply_sections_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER zz_item_corrections_apply_sections_trg BEFORE INSERT OR UPDATE ON public.intelligence_item_sections FOR EACH ROW EXECUTE FUNCTION public.item_corrections_apply_sections();


--
-- Name: admin_action_cooldowns admin_action_cooldowns_triggered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_action_cooldowns
    ADD CONSTRAINT admin_action_cooldowns_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: agent_run_searches agent_run_searches_intelligence_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_run_searches
    ADD CONSTRAINT agent_run_searches_intelligence_item_id_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: agent_runs agent_runs_intelligence_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_intelligence_item_id_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE SET NULL;


--
-- Name: agent_runs agent_runs_intelligence_item_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_intelligence_item_version_id_fkey FOREIGN KEY (intelligence_item_version_id) REFERENCES public.intelligence_item_versions(id) ON DELETE SET NULL;


--
-- Name: agent_runs agent_runs_raw_fetch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_raw_fetch_id_fkey FOREIGN KEY (raw_fetch_id) REFERENCES public.raw_fetches(id) ON DELETE SET NULL;


--
-- Name: agent_runs agent_runs_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_runs
    ADD CONSTRAINT agent_runs_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE SET NULL;


--
-- Name: assumption_register assumption_register_source_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assumption_register
    ADD CONSTRAINT assumption_register_source_key_fkey FOREIGN KEY (source_key) REFERENCES public.data_sources(source_key);


--
-- Name: assumption_register assumption_register_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assumption_register
    ADD CONSTRAINT assumption_register_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.assumption_register(id);


--
-- Name: auxiliary_energy_profiles auxiliary_energy_profiles_node_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auxiliary_energy_profiles
    ADD CONSTRAINT auxiliary_energy_profiles_node_id_fkey FOREIGN KEY (node_id) REFERENCES public.entities(entity_id);


--
-- Name: auxiliary_energy_profiles auxiliary_energy_profiles_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auxiliary_energy_profiles
    ADD CONSTRAINT auxiliary_energy_profiles_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: bulk_imports bulk_imports_imported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_imports
    ADD CONSTRAINT bulk_imports_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: canonical_source_candidates canonical_source_candidates_current_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_source_candidates
    ADD CONSTRAINT canonical_source_candidates_current_source_id_fkey FOREIGN KEY (current_source_id) REFERENCES public.sources(id) ON DELETE SET NULL;


--
-- Name: canonical_source_candidates canonical_source_candidates_intelligence_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_source_candidates
    ADD CONSTRAINT canonical_source_candidates_intelligence_item_id_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: canonical_source_candidates canonical_source_candidates_promoted_to_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_source_candidates
    ADD CONSTRAINT canonical_source_candidates_promoted_to_source_id_fkey FOREIGN KEY (promoted_to_source_id) REFERENCES public.sources(id) ON DELETE SET NULL;


--
-- Name: census_worklist census_worklist_resolved_into_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.census_worklist
    ADD CONSTRAINT census_worklist_resolved_into_id_fkey FOREIGN KEY (resolved_into_id) REFERENCES public.census_worklist(id) ON DELETE SET NULL;


--
-- Name: census_worklist census_worklist_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.census_worklist
    ADD CONSTRAINT census_worklist_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE RESTRICT;


--
-- Name: community_group_invitations community_group_invitations_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_group_invitations
    ADD CONSTRAINT community_group_invitations_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.community_groups(id) ON DELETE CASCADE;


--
-- Name: community_group_invitations community_group_invitations_invitee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_group_invitations
    ADD CONSTRAINT community_group_invitations_invitee_user_id_fkey FOREIGN KEY (invitee_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: community_group_invitations community_group_invitations_inviter_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_group_invitations
    ADD CONSTRAINT community_group_invitations_inviter_user_id_fkey FOREIGN KEY (inviter_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: community_group_members community_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_group_members
    ADD CONSTRAINT community_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.community_groups(id) ON DELETE CASCADE;


--
-- Name: community_group_members community_group_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_group_members
    ADD CONSTRAINT community_group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: community_groups community_groups_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_groups
    ADD CONSTRAINT community_groups_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: community_member_profiles community_member_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_member_profiles
    ADD CONSTRAINT community_member_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: community_post_signoff_requests community_post_signoff_requests_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_post_signoff_requests
    ADD CONSTRAINT community_post_signoff_requests_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.community_posts(id) ON DELETE CASCADE;


--
-- Name: community_post_signoff_requests community_post_signoff_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_post_signoff_requests
    ADD CONSTRAINT community_post_signoff_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: community_post_signoff_requests community_post_signoff_requests_verifier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_post_signoff_requests
    ADD CONSTRAINT community_post_signoff_requests_verifier_id_fkey FOREIGN KEY (verifier_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: community_posts community_posts_author_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_posts
    ADD CONSTRAINT community_posts_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: community_posts community_posts_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_posts
    ADD CONSTRAINT community_posts_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.community_groups(id) ON DELETE CASCADE;


--
-- Name: community_posts community_posts_parent_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_posts
    ADD CONSTRAINT community_posts_parent_post_id_fkey FOREIGN KEY (parent_post_id) REFERENCES public.community_posts(id) ON DELETE CASCADE;


--
-- Name: community_posts community_posts_promoted_from_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_posts
    ADD CONSTRAINT community_posts_promoted_from_post_id_fkey FOREIGN KEY (promoted_from_post_id) REFERENCES public.community_posts(id) ON DELETE SET NULL;


--
-- Name: community_posts community_posts_signed_off_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_posts
    ADD CONSTRAINT community_posts_signed_off_by_fkey FOREIGN KEY (signed_off_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: community_thread_entities community_thread_entities_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_thread_entities
    ADD CONSTRAINT community_thread_entities_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(entity_id) ON DELETE CASCADE;


--
-- Name: community_thread_entities community_thread_entities_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_thread_entities
    ADD CONSTRAINT community_thread_entities_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.community_posts(id) ON DELETE CASCADE;


--
-- Name: community_topic_groups community_topic_groups_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_topic_groups
    ADD CONSTRAINT community_topic_groups_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.community_groups(id) ON DELETE CASCADE;


--
-- Name: community_topic_groups community_topic_groups_topic_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_topic_groups
    ADD CONSTRAINT community_topic_groups_topic_id_fkey FOREIGN KEY (topic_id) REFERENCES public.community_topics(id) ON DELETE CASCADE;


--
-- Name: community_topics community_topics_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_topics
    ADD CONSTRAINT community_topics_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: corpus_turn_requests corpus_turn_requests_intelligence_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.corpus_turn_requests
    ADD CONSTRAINT corpus_turn_requests_intelligence_item_id_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: derived_values derived_values_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.derived_values
    ADD CONSTRAINT derived_values_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(entity_id);


--
-- Name: derived_values derived_values_invalidated_by_event_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.derived_values
    ADD CONSTRAINT derived_values_invalidated_by_event_fkey FOREIGN KEY (invalidated_by_event) REFERENCES public.propagation_events(event_id);


--
-- Name: derived_values derived_values_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.derived_values
    ADD CONSTRAINT derived_values_supersedes_fkey FOREIGN KEY (supersedes) REFERENCES public.derived_values(value_id);


--
-- Name: emission_factors emission_factors_source_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emission_factors
    ADD CONSTRAINT emission_factors_source_key_fkey FOREIGN KEY (source_key) REFERENCES public.data_sources(source_key);


--
-- Name: emission_factors emission_factors_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emission_factors
    ADD CONSTRAINT emission_factors_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.emission_factors(factor_id);


--
-- Name: entities entities_merged_into_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.entities(entity_id);


--
-- Name: entity_aliases entity_aliases_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_aliases
    ADD CONSTRAINT entity_aliases_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(entity_id);


--
-- Name: entity_aliases entity_aliases_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_aliases
    ADD CONSTRAINT entity_aliases_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id);


--
-- Name: entity_identifiers entity_identifiers_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_identifiers
    ADD CONSTRAINT entity_identifiers_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(entity_id);


--
-- Name: entity_refs entity_refs_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_refs
    ADD CONSTRAINT entity_refs_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(entity_id);


--
-- Name: entity_relations entity_relations_child_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relations
    ADD CONSTRAINT entity_relations_child_entity_id_fkey FOREIGN KEY (child_entity_id) REFERENCES public.entities(entity_id);


--
-- Name: entity_relations entity_relations_parent_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relations
    ADD CONSTRAINT entity_relations_parent_entity_id_fkey FOREIGN KEY (parent_entity_id) REFERENCES public.entities(entity_id);


--
-- Name: entity_relations entity_relations_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relations
    ADD CONSTRAINT entity_relations_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id);


--
-- Name: entity_scope entity_scope_scope_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_scope
    ADD CONSTRAINT entity_scope_scope_id_fkey FOREIGN KEY (scope_id) REFERENCES public.entities(entity_id);


--
-- Name: entity_scope entity_scope_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_scope
    ADD CONSTRAINT entity_scope_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.entities(entity_id);


--
-- Name: estimated_values estimated_values_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_values
    ADD CONSTRAINT estimated_values_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(entity_id);


--
-- Name: grid_connection_queues grid_connection_queues_jurisdiction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_connection_queues
    ADD CONSTRAINT grid_connection_queues_jurisdiction_id_fkey FOREIGN KEY (jurisdiction_id) REFERENCES public.entities(entity_id);


--
-- Name: grid_connection_queues grid_connection_queues_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.grid_connection_queues
    ADD CONSTRAINT grid_connection_queues_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id);


--
-- Name: holdings_quality holdings_quality_capture_ref_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.holdings_quality
    ADD CONSTRAINT holdings_quality_capture_ref_fkey FOREIGN KEY (capture_ref) REFERENCES public.raw_fetches(id) ON DELETE SET NULL;


--
-- Name: holdings_quality holdings_quality_intelligence_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.holdings_quality
    ADD CONSTRAINT holdings_quality_intelligence_item_id_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: holdings_quality holdings_quality_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.holdings_quality
    ADD CONSTRAINT holdings_quality_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE SET NULL;


--
-- Name: indexation_clauses indexation_clauses_corridor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.indexation_clauses
    ADD CONSTRAINT indexation_clauses_corridor_id_fkey FOREIGN KEY (corridor_id) REFERENCES public.entities(entity_id);


--
-- Name: indexation_clauses indexation_clauses_index_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.indexation_clauses
    ADD CONSTRAINT indexation_clauses_index_id_fkey FOREIGN KEY (index_id) REFERENCES public.entities(entity_id);


--
-- Name: indexation_clauses indexation_clauses_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.indexation_clauses
    ADD CONSTRAINT indexation_clauses_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id);


--
-- Name: inference_records inference_records_invalidated_by_event_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inference_records
    ADD CONSTRAINT inference_records_invalidated_by_event_fkey FOREIGN KEY (invalidated_by_event) REFERENCES public.propagation_events(event_id);


--
-- Name: inference_records inference_records_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inference_records
    ADD CONSTRAINT inference_records_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.entities(entity_id);


--
-- Name: inference_records inference_records_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inference_records
    ADD CONSTRAINT inference_records_supersedes_fkey FOREIGN KEY (supersedes) REFERENCES public.inference_records(inference_id);


--
-- Name: ingest_rejections ingest_rejections_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_rejections
    ADD CONSTRAINT ingest_rejections_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE SET NULL;


--
-- Name: ingest_rejections ingest_rejections_triaged_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ingest_rejections
    ADD CONSTRAINT ingest_rejections_triaged_by_fkey FOREIGN KEY (triaged_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: intelligence_changes intelligence_changes_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_changes
    ADD CONSTRAINT intelligence_changes_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: intelligence_item_citations intelligence_item_citations_intelligence_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_item_citations
    ADD CONSTRAINT intelligence_item_citations_intelligence_item_id_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: intelligence_item_citations intelligence_item_citations_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_item_citations
    ADD CONSTRAINT intelligence_item_citations_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE CASCADE;


--
-- Name: intelligence_item_sections intelligence_item_sections_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_item_sections
    ADD CONSTRAINT intelligence_item_sections_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: intelligence_item_versions intelligence_item_versions_intelligence_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_item_versions
    ADD CONSTRAINT intelligence_item_versions_intelligence_item_id_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: intelligence_item_versions intelligence_item_versions_previous_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_item_versions
    ADD CONSTRAINT intelligence_item_versions_previous_version_id_fkey FOREIGN KEY (previous_version_id) REFERENCES public.intelligence_item_versions(id) ON DELETE SET NULL;


--
-- Name: intelligence_items intelligence_items_agent_integrity_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_items
    ADD CONSTRAINT intelligence_items_agent_integrity_resolved_by_fkey FOREIGN KEY (agent_integrity_resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: intelligence_items intelligence_items_instrument_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_items
    ADD CONSTRAINT intelligence_items_instrument_entity_id_fkey FOREIGN KEY (instrument_entity_id) REFERENCES public.entities(entity_id);


--
-- Name: intelligence_items intelligence_items_replaced_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_items
    ADD CONSTRAINT intelligence_items_replaced_by_fkey FOREIGN KEY (replaced_by) REFERENCES public.intelligence_items(id);


--
-- Name: intelligence_items intelligence_items_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_items
    ADD CONSTRAINT intelligence_items_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE SET NULL;


--
-- Name: intelligence_summaries intelligence_summaries_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intelligence_summaries
    ADD CONSTRAINT intelligence_summaries_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: item_assignments item_assignments_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_assignments
    ADD CONSTRAINT item_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: item_assignments item_assignments_assignee_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_assignments
    ADD CONSTRAINT item_assignments_assignee_user_id_fkey FOREIGN KEY (assignee_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: item_assignments item_assignments_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_assignments
    ADD CONSTRAINT item_assignments_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: item_assignments item_assignments_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_assignments
    ADD CONSTRAINT item_assignments_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: item_changelog item_changelog_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_changelog
    ADD CONSTRAINT item_changelog_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: item_correction_evidence item_correction_evidence_correction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_correction_evidence
    ADD CONSTRAINT item_correction_evidence_correction_id_fkey FOREIGN KEY (correction_id) REFERENCES public.item_corrections(id);


--
-- Name: item_cross_references item_cross_references_source_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_cross_references
    ADD CONSTRAINT item_cross_references_source_item_id_fkey FOREIGN KEY (source_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: item_cross_references item_cross_references_target_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_cross_references
    ADD CONSTRAINT item_cross_references_target_item_id_fkey FOREIGN KEY (target_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: item_disputes item_disputes_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_disputes
    ADD CONSTRAINT item_disputes_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: item_forward_events item_forward_events_intelligence_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_forward_events
    ADD CONSTRAINT item_forward_events_intelligence_item_id_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: item_forward_events item_forward_events_source_claim_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_forward_events
    ADD CONSTRAINT item_forward_events_source_claim_id_fkey FOREIGN KEY (source_claim_id) REFERENCES public.section_claim_provenance(id) ON DELETE SET NULL;


--
-- Name: item_forward_events item_forward_events_source_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_forward_events
    ADD CONSTRAINT item_forward_events_source_section_id_fkey FOREIGN KEY (source_section_id) REFERENCES public.intelligence_item_sections(id) ON DELETE CASCADE;


--
-- Name: item_gate_a_state item_gate_a_state_intelligence_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_gate_a_state
    ADD CONSTRAINT item_gate_a_state_intelligence_item_id_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: item_notes item_notes_author_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_notes
    ADD CONSTRAINT item_notes_author_user_id_fkey FOREIGN KEY (author_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: item_notes item_notes_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_notes
    ADD CONSTRAINT item_notes_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: item_notes item_notes_legacy_override_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_notes
    ADD CONSTRAINT item_notes_legacy_override_id_fkey FOREIGN KEY (legacy_override_id) REFERENCES public.workspace_item_overrides(id) ON DELETE SET NULL;


--
-- Name: item_notes item_notes_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_notes
    ADD CONSTRAINT item_notes_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: item_supersessions item_supersessions_new_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_supersessions
    ADD CONSTRAINT item_supersessions_new_item_id_fkey FOREIGN KEY (new_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: item_supersessions item_supersessions_old_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_supersessions
    ADD CONSTRAINT item_supersessions_old_item_id_fkey FOREIGN KEY (old_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: item_timelines item_timelines_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_timelines
    ADD CONSTRAINT item_timelines_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: item_workspace_tags item_workspace_tags_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_workspace_tags
    ADD CONSTRAINT item_workspace_tags_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: item_workspace_tags item_workspace_tags_intelligence_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_workspace_tags
    ADD CONSTRAINT item_workspace_tags_intelligence_item_id_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: item_workspace_tags item_workspace_tags_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_workspace_tags
    ADD CONSTRAINT item_workspace_tags_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: item_workspace_tags item_workspace_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.item_workspace_tags
    ADD CONSTRAINT item_workspace_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.workspace_tags(id) ON DELETE CASCADE;


--
-- Name: market_series market_series_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_series
    ADD CONSTRAINT market_series_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(entity_id);


--
-- Name: market_series market_series_source_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_series
    ADD CONSTRAINT market_series_source_key_fkey FOREIGN KEY (source_key) REFERENCES public.data_sources(source_key);


--
-- Name: moderation_reports moderation_reports_reporter_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moderation_reports
    ADD CONSTRAINT moderation_reports_reporter_user_id_fkey FOREIGN KEY (reporter_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: moderation_reports moderation_reports_resolved_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.moderation_reports
    ADD CONSTRAINT moderation_reports_resolved_by_user_id_fkey FOREIGN KEY (resolved_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: monitoring_queue monitoring_queue_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_queue
    ADD CONSTRAINT monitoring_queue_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE SET NULL;


--
-- Name: monitoring_queue monitoring_queue_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.monitoring_queue
    ADD CONSTRAINT monitoring_queue_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE CASCADE;


--
-- Name: notification_preferences notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: obligation_objects obligation_objects_capture_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligation_objects
    ADD CONSTRAINT obligation_objects_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.agent_run_searches(id);


--
-- Name: obligation_objects obligation_objects_instrument_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligation_objects
    ADD CONSTRAINT obligation_objects_instrument_entity_id_fkey FOREIGN KEY (instrument_entity_id) REFERENCES public.entities(entity_id);


--
-- Name: obligation_objects obligation_objects_instrument_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligation_objects
    ADD CONSTRAINT obligation_objects_instrument_item_id_fkey FOREIGN KEY (instrument_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: obligation_objects obligation_objects_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligation_objects
    ADD CONSTRAINT obligation_objects_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.entities(entity_id);


--
-- Name: obligation_objects obligation_objects_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligation_objects
    ADD CONSTRAINT obligation_objects_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id);


--
-- Name: obligation_objects obligation_objects_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligation_objects
    ADD CONSTRAINT obligation_objects_supersedes_fkey FOREIGN KEY (supersedes) REFERENCES public.obligation_objects(obligation_id);


--
-- Name: obligations obligations_forward_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligations
    ADD CONSTRAINT obligations_forward_event_id_fkey FOREIGN KEY (forward_event_id) REFERENCES public.item_forward_events(id) ON DELETE CASCADE;


--
-- Name: obligations obligations_intelligence_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligations
    ADD CONSTRAINT obligations_intelligence_item_id_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: obligations obligations_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.obligations
    ADD CONSTRAINT obligations_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.obligation_objects(obligation_id);


--
-- Name: oem_tech_roadmaps oem_tech_roadmaps_manufacturer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oem_tech_roadmaps
    ADD CONSTRAINT oem_tech_roadmaps_manufacturer_id_fkey FOREIGN KEY (manufacturer_id) REFERENCES public.entities(entity_id);


--
-- Name: oem_tech_roadmaps oem_tech_roadmaps_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oem_tech_roadmaps
    ADD CONSTRAINT oem_tech_roadmaps_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id);


--
-- Name: org_invitations org_invitations_accepted_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_accepted_by_user_id_fkey FOREIGN KEY (accepted_by_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: org_invitations org_invitations_invited_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_invited_by_user_id_fkey FOREIGN KEY (invited_by_user_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;


--
-- Name: org_invitations org_invitations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_invitations org_invitations_revoked_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_invitations
    ADD CONSTRAINT org_invitations_revoked_by_user_id_fkey FOREIGN KEY (revoked_by_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: org_member_bans org_member_bans_banned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_member_bans
    ADD CONSTRAINT org_member_bans_banned_by_fkey FOREIGN KEY (banned_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: org_member_bans org_member_bans_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_member_bans
    ADD CONSTRAINT org_member_bans_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_member_bans org_member_bans_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_member_bans
    ADD CONSTRAINT org_member_bans_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: org_memberships org_memberships_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_memberships
    ADD CONSTRAINT org_memberships_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: org_memberships org_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_memberships
    ADD CONSTRAINT org_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: org_watchlist org_watchlist_added_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_watchlist
    ADD CONSTRAINT org_watchlist_added_by_user_id_fkey FOREIGN KEY (added_by_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: org_watchlist org_watchlist_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.org_watchlist
    ADD CONSTRAINT org_watchlist_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: pending_first_fetch pending_first_fetch_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_first_fetch
    ADD CONSTRAINT pending_first_fetch_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE CASCADE;


--
-- Name: pending_jurisdiction_review pending_jurisdiction_review_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_jurisdiction_review
    ADD CONSTRAINT pending_jurisdiction_review_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: pending_jurisdiction_review pjr_intelligence_item_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_jurisdiction_review
    ADD CONSTRAINT pjr_intelligence_item_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;


--
-- Name: portal_link_candidates portal_link_candidates_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_link_candidates
    ADD CONSTRAINT portal_link_candidates_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE SET NULL;


--
-- Name: portal_link_candidates portal_link_candidates_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portal_link_candidates
    ADD CONSTRAINT portal_link_candidates_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE CASCADE;


--
-- Name: portfolio_members portfolio_members_added_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_members
    ADD CONSTRAINT portfolio_members_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: portfolio_members portfolio_members_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_members
    ADD CONSTRAINT portfolio_members_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(entity_id);


--
-- Name: portfolio_members portfolio_members_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_members
    ADD CONSTRAINT portfolio_members_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: portfolio_members portfolio_members_portfolio_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolio_members
    ADD CONSTRAINT portfolio_members_portfolio_fk FOREIGN KEY (portfolio_id, org_id) REFERENCES public.portfolios(id, org_id) ON DELETE CASCADE;


--
-- Name: portfolios portfolios_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolios
    ADD CONSTRAINT portfolios_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: portfolios portfolios_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.portfolios
    ADD CONSTRAINT portfolios_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_auth_users_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_auth_users_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: CONSTRAINT profiles_id_auth_users_fkey ON profiles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT profiles_id_auth_users_fkey ON public.profiles IS 'profiles.id must be an auth.users id (audit D3, 2026-08-02). The auth.uid() = user_id RLS policies on user_item_state and siblings are only correct while the two id spaces coincide; this makes that structural.';


--
-- Name: profiles profiles_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE SET NULL;


--
-- Name: propagation_events propagation_events_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.propagation_events
    ADD CONSTRAINT propagation_events_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(entity_id);


--
-- Name: provisional_sources provisional_sources_cited_by_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisional_sources
    ADD CONSTRAINT provisional_sources_cited_by_source_id_fkey FOREIGN KEY (cited_by_source_id) REFERENCES public.sources(id);


--
-- Name: provisional_sources provisional_sources_promoted_to_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provisional_sources
    ADD CONSTRAINT provisional_sources_promoted_to_source_id_fkey FOREIGN KEY (promoted_to_source_id) REFERENCES public.sources(id);


--
-- Name: published_price_statistics published_price_statistics_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.published_price_statistics
    ADD CONSTRAINT published_price_statistics_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: raw_fetches raw_fetches_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.raw_fetches
    ADD CONSTRAINT raw_fetches_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE CASCADE;


--
-- Name: region_dimension_coverage region_dimension_coverage_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.region_dimension_coverage
    ADD CONSTRAINT region_dimension_coverage_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.regions(id) ON DELETE CASCADE;


--
-- Name: regional_data_facts regional_data_facts_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regional_data_facts
    ADD CONSTRAINT regional_data_facts_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.regions(id) ON DELETE CASCADE;


--
-- Name: regional_data_facts regional_data_facts_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regional_data_facts
    ADD CONSTRAINT regional_data_facts_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE SET NULL;


--
-- Name: regional_data_facts regional_data_facts_source_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.regional_data_facts
    ADD CONSTRAINT regional_data_facts_source_key_fkey FOREIGN KEY (source_key) REFERENCES public.data_sources(source_key);


--
-- Name: reroute_events reroute_events_baseline_corridor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reroute_events
    ADD CONSTRAINT reroute_events_baseline_corridor_id_fkey FOREIGN KEY (baseline_corridor_id) REFERENCES public.entities(entity_id);


--
-- Name: reroute_events reroute_events_reroute_corridor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reroute_events
    ADD CONSTRAINT reroute_events_reroute_corridor_id_fkey FOREIGN KEY (reroute_corridor_id) REFERENCES public.entities(entity_id);


--
-- Name: research_assessments research_assessments_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_assessments
    ADD CONSTRAINT research_assessments_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(entity_id);


--
-- Name: research_assessments research_assessments_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_assessments
    ADD CONSTRAINT research_assessments_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: research_assessments research_assessments_supersedes_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_assessments
    ADD CONSTRAINT research_assessments_supersedes_fkey FOREIGN KEY (supersedes) REFERENCES public.research_assessments(id);


--
-- Name: section_claim_provenance section_claim_provenance_basis_claim_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section_claim_provenance
    ADD CONSTRAINT section_claim_provenance_basis_claim_id_fkey FOREIGN KEY (basis_claim_id) REFERENCES public.section_claim_provenance(id) ON DELETE SET NULL;


--
-- Name: section_claim_provenance section_claim_provenance_intelligence_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section_claim_provenance
    ADD CONSTRAINT section_claim_provenance_intelligence_item_id_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: section_claim_provenance section_claim_provenance_search_result_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section_claim_provenance
    ADD CONSTRAINT section_claim_provenance_search_result_id_fkey FOREIGN KEY (search_result_id) REFERENCES public.agent_run_searches(id) ON DELETE SET NULL;


--
-- Name: section_claim_provenance section_claim_provenance_section_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section_claim_provenance
    ADD CONSTRAINT section_claim_provenance_section_row_id_fkey FOREIGN KEY (section_row_id) REFERENCES public.intelligence_item_sections(id) ON DELETE CASCADE;


--
-- Name: section_claim_provenance section_claim_provenance_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.section_claim_provenance
    ADD CONSTRAINT section_claim_provenance_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE SET NULL;


--
-- Name: signposts signposts_assessment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signposts
    ADD CONSTRAINT signposts_assessment_id_fkey FOREIGN KEY (assessment_id) REFERENCES public.research_assessments(id);


--
-- Name: signposts signposts_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signposts
    ADD CONSTRAINT signposts_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(entity_id);


--
-- Name: signposts signposts_inference_record_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signposts
    ADD CONSTRAINT signposts_inference_record_id_fkey FOREIGN KEY (inference_record_id) REFERENCES public.inference_records(inference_id);


--
-- Name: signposts signposts_watches_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signposts
    ADD CONSTRAINT signposts_watches_fkey FOREIGN KEY (watches) REFERENCES public.entities(entity_id);


--
-- Name: source_bias_tags source_bias_tags_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_bias_tags
    ADD CONSTRAINT source_bias_tags_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE CASCADE;


--
-- Name: source_citations source_citations_cited_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_citations
    ADD CONSTRAINT source_citations_cited_source_id_fkey FOREIGN KEY (cited_source_id) REFERENCES public.sources(id) ON DELETE CASCADE;


--
-- Name: source_citations source_citations_citing_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_citations
    ADD CONSTRAINT source_citations_citing_source_id_fkey FOREIGN KEY (citing_source_id) REFERENCES public.sources(id) ON DELETE CASCADE;


--
-- Name: source_reliability_ledger source_reliability_ledger_assessment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_reliability_ledger
    ADD CONSTRAINT source_reliability_ledger_assessment_id_fkey FOREIGN KEY (assessment_id) REFERENCES public.research_assessments(id);


--
-- Name: source_reliability_ledger source_reliability_ledger_signpost_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_reliability_ledger
    ADD CONSTRAINT source_reliability_ledger_signpost_entity_id_fkey FOREIGN KEY (signpost_entity_id) REFERENCES public.signposts(entity_id);


--
-- Name: source_reliability_ledger source_reliability_ledger_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_reliability_ledger
    ADD CONSTRAINT source_reliability_ledger_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id);


--
-- Name: source_tier_opinions source_tier_opinions_dismissed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_tier_opinions
    ADD CONSTRAINT source_tier_opinions_dismissed_by_fkey FOREIGN KEY (dismissed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: source_tier_opinions source_tier_opinions_intelligence_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_tier_opinions
    ADD CONSTRAINT source_tier_opinions_intelligence_item_id_fkey FOREIGN KEY (intelligence_item_id) REFERENCES public.intelligence_items(id) ON DELETE SET NULL;


--
-- Name: source_tier_opinions source_tier_opinions_opining_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_tier_opinions
    ADD CONSTRAINT source_tier_opinions_opining_source_id_fkey FOREIGN KEY (opining_source_id) REFERENCES public.sources(id) ON DELETE SET NULL;


--
-- Name: source_tier_opinions source_tier_opinions_target_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_tier_opinions
    ADD CONSTRAINT source_tier_opinions_target_source_id_fkey FOREIGN KEY (target_source_id) REFERENCES public.sources(id) ON DELETE CASCADE;


--
-- Name: source_trust_events source_trust_events_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_trust_events
    ADD CONSTRAINT source_trust_events_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE CASCADE;


--
-- Name: source_verifications source_verifications_resulting_provisional_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_verifications
    ADD CONSTRAINT source_verifications_resulting_provisional_id_fkey FOREIGN KEY (resulting_provisional_id) REFERENCES public.provisional_sources(id) ON DELETE SET NULL;


--
-- Name: source_verifications source_verifications_resulting_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_verifications
    ADD CONSTRAINT source_verifications_resulting_source_id_fkey FOREIGN KEY (resulting_source_id) REFERENCES public.sources(id) ON DELETE SET NULL;


--
-- Name: sources sources_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sources
    ADD CONSTRAINT sources_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE SET NULL;


--
-- Name: sources sources_organisation_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sources
    ADD CONSTRAINT sources_organisation_entity_id_fkey FOREIGN KEY (organisation_entity_id) REFERENCES public.entities(entity_id);


--
-- Name: staged_updates staged_updates_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staged_updates
    ADD CONSTRAINT staged_updates_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id);


--
-- Name: staged_updates staged_updates_materialized_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staged_updates
    ADD CONSTRAINT staged_updates_materialized_item_id_fkey FOREIGN KEY (materialized_item_id) REFERENCES public.intelligence_items(id) ON DELETE SET NULL;


--
-- Name: staged_updates staged_updates_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.staged_updates
    ADD CONSTRAINT staged_updates_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id);


--
-- Name: state_cost_facts state_cost_facts_region_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_cost_facts
    ADD CONSTRAINT state_cost_facts_region_id_fkey FOREIGN KEY (region_id) REFERENCES public.regions(id) ON DELETE CASCADE;


--
-- Name: state_cost_facts state_cost_facts_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_cost_facts
    ADD CONSTRAINT state_cost_facts_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE SET NULL;


--
-- Name: statutory_computations statutory_computations_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statutory_computations
    ADD CONSTRAINT statutory_computations_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(entity_id);


--
-- Name: statutory_computations statutory_computations_obligation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.statutory_computations
    ADD CONSTRAINT statutory_computations_obligation_id_fkey FOREIGN KEY (obligation_id) REFERENCES public.entities(entity_id);


--
-- Name: user_item_state user_item_state_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_item_state
    ADD CONSTRAINT user_item_state_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: user_item_state user_item_state_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_item_state
    ADD CONSTRAINT user_item_state_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: user_item_state user_item_state_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_item_state
    ADD CONSTRAINT user_item_state_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_watchlist user_watchlist_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_watchlist
    ADD CONSTRAINT user_watchlist_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: user_watchlist user_watchlist_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_watchlist
    ADD CONSTRAINT user_watchlist_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: vocabulary_mentions vocabulary_mentions_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vocabulary_mentions
    ADD CONSTRAINT vocabulary_mentions_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: vocabulary_mentions vocabulary_mentions_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vocabulary_mentions
    ADD CONSTRAINT vocabulary_mentions_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.sources(id) ON DELETE SET NULL;


--
-- Name: vocabulary_mentions vocabulary_mentions_term_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vocabulary_mentions
    ADD CONSTRAINT vocabulary_mentions_term_id_fkey FOREIGN KEY (term_id) REFERENCES public.vocabulary_terms(id) ON DELETE CASCADE;


--
-- Name: workspace_item_overrides workspace_item_overrides_archived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_item_overrides
    ADD CONSTRAINT workspace_item_overrides_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: workspace_item_overrides workspace_item_overrides_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_item_overrides
    ADD CONSTRAINT workspace_item_overrides_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.intelligence_items(id) ON DELETE CASCADE;


--
-- Name: workspace_item_overrides workspace_item_overrides_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_item_overrides
    ADD CONSTRAINT workspace_item_overrides_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workspace_item_overrides workspace_item_overrides_owner_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_item_overrides
    ADD CONSTRAINT workspace_item_overrides_owner_assigned_by_fkey FOREIGN KEY (owner_assigned_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: workspace_item_overrides workspace_item_overrides_owner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_item_overrides
    ADD CONSTRAINT workspace_item_overrides_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: workspace_settings workspace_settings_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_settings
    ADD CONSTRAINT workspace_settings_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: workspace_tags workspace_tags_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tags
    ADD CONSTRAINT workspace_tags_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: workspace_tags workspace_tags_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_tags
    ADD CONSTRAINT workspace_tags_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;


--
-- Name: admin_action_cooldowns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_action_cooldowns ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_run_searches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_run_searches ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_run_searches agent_run_searches_reconciler_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_run_searches_reconciler_select ON public.agent_run_searches FOR SELECT TO reconciler USING (true);


--
-- Name: agent_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.agent_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_runs agent_runs_service_role_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY agent_runs_service_role_all ON public.agent_runs TO service_role USING (true) WITH CHECK (true);


--
-- Name: aggregate_query_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.aggregate_query_log ENABLE ROW LEVEL SECURITY;

--
-- Name: assumption_register; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.assumption_register ENABLE ROW LEVEL SECURITY;

--
-- Name: assumption_register assumption_register_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY assumption_register_read ON public.assumption_register FOR SELECT TO authenticated USING (true);


--
-- Name: auxiliary_energy_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.auxiliary_energy_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: auxiliary_energy_profiles auxiliary_energy_profiles_org_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY auxiliary_energy_profiles_org_read ON public.auxiliary_energy_profiles FOR SELECT USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));


--
-- Name: brief_apply_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.brief_apply_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: bulk_imports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bulk_imports ENABLE ROW LEVEL SECURITY;

--
-- Name: bulk_imports bulk_imports_read_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bulk_imports_read_authenticated ON public.bulk_imports FOR SELECT USING ((( SELECT auth.role() AS role) = 'authenticated'::text));


--
-- Name: canonical_source_candidates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.canonical_source_candidates ENABLE ROW LEVEL SECURITY;

--
-- Name: canonical_source_candidates canonical_source_candidates_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY canonical_source_candidates_admin_read ON public.canonical_source_candidates FOR SELECT USING (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: canonical_source_candidates canonical_source_candidates_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY canonical_source_candidates_admin_write ON public.canonical_source_candidates TO authenticated, service_role USING (( SELECT public.is_platform_admin() AS is_platform_admin)) WITH CHECK (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: census_worklist; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.census_worklist ENABLE ROW LEVEL SECURITY;

--
-- Name: intelligence_changes changes_read_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY changes_read_authenticated ON public.intelligence_changes FOR SELECT USING (((( SELECT auth.role() AS role) = 'authenticated'::text) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: intelligence_changes changes_write_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY changes_write_service ON public.intelligence_changes FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: claim_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.claim_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: community_group_invitations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.community_group_invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: community_group_invitations community_group_invitations_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_group_invitations_insert_admin ON public.community_group_invitations FOR INSERT TO authenticated, service_role WITH CHECK (((inviter_user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM public.community_group_members m
  WHERE ((m.group_id = community_group_invitations.group_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = 'admin'::text))))));


--
-- Name: community_group_invitations community_group_invitations_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_group_invitations_select ON public.community_group_invitations FOR SELECT USING (((invitee_user_id = ( SELECT auth.uid() AS uid)) OR (inviter_user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM public.community_group_members m
  WHERE ((m.group_id = community_group_invitations.group_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))) OR (EXISTS ( SELECT 1
   FROM public.community_groups g
  WHERE ((g.id = community_group_invitations.group_id) AND (g.owner_user_id = ( SELECT auth.uid() AS uid)))))));


--
-- Name: community_group_invitations community_group_invitations_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_group_invitations_service_role ON public.community_group_invitations TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: community_group_invitations community_group_invitations_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_group_invitations_update_admin ON public.community_group_invitations FOR UPDATE TO authenticated, service_role USING ((EXISTS ( SELECT 1
   FROM public.community_group_members m
  WHERE ((m.group_id = community_group_invitations.group_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = 'admin'::text))))) WITH CHECK ((status = 'revoked'::text));


--
-- Name: community_group_invitations community_group_invitations_update_invitee; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_group_invitations_update_invitee ON public.community_group_invitations FOR UPDATE TO authenticated, service_role USING ((invitee_user_id = ( SELECT auth.uid() AS uid))) WITH CHECK (((invitee_user_id = ( SELECT auth.uid() AS uid)) AND (status = ANY (ARRAY['accepted'::text, 'declined'::text]))));


--
-- Name: community_group_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.community_group_members ENABLE ROW LEVEL SECURITY;

--
-- Name: community_group_members community_group_members_delete_self_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_group_members_delete_self_or_admin ON public.community_group_members FOR DELETE TO authenticated, service_role USING (((user_id = ( SELECT auth.uid() AS uid)) OR public.user_is_group_admin(group_id, ( SELECT auth.uid() AS uid)) OR public.user_owns_group(group_id, ( SELECT auth.uid() AS uid))));


--
-- Name: community_group_members community_group_members_insert_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_group_members_insert_admin ON public.community_group_members FOR INSERT TO authenticated, service_role WITH CHECK ((public.user_group_role(group_id) = 'admin'::text));


--
-- Name: community_group_members community_group_members_select_self_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_group_members_select_self_or_admin ON public.community_group_members FOR SELECT USING (((user_id = ( SELECT auth.uid() AS uid)) OR public.user_is_group_admin(group_id, ( SELECT auth.uid() AS uid)) OR public.user_owns_group(group_id, ( SELECT auth.uid() AS uid))));


--
-- Name: community_group_members community_group_members_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_group_members_service_role ON public.community_group_members TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: community_group_members community_group_members_update_self_prefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_group_members_update_self_prefs ON public.community_group_members FOR UPDATE TO authenticated, service_role USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK (((user_id = auth.uid()) AND (role = public.user_group_role(group_id))));


--
-- Name: community_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.community_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: community_groups community_groups_delete_owner_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_groups_delete_owner_or_admin ON public.community_groups FOR DELETE TO authenticated, service_role USING (((owner_user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM public.community_group_members m
  WHERE ((m.group_id = community_groups.id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = 'admin'::text))))));


--
-- Name: community_groups community_groups_insert_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_groups_insert_authenticated ON public.community_groups FOR INSERT TO authenticated, service_role WITH CHECK (((( SELECT auth.role() AS role) = 'authenticated'::text) AND (owner_user_id = ( SELECT auth.uid() AS uid))));


--
-- Name: community_groups community_groups_select_public_or_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_groups_select_public_or_member ON public.community_groups FOR SELECT USING (((privacy = 'public'::text) OR public.user_is_group_member(id, ( SELECT auth.uid() AS uid))));


--
-- Name: community_groups community_groups_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_groups_service_role ON public.community_groups TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: community_groups community_groups_update_owner_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_groups_update_owner_or_admin ON public.community_groups FOR UPDATE TO authenticated, service_role USING (((owner_user_id = ( SELECT auth.uid() AS uid)) OR public.user_is_group_admin(id, ( SELECT auth.uid() AS uid)))) WITH CHECK (((owner_user_id = ( SELECT auth.uid() AS uid)) OR public.user_is_group_admin(id, ( SELECT auth.uid() AS uid))));


--
-- Name: community_member_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.community_member_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: community_member_profiles community_member_profiles_select_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_member_profiles_select_authenticated ON public.community_member_profiles FOR SELECT USING ((auth.role() = 'authenticated'::text));


--
-- Name: community_member_profiles community_member_profiles_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_member_profiles_service_role ON public.community_member_profiles TO authenticated, service_role USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));


--
-- Name: community_member_profiles community_member_profiles_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_member_profiles_update_own ON public.community_member_profiles FOR UPDATE TO authenticated, service_role USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: community_member_profiles community_member_profiles_upsert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_member_profiles_upsert_own ON public.community_member_profiles FOR INSERT TO authenticated, service_role WITH CHECK ((user_id = auth.uid()));


--
-- Name: community_post_signoff_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.community_post_signoff_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: community_posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.community_posts ENABLE ROW LEVEL SECURITY;

--
-- Name: community_posts community_posts_delete_author_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_posts_delete_author_or_admin ON public.community_posts FOR DELETE TO authenticated, service_role USING (((author_user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM public.community_group_members m
  WHERE ((m.group_id = community_posts.group_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: community_posts community_posts_insert_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_posts_insert_member ON public.community_posts FOR INSERT TO authenticated, service_role WITH CHECK (((author_user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM public.community_group_members m
  WHERE ((m.group_id = community_posts.group_id) AND (m.user_id = ( SELECT auth.uid() AS uid)))))));


--
-- Name: community_posts community_posts_select_inherits_group; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_posts_select_inherits_group ON public.community_posts FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.community_groups g
  WHERE ((g.id = community_posts.group_id) AND ((g.privacy = 'public'::text) OR (EXISTS ( SELECT 1
           FROM public.community_group_members m
          WHERE ((m.group_id = g.id) AND (m.user_id = ( SELECT auth.uid() AS uid))))))))));


--
-- Name: community_posts community_posts_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_posts_service_role ON public.community_posts TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: community_posts community_posts_update_author_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_posts_update_author_or_admin ON public.community_posts FOR UPDATE TO authenticated, service_role USING (((author_user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM public.community_group_members m
  WHERE ((m.group_id = community_posts.group_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['admin'::text, 'moderator'::text]))))))) WITH CHECK (((author_user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM public.community_group_members m
  WHERE ((m.group_id = community_posts.group_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))));


--
-- Name: community_thread_entities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.community_thread_entities ENABLE ROW LEVEL SECURITY;

--
-- Name: community_thread_entities community_thread_entities_insert_author; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_thread_entities_insert_author ON public.community_thread_entities FOR INSERT TO authenticated, service_role WITH CHECK ((EXISTS ( SELECT 1
   FROM public.community_posts p
  WHERE ((p.id = community_thread_entities.thread_id) AND (p.author_user_id = auth.uid())))));


--
-- Name: community_thread_entities community_thread_entities_select_inherits_thread; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_thread_entities_select_inherits_thread ON public.community_thread_entities FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public.community_posts p
     JOIN public.community_groups g ON ((g.id = p.group_id)))
  WHERE ((p.id = community_thread_entities.thread_id) AND ((g.privacy = 'public'::text) OR (EXISTS ( SELECT 1
           FROM public.community_group_members m
          WHERE ((m.group_id = g.id) AND (m.user_id = auth.uid())))))))));


--
-- Name: community_thread_entities community_thread_entities_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_thread_entities_service_role ON public.community_thread_entities TO authenticated, service_role USING ((auth.role() = 'service_role'::text)) WITH CHECK ((auth.role() = 'service_role'::text));


--
-- Name: community_topic_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.community_topic_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: community_topic_groups community_topic_groups_delete_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_topic_groups_delete_owner ON public.community_topic_groups FOR DELETE TO authenticated, service_role USING ((EXISTS ( SELECT 1
   FROM public.community_topics t
  WHERE ((t.id = community_topic_groups.topic_id) AND (t.owner_user_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: community_topic_groups community_topic_groups_insert_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_topic_groups_insert_owner ON public.community_topic_groups FOR INSERT TO authenticated, service_role WITH CHECK ((EXISTS ( SELECT 1
   FROM public.community_topics t
  WHERE ((t.id = community_topic_groups.topic_id) AND (t.owner_user_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: community_topic_groups community_topic_groups_select_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_topic_groups_select_owner ON public.community_topic_groups FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.community_topics t
  WHERE ((t.id = community_topic_groups.topic_id) AND (t.owner_user_id = ( SELECT auth.uid() AS uid))))));


--
-- Name: community_topic_groups community_topic_groups_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_topic_groups_service_role ON public.community_topic_groups TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: community_topics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.community_topics ENABLE ROW LEVEL SECURITY;

--
-- Name: community_topics community_topics_delete_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_topics_delete_owner ON public.community_topics FOR DELETE TO authenticated, service_role USING ((owner_user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: community_topics community_topics_insert_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_topics_insert_owner ON public.community_topics FOR INSERT TO authenticated, service_role WITH CHECK ((owner_user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: community_topics community_topics_select_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_topics_select_owner ON public.community_topics FOR SELECT USING ((owner_user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: community_topics community_topics_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_topics_service_role ON public.community_topics TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: community_topics community_topics_update_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY community_topics_update_owner ON public.community_topics FOR UPDATE TO authenticated, service_role USING ((owner_user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((owner_user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: connection_theme_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.connection_theme_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: connection_theme_runs connection_theme_runs_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY connection_theme_runs_admin_write ON public.connection_theme_runs TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: connection_theme_runs connection_theme_runs_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY connection_theme_runs_read ON public.connection_theme_runs FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: connection_themes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.connection_themes ENABLE ROW LEVEL SECURITY;

--
-- Name: connection_themes connection_themes_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY connection_themes_admin_write ON public.connection_themes TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: connection_themes connection_themes_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY connection_themes_read ON public.connection_themes FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: corpus_census; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.corpus_census ENABLE ROW LEVEL SECURITY;

--
-- Name: corpus_turn_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.corpus_turn_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: corpus_turn_requests corpus_turn_requests_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY corpus_turn_requests_admin_read ON public.corpus_turn_requests FOR SELECT TO authenticated USING (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: coverage_gap_candidates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.coverage_gap_candidates ENABLE ROW LEVEL SECURITY;

--
-- Name: coverage_gap_census_findings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.coverage_gap_census_findings ENABLE ROW LEVEL SECURITY;

--
-- Name: coverage_gaps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.coverage_gaps ENABLE ROW LEVEL SECURITY;

--
-- Name: coverage_gaps coverage_gaps_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY coverage_gaps_select ON public.coverage_gaps FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: data_sources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.data_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: data_sources data_sources_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY data_sources_read ON public.data_sources FOR SELECT TO authenticated USING (true);


--
-- Name: derivation_edges; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.derivation_edges ENABLE ROW LEVEL SECURITY;

--
-- Name: derived_values; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.derived_values ENABLE ROW LEVEL SECURITY;

--
-- Name: disposition_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.disposition_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: emission_factors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.emission_factors ENABLE ROW LEVEL SECURITY;

--
-- Name: emission_factors emission_factors_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY emission_factors_read ON public.emission_factors FOR SELECT TO authenticated USING (true);


--
-- Name: entities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;

--
-- Name: entities entities_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY entities_read ON public.entities FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: entity_aliases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entity_aliases ENABLE ROW LEVEL SECURITY;

--
-- Name: entity_aliases entity_aliases_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY entity_aliases_read ON public.entity_aliases FOR SELECT TO authenticated USING (true);


--
-- Name: entity_identifiers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entity_identifiers ENABLE ROW LEVEL SECURITY;

--
-- Name: entity_identifiers entity_identifiers_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY entity_identifiers_read ON public.entity_identifiers FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: entity_refs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entity_refs ENABLE ROW LEVEL SECURITY;

--
-- Name: entity_refs entity_refs_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY entity_refs_read ON public.entity_refs FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: entity_relations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entity_relations ENABLE ROW LEVEL SECURITY;

--
-- Name: entity_relations entity_relations_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY entity_relations_read ON public.entity_relations FOR SELECT TO authenticated USING (true);


--
-- Name: entity_scope; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.entity_scope ENABLE ROW LEVEL SECURITY;

--
-- Name: entity_scope entity_scope_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY entity_scope_read ON public.entity_scope FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: error_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.error_events ENABLE ROW LEVEL SECURITY;

--
-- Name: error_events error_events_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY error_events_admin_read ON public.error_events FOR SELECT TO authenticated USING (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: estimated_values; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.estimated_values ENABLE ROW LEVEL SECURITY;

--
-- Name: estimated_values estimated_values_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY estimated_values_read ON public.estimated_values FOR SELECT TO authenticated USING (true);


--
-- Name: funded_pass_runlock; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.funded_pass_runlock ENABLE ROW LEVEL SECURITY;

--
-- Name: gate_a_health_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gate_a_health_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: grid_connection_queues; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.grid_connection_queues ENABLE ROW LEVEL SECURITY;

--
-- Name: grid_connection_queues grid_connection_queues_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY grid_connection_queues_read ON public.grid_connection_queues FOR SELECT TO authenticated USING (true);


--
-- Name: harness_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.harness_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: holdings_quality; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.holdings_quality ENABLE ROW LEVEL SECURITY;

--
-- Name: holdings_quality holdings_quality_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY holdings_quality_admin_read ON public.holdings_quality FOR SELECT USING (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: holdings_quality holdings_quality_service_role_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY holdings_quality_service_role_write ON public.holdings_quality TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: intelligence_item_versions iiv_service_role_select_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY iiv_service_role_select_insert ON public.intelligence_item_versions TO service_role USING (true) WITH CHECK (true);


--
-- Name: indexation_clauses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.indexation_clauses ENABLE ROW LEVEL SECURITY;

--
-- Name: indexation_clauses indexation_clauses_org_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY indexation_clauses_org_read ON public.indexation_clauses FOR SELECT USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));


--
-- Name: inference_records; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.inference_records ENABLE ROW LEVEL SECURITY;

--
-- Name: ingest_rejections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ingest_rejections ENABLE ROW LEVEL SECURITY;

--
-- Name: ingest_rejections ingest_rejections_read_platform_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ingest_rejections_read_platform_admin ON public.ingest_rejections FOR SELECT USING (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: ingest_rejections ingest_rejections_update_platform_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ingest_rejections_update_platform_admin ON public.ingest_rejections FOR UPDATE TO authenticated, service_role USING (( SELECT public.is_platform_admin() AS is_platform_admin)) WITH CHECK (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: institutions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.institutions ENABLE ROW LEVEL SECURITY;

--
-- Name: integrity_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.integrity_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: integrity_flags integrity_flags_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY integrity_flags_admin_read ON public.integrity_flags FOR SELECT USING (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: integrity_flags integrity_flags_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY integrity_flags_admin_update ON public.integrity_flags FOR UPDATE TO authenticated, service_role USING (( SELECT public.is_platform_admin() AS is_platform_admin)) WITH CHECK (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: integrity_flags integrity_flags_reconciler_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY integrity_flags_reconciler_insert ON public.integrity_flags FOR INSERT TO reconciler WITH CHECK (true);


--
-- Name: integrity_flags integrity_flags_reconciler_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY integrity_flags_reconciler_select ON public.integrity_flags FOR SELECT TO reconciler USING (true);


--
-- Name: integrity_flags integrity_flags_service_role_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY integrity_flags_service_role_write ON public.integrity_flags TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: intelligence_changes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.intelligence_changes ENABLE ROW LEVEL SECURITY;

--
-- Name: intelligence_changes intelligence_changes_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY intelligence_changes_read ON public.intelligence_changes FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.intelligence_items i
  WHERE ((i.id = intelligence_changes.item_id) AND (i.is_archived = false)))));


--
-- Name: intelligence_item_citations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.intelligence_item_citations ENABLE ROW LEVEL SECURITY;

--
-- Name: intelligence_item_sections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.intelligence_item_sections ENABLE ROW LEVEL SECURITY;

--
-- Name: intelligence_item_sections intelligence_item_sections_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY intelligence_item_sections_read ON public.intelligence_item_sections FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.intelligence_items i
  WHERE ((i.id = intelligence_item_sections.item_id) AND (i.is_archived = false)))));


--
-- Name: intelligence_item_sections intelligence_item_sections_reconciler_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY intelligence_item_sections_reconciler_select ON public.intelligence_item_sections FOR SELECT TO reconciler USING (true);


--
-- Name: intelligence_item_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.intelligence_item_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: intelligence_items; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.intelligence_items ENABLE ROW LEVEL SECURITY;

--
-- Name: intelligence_items intelligence_items_admin_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY intelligence_items_admin_delete ON public.intelligence_items FOR DELETE TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: intelligence_items intelligence_items_admin_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY intelligence_items_admin_insert ON public.intelligence_items FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: intelligence_items intelligence_items_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY intelligence_items_admin_update ON public.intelligence_items FOR UPDATE TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: intelligence_items intelligence_items_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY intelligence_items_read ON public.intelligence_items FOR SELECT TO authenticated, anon USING (((provenance_status = 'verified'::public.provenance_status) AND (is_archived IS NOT TRUE)));


--
-- Name: intelligence_items intelligence_items_reconciler_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY intelligence_items_reconciler_select ON public.intelligence_items FOR SELECT TO reconciler USING (true);


--
-- Name: intelligence_items intelligence_items_reconciler_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY intelligence_items_reconciler_update ON public.intelligence_items FOR UPDATE TO reconciler USING (true) WITH CHECK (true);


--
-- Name: intelligence_summaries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.intelligence_summaries ENABLE ROW LEVEL SECURITY;

--
-- Name: item_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: item_assignments item_assignments_delete_party; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_assignments_delete_party ON public.item_assignments FOR DELETE TO authenticated, service_role USING (((public.user_belongs_to_org(org_id) AND ((assignee_user_id = auth.uid()) OR (assigned_by = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.org_id = item_assignments.org_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) OR (auth.role() = 'service_role'::text)));


--
-- Name: item_assignments item_assignments_insert_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_assignments_insert_member ON public.item_assignments FOR INSERT TO authenticated, service_role WITH CHECK ((((assigned_by = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.org_id = item_assignments.org_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))))) AND (EXISTS ( SELECT 1
   FROM public.org_memberships a
  WHERE ((a.org_id = item_assignments.org_id) AND (a.user_id = item_assignments.assignee_user_id) AND (a.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))))) OR (auth.role() = 'service_role'::text)));


--
-- Name: item_assignments item_assignments_read_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_assignments_read_org ON public.item_assignments FOR SELECT USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));


--
-- Name: item_assignments item_assignments_update_party; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_assignments_update_party ON public.item_assignments FOR UPDATE TO authenticated, service_role USING (((public.user_belongs_to_org(org_id) AND ((assignee_user_id = auth.uid()) OR (assigned_by = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.org_id = item_assignments.org_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) OR (auth.role() = 'service_role'::text))) WITH CHECK (((public.user_belongs_to_org(org_id) AND ((assignee_user_id = auth.uid()) OR (assigned_by = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.org_id = item_assignments.org_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) OR (auth.role() = 'service_role'::text)));


--
-- Name: item_changelog; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_changelog ENABLE ROW LEVEL SECURITY;

--
-- Name: item_changelog item_changelog_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_changelog_admin_write ON public.item_changelog FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: item_changelog item_changelog_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_changelog_read ON public.item_changelog FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.intelligence_items i
  WHERE ((i.id = item_changelog.item_id) AND (i.provenance_status = 'verified'::public.provenance_status) AND (i.is_archived IS NOT TRUE)))));


--
-- Name: item_correction_evidence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_correction_evidence ENABLE ROW LEVEL SECURITY;

--
-- Name: item_correction_evidence item_correction_evidence_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_correction_evidence_admin_read ON public.item_correction_evidence FOR SELECT TO authenticated USING (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: item_corrections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_corrections ENABLE ROW LEVEL SECURITY;

--
-- Name: item_corrections item_corrections_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_corrections_admin_read ON public.item_corrections FOR SELECT TO authenticated USING (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: item_cross_references; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_cross_references ENABLE ROW LEVEL SECURITY;

--
-- Name: item_cross_references item_cross_references_admin_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_cross_references_admin_delete ON public.item_cross_references FOR DELETE TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: item_cross_references item_cross_references_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_cross_references_admin_write ON public.item_cross_references FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: item_cross_references item_cross_references_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_cross_references_read ON public.item_cross_references FOR SELECT USING (((EXISTS ( SELECT 1
   FROM public.intelligence_items i
  WHERE ((i.id = item_cross_references.source_item_id) AND (i.provenance_status = 'verified'::public.provenance_status) AND (i.is_archived IS NOT TRUE)))) AND (EXISTS ( SELECT 1
   FROM public.intelligence_items i
  WHERE ((i.id = item_cross_references.target_item_id) AND (i.provenance_status = 'verified'::public.provenance_status) AND (i.is_archived IS NOT TRUE))))));


--
-- Name: item_disputes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_disputes ENABLE ROW LEVEL SECURITY;

--
-- Name: item_disputes item_disputes_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_disputes_admin_update ON public.item_disputes FOR UPDATE TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: item_disputes item_disputes_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_disputes_admin_write ON public.item_disputes FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: item_disputes item_disputes_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_disputes_read ON public.item_disputes FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.intelligence_items i
  WHERE ((i.id = item_disputes.item_id) AND (i.provenance_status = 'verified'::public.provenance_status) AND (i.is_archived IS NOT TRUE)))));


--
-- Name: item_forward_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_forward_events ENABLE ROW LEVEL SECURITY;

--
-- Name: item_forward_events item_forward_events_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_forward_events_read ON public.item_forward_events FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.intelligence_items i
  WHERE ((i.id = item_forward_events.intelligence_item_id) AND (i.is_archived = false)))));


--
-- Name: item_gate_a_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_gate_a_state ENABLE ROW LEVEL SECURITY;

--
-- Name: item_gate_a_state item_gate_a_state_service_role_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_gate_a_state_service_role_all ON public.item_gate_a_state TO service_role USING (true) WITH CHECK (true);


--
-- Name: item_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: item_notes item_notes_insert_member; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_notes_insert_member ON public.item_notes FOR INSERT TO authenticated, service_role WITH CHECK ((((author_user_id = auth.uid()) AND (deleted_at IS NULL) AND (EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.org_id = item_notes.org_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text])))))) OR (auth.role() = 'service_role'::text)));


--
-- Name: item_notes item_notes_read_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_notes_read_org ON public.item_notes FOR SELECT USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));


--
-- Name: item_notes item_notes_update_author_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_notes_update_author_or_admin ON public.item_notes FOR UPDATE TO authenticated, service_role USING ((((author_user_id = auth.uid()) AND public.user_belongs_to_org(org_id)) OR (EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.org_id = item_notes.org_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) OR (auth.role() = 'service_role'::text))) WITH CHECK ((((author_user_id = auth.uid()) AND public.user_belongs_to_org(org_id)) OR (EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.org_id = item_notes.org_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) OR (auth.role() = 'service_role'::text)));


--
-- Name: item_supersessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_supersessions ENABLE ROW LEVEL SECURITY;

--
-- Name: item_supersessions item_supersessions_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_supersessions_admin_write ON public.item_supersessions FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: item_supersessions item_supersessions_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_supersessions_read ON public.item_supersessions FOR SELECT USING (((EXISTS ( SELECT 1
   FROM public.intelligence_items i
  WHERE ((i.id = item_supersessions.old_item_id) AND (i.provenance_status = 'verified'::public.provenance_status) AND (i.is_archived IS NOT TRUE)))) AND (EXISTS ( SELECT 1
   FROM public.intelligence_items i
  WHERE ((i.id = item_supersessions.new_item_id) AND (i.provenance_status = 'verified'::public.provenance_status) AND (i.is_archived IS NOT TRUE))))));


--
-- Name: item_timelines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_timelines ENABLE ROW LEVEL SECURITY;

--
-- Name: item_timelines item_timelines_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_timelines_admin_update ON public.item_timelines FOR UPDATE TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: item_timelines item_timelines_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_timelines_admin_write ON public.item_timelines FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: item_timelines item_timelines_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_timelines_read ON public.item_timelines FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.intelligence_items i
  WHERE ((i.id = item_timelines.item_id) AND (i.provenance_status = 'verified'::public.provenance_status) AND (i.is_archived IS NOT TRUE)))));


--
-- Name: item_type_required_slots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_type_required_slots ENABLE ROW LEVEL SECURITY;

--
-- Name: item_type_required_slots item_type_required_slots_reconciler_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_type_required_slots_reconciler_select ON public.item_type_required_slots FOR SELECT TO reconciler USING (true);


--
-- Name: item_workspace_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.item_workspace_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: item_workspace_tags item_workspace_tags_org_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_workspace_tags_org_delete ON public.item_workspace_tags FOR DELETE TO authenticated, service_role USING ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: item_workspace_tags item_workspace_tags_org_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_workspace_tags_org_insert ON public.item_workspace_tags FOR INSERT TO authenticated, service_role WITH CHECK (((public.user_can_write_in_org(org_id) AND (created_by = ( SELECT auth.uid() AS uid))) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: item_workspace_tags item_workspace_tags_org_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY item_workspace_tags_org_read ON public.item_workspace_tags FOR SELECT USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));


--
-- Name: market_series; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.market_series ENABLE ROW LEVEL SECURITY;

--
-- Name: market_series market_series_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY market_series_read ON public.market_series FOR SELECT TO authenticated USING (true);


--
-- Name: org_memberships membership_delete_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY membership_delete_admin ON public.org_memberships FOR DELETE TO authenticated, service_role USING (((public.user_org_role(org_id) = ANY (ARRAY['owner'::text, 'admin'::text])) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: org_memberships membership_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY membership_read ON public.org_memberships FOR SELECT USING ((public.user_belongs_to_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: org_memberships membership_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY membership_update_admin ON public.org_memberships FOR UPDATE TO authenticated, service_role USING (((public.user_org_role(org_id) = ANY (ARRAY['owner'::text, 'admin'::text])) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: org_memberships membership_write_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY membership_write_admin ON public.org_memberships FOR INSERT TO authenticated, service_role WITH CHECK (((public.user_org_role(org_id) = ANY (ARRAY['owner'::text, 'admin'::text])) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: moderation_reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.moderation_reports ENABLE ROW LEVEL SECURITY;

--
-- Name: moderation_reports moderation_reports_insert_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY moderation_reports_insert_authenticated ON public.moderation_reports FOR INSERT TO authenticated, service_role WITH CHECK (((( SELECT auth.role() AS role) = 'authenticated'::text) AND (reporter_user_id = ( SELECT auth.uid() AS uid)) AND (status = 'open'::text)));


--
-- Name: moderation_reports moderation_reports_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY moderation_reports_select ON public.moderation_reports FOR SELECT USING (((reporter_user_id = auth.uid()) OR ((target_kind = 'post'::text) AND (EXISTS ( SELECT 1
   FROM (public.community_posts p
     JOIN public.community_group_members m ON ((m.group_id = p.group_id)))
  WHERE ((p.id = moderation_reports.target_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))) OR ((target_kind = 'group'::text) AND (EXISTS ( SELECT 1
   FROM public.community_group_members m
  WHERE ((m.group_id = moderation_reports.target_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))) OR ( SELECT public.is_platform_admin() AS is_platform_admin)));


--
-- Name: moderation_reports moderation_reports_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY moderation_reports_service_role ON public.moderation_reports TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: moderation_reports moderation_reports_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY moderation_reports_update_admin ON public.moderation_reports FOR UPDATE TO authenticated, service_role USING ((( SELECT public.is_platform_admin() AS is_platform_admin) OR ((target_kind = 'post'::text) AND (EXISTS ( SELECT 1
   FROM (public.community_posts p
     JOIN public.community_group_members m ON ((m.group_id = p.group_id)))
  WHERE ((p.id = moderation_reports.target_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))) OR ((target_kind = 'group'::text) AND (EXISTS ( SELECT 1
   FROM public.community_group_members m
  WHERE ((m.group_id = moderation_reports.target_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['admin'::text, 'moderator'::text])))))))) WITH CHECK (((resolved_by_user_id IS NULL) OR (resolved_by_user_id = ( SELECT auth.uid() AS uid))));


--
-- Name: monitoring_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.monitoring_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: monitoring_queue monitoring_queue_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY monitoring_queue_admin_update ON public.monitoring_queue FOR UPDATE TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: monitoring_queue monitoring_queue_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY monitoring_queue_admin_write ON public.monitoring_queue FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: monitoring_queue monitoring_queue_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY monitoring_queue_read ON public.monitoring_queue FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: mutation_leases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mutation_leases ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_preferences notification_preferences_delete_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_preferences_delete_self ON public.notification_preferences FOR DELETE TO authenticated, service_role USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: notification_preferences notification_preferences_insert_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_preferences_insert_self ON public.notification_preferences FOR INSERT TO authenticated, service_role WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: notification_preferences notification_preferences_select_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_preferences_select_self ON public.notification_preferences FOR SELECT USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: notification_preferences notification_preferences_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_preferences_service_role ON public.notification_preferences TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: notification_preferences notification_preferences_update_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notification_preferences_update_self ON public.notification_preferences FOR UPDATE TO authenticated, service_role USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications notifications_select_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_select_self ON public.notifications FOR SELECT USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: notifications notifications_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_service_role ON public.notifications TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: notifications notifications_update_self_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_update_self_read ON public.notifications FOR UPDATE TO authenticated, service_role USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: obligation_objects; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.obligation_objects ENABLE ROW LEVEL SECURITY;

--
-- Name: obligation_objects obligation_objects_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY obligation_objects_read ON public.obligation_objects FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.intelligence_items i
  WHERE ((i.id = obligation_objects.instrument_item_id) AND (i.is_archived = false)))));


--
-- Name: obligations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.obligations ENABLE ROW LEVEL SECURITY;

--
-- Name: obligations obligations_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY obligations_read ON public.obligations FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.intelligence_items i
  WHERE ((i.id = obligations.intelligence_item_id) AND (i.is_archived = false)))));


--
-- Name: oem_tech_roadmaps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.oem_tech_roadmaps ENABLE ROW LEVEL SECURITY;

--
-- Name: oem_tech_roadmaps oem_tech_roadmaps_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY oem_tech_roadmaps_read ON public.oem_tech_roadmaps FOR SELECT TO authenticated USING (true);


--
-- Name: org_invitations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: org_invitations org_invitations_admin_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_invitations_admin_insert ON public.org_invitations FOR INSERT TO authenticated, service_role WITH CHECK (((EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.org_id = org_invitations.org_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) AND (proposed_role = ANY (ARRAY['admin'::text, 'member'::text, 'viewer'::text])) AND (invited_by_user_id = ( SELECT auth.uid() AS uid))));


--
-- Name: POLICY org_invitations_admin_insert ON org_invitations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON POLICY org_invitations_admin_insert ON public.org_invitations IS 'Org admins can create new invitations. proposed_role limited to admin/member/viewer (owner reserved for org creator).';


--
-- Name: org_invitations org_invitations_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_invitations_admin_read ON public.org_invitations FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.org_id = org_invitations.org_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: POLICY org_invitations_admin_read ON org_invitations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON POLICY org_invitations_admin_read ON public.org_invitations IS 'Org admins (owner/admin) can list invitations for orgs they administer. Used by the admin Invitations tab.';


--
-- Name: org_invitations org_invitations_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_invitations_admin_update ON public.org_invitations FOR UPDATE TO authenticated, service_role USING ((EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.org_id = org_invitations.org_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: org_invitations org_invitations_service_role; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_invitations_service_role ON public.org_invitations TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: org_member_bans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_member_bans ENABLE ROW LEVEL SECURITY;

--
-- Name: org_member_bans org_member_bans_select_owner_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_member_bans_select_owner_admin ON public.org_member_bans FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.org_id = org_member_bans.org_id) AND (m.user_id = ( SELECT auth.uid() AS uid)) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: org_memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: organizations org_read_members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_read_members ON public.organizations FOR SELECT USING ((public.user_belongs_to_org(id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: organizations org_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_update_admin ON public.organizations FOR UPDATE TO authenticated, service_role USING (((EXISTS ( SELECT 1
   FROM public.org_memberships
  WHERE ((org_memberships.org_id = organizations.id) AND (org_memberships.user_id = ( SELECT auth.uid() AS uid)) AND (org_memberships.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: org_watchlist; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.org_watchlist ENABLE ROW LEVEL SECURITY;

--
-- Name: org_watchlist org_watchlist_member_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_watchlist_member_delete ON public.org_watchlist FOR DELETE TO authenticated, service_role USING ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: org_watchlist org_watchlist_member_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_watchlist_member_insert ON public.org_watchlist FOR INSERT TO authenticated, service_role WITH CHECK (((public.user_can_write_in_org(org_id) AND (added_by_user_id = ( SELECT auth.uid() AS uid))) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: org_watchlist org_watchlist_member_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_watchlist_member_read ON public.org_watchlist FOR SELECT USING ((public.user_belongs_to_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: org_watchlist org_watchlist_member_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_watchlist_member_update ON public.org_watchlist FOR UPDATE TO authenticated, service_role USING ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: organizations org_write_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY org_write_service ON public.organizations FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: organizations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_item_overrides overrides_delete_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY overrides_delete_org ON public.workspace_item_overrides FOR DELETE TO authenticated, service_role USING ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: workspace_item_overrides overrides_insert_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY overrides_insert_org ON public.workspace_item_overrides FOR INSERT TO authenticated, service_role WITH CHECK ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: workspace_item_overrides overrides_read_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY overrides_read_org ON public.workspace_item_overrides FOR SELECT USING ((public.user_belongs_to_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: workspace_item_overrides overrides_update_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY overrides_update_org ON public.workspace_item_overrides FOR UPDATE TO authenticated, service_role USING ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: pending_first_fetch; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pending_first_fetch ENABLE ROW LEVEL SECURITY;

--
-- Name: pending_jurisdiction_review; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pending_jurisdiction_review ENABLE ROW LEVEL SECURITY;

--
-- Name: pending_first_fetch pff_service_role_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pff_service_role_all ON public.pending_first_fetch TO service_role USING (true) WITH CHECK (true);


--
-- Name: pending_jurisdiction_review pjr_read_platform_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pjr_read_platform_admin ON public.pending_jurisdiction_review FOR SELECT USING (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: pending_jurisdiction_review pjr_update_platform_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pjr_update_platform_admin ON public.pending_jurisdiction_review FOR UPDATE TO authenticated, service_role USING (( SELECT public.is_platform_admin() AS is_platform_admin)) WITH CHECK (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: portal_link_candidates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.portal_link_candidates ENABLE ROW LEVEL SECURITY;

--
-- Name: portfolio_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.portfolio_members ENABLE ROW LEVEL SECURITY;

--
-- Name: portfolio_members portfolio_members_org_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY portfolio_members_org_delete ON public.portfolio_members FOR DELETE TO authenticated, service_role USING ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: portfolio_members portfolio_members_org_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY portfolio_members_org_insert ON public.portfolio_members FOR INSERT TO authenticated, service_role WITH CHECK (((public.user_can_write_in_org(org_id) AND (added_by = ( SELECT auth.uid() AS uid))) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: portfolio_members portfolio_members_org_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY portfolio_members_org_read ON public.portfolio_members FOR SELECT USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));


--
-- Name: portfolios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.portfolios ENABLE ROW LEVEL SECURITY;

--
-- Name: portfolios portfolios_org_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY portfolios_org_delete ON public.portfolios FOR DELETE TO authenticated, service_role USING ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: portfolios portfolios_org_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY portfolios_org_insert ON public.portfolios FOR INSERT TO authenticated, service_role WITH CHECK (((public.user_can_write_in_org(org_id) AND (created_by = ( SELECT auth.uid() AS uid))) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: portfolios portfolios_org_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY portfolios_org_read ON public.portfolios FOR SELECT USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));


--
-- Name: portfolios portfolios_org_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY portfolios_org_update ON public.portfolios FOR UPDATE TO authenticated, service_role USING ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text))) WITH CHECK ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles_select_own_or_shared_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_select_own_or_shared_org ON public.profiles FOR SELECT TO authenticated USING (((id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM public.org_memberships m
  WHERE ((m.user_id = profiles.id) AND public.user_belongs_to_org(m.org_id))))));


--
-- Name: profiles profiles_self_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_self_insert ON public.profiles FOR INSERT TO authenticated WITH CHECK ((( SELECT auth.uid() AS uid) = id));


--
-- Name: profiles profiles_self_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY profiles_self_update ON public.profiles FOR UPDATE TO authenticated USING ((( SELECT auth.uid() AS uid) = id)) WITH CHECK ((( SELECT auth.uid() AS uid) = id));


--
-- Name: propagation_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.propagation_events ENABLE ROW LEVEL SECURITY;

--
-- Name: provisional_sources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provisional_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: provisional_sources provisional_sources_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provisional_sources_admin_read ON public.provisional_sources FOR SELECT USING (((auth.role() = 'service_role'::text) OR ( SELECT public.is_platform_admin() AS is_platform_admin)));


--
-- Name: provisional_sources provisional_sources_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provisional_sources_admin_update ON public.provisional_sources FOR UPDATE TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: provisional_sources provisional_sources_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY provisional_sources_admin_write ON public.provisional_sources FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: published_price_statistics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.published_price_statistics ENABLE ROW LEVEL SECURITY;

--
-- Name: published_price_statistics published_price_statistics_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY published_price_statistics_read ON public.published_price_statistics FOR SELECT TO authenticated USING (true);


--
-- Name: raw_fetches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.raw_fetches ENABLE ROW LEVEL SECURITY;

--
-- Name: raw_fetches raw_fetches_service_role_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY raw_fetches_service_role_all ON public.raw_fetches TO service_role USING (true) WITH CHECK (true);


--
-- Name: region_dimension_coverage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.region_dimension_coverage ENABLE ROW LEVEL SECURITY;

--
-- Name: region_dimension_coverage region_dimension_coverage_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY region_dimension_coverage_read ON public.region_dimension_coverage FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: regional_data_facts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.regional_data_facts ENABLE ROW LEVEL SECURITY;

--
-- Name: regional_data_facts regional_data_facts_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY regional_data_facts_read ON public.regional_data_facts FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: regions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.regions ENABLE ROW LEVEL SECURITY;

--
-- Name: regions regions_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY regions_read ON public.regions FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: reroute_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reroute_events ENABLE ROW LEVEL SECURITY;

--
-- Name: reroute_events reroute_events_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY reroute_events_read ON public.reroute_events FOR SELECT TO authenticated USING (true);


--
-- Name: research_assessments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.research_assessments ENABLE ROW LEVEL SECURITY;

--
-- Name: section_claim_provenance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.section_claim_provenance ENABLE ROW LEVEL SECURITY;

--
-- Name: section_claim_provenance section_claim_provenance_reconciler_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY section_claim_provenance_reconciler_select ON public.section_claim_provenance FOR SELECT TO reconciler USING (true);


--
-- Name: sector_contexts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sector_contexts ENABLE ROW LEVEL SECURITY;

--
-- Name: sector_contexts sector_contexts_read_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sector_contexts_read_authenticated ON public.sector_contexts FOR SELECT USING (((( SELECT auth.role() AS role) = 'authenticated'::text) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: sector_contexts sector_contexts_write_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sector_contexts_write_service ON public.sector_contexts FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: sensitive_field_policy; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sensitive_field_policy ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_action_cooldowns service role full access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "service role full access" ON public.admin_action_cooldowns TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text)) WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: workspace_settings settings_read_org; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY settings_read_org ON public.workspace_settings FOR SELECT USING ((public.user_belongs_to_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: workspace_settings settings_update_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY settings_update_admin ON public.workspace_settings FOR UPDATE TO authenticated, service_role USING (((EXISTS ( SELECT 1
   FROM public.org_memberships
  WHERE ((org_memberships.org_id = workspace_settings.org_id) AND (org_memberships.user_id = ( SELECT auth.uid() AS uid)) AND (org_memberships.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: workspace_settings settings_write_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY settings_write_admin ON public.workspace_settings FOR INSERT TO authenticated, service_role WITH CHECK (((EXISTS ( SELECT 1
   FROM public.org_memberships
  WHERE ((org_memberships.org_id = workspace_settings.org_id) AND (org_memberships.user_id = ( SELECT auth.uid() AS uid)) AND (org_memberships.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: community_post_signoff_requests signoff_decide; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY signoff_decide ON public.community_post_signoff_requests FOR UPDATE TO authenticated, service_role USING (((EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.verifier_status = 'active'::text)))) OR ( SELECT public.is_platform_admin() AS is_platform_admin)));


--
-- Name: community_post_signoff_requests signoff_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY signoff_insert ON public.community_post_signoff_requests FOR INSERT TO authenticated, service_role WITH CHECK (((requested_by = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1
   FROM (public.community_posts cp
     JOIN public.community_group_members m ON ((m.group_id = cp.group_id)))
  WHERE ((cp.id = community_post_signoff_requests.post_id) AND (m.user_id = ( SELECT auth.uid() AS uid)))))));


--
-- Name: community_post_signoff_requests signoff_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY signoff_select ON public.community_post_signoff_requests FOR SELECT USING (((requested_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.profiles p
  WHERE ((p.id = auth.uid()) AND (p.verifier_status = 'active'::text)))) OR ( SELECT public.is_platform_admin() AS is_platform_admin)));


--
-- Name: community_post_signoff_requests signoff_withdraw_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY signoff_withdraw_own ON public.community_post_signoff_requests FOR UPDATE TO authenticated, service_role USING (((requested_by = ( SELECT auth.uid() AS uid)) AND (status = 'pending'::text))) WITH CHECK (((requested_by = ( SELECT auth.uid() AS uid)) AND (status = 'withdrawn'::text)));


--
-- Name: signposts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.signposts ENABLE ROW LEVEL SECURITY;

--
-- Name: signposts signposts_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY signposts_read ON public.signposts FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: source_bias_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_bias_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: source_citations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_citations ENABLE ROW LEVEL SECURITY;

--
-- Name: source_citations source_citations_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY source_citations_admin_write ON public.source_citations FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: source_citations source_citations_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY source_citations_read ON public.source_citations FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: source_reliability_ledger; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_reliability_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: source_tier_opinions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_tier_opinions ENABLE ROW LEVEL SECURITY;

--
-- Name: source_tier_opinions source_tier_opinions_select_platform_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY source_tier_opinions_select_platform_admin ON public.source_tier_opinions FOR SELECT USING (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: source_tier_opinions source_tier_opinions_update_platform_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY source_tier_opinions_update_platform_admin ON public.source_tier_opinions FOR UPDATE TO authenticated, service_role USING (( SELECT public.is_platform_admin() AS is_platform_admin)) WITH CHECK (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: source_trust_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_trust_events ENABLE ROW LEVEL SECURITY;

--
-- Name: source_trust_events source_trust_events_admin_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY source_trust_events_admin_insert ON public.source_trust_events FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: source_trust_events source_trust_events_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY source_trust_events_read ON public.source_trust_events FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: source_verifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.source_verifications ENABLE ROW LEVEL SECURITY;

--
-- Name: source_verifications source_verifications_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY source_verifications_read ON public.source_verifications FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: sources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;

--
-- Name: sources sources_admin_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sources_admin_delete ON public.sources FOR DELETE TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: sources sources_admin_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sources_admin_insert ON public.sources FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: sources sources_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sources_admin_update ON public.sources FOR UPDATE TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: sources sources_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY sources_read ON public.sources FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: staged_updates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.staged_updates ENABLE ROW LEVEL SECURITY;

--
-- Name: staged_updates staged_updates_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY staged_updates_admin_update ON public.staged_updates FOR UPDATE TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: staged_updates staged_updates_admin_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY staged_updates_admin_write ON public.staged_updates FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: state_cost_facts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.state_cost_facts ENABLE ROW LEVEL SECURITY;

--
-- Name: state_cost_facts state_cost_facts_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY state_cost_facts_read ON public.state_cost_facts FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: statutory_computations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.statutory_computations ENABLE ROW LEVEL SECURITY;

--
-- Name: statutory_computations statutory_computations_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY statutory_computations_read ON public.statutory_computations FOR SELECT TO authenticated USING (true);


--
-- Name: intelligence_summaries summaries_read_authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY summaries_read_authenticated ON public.intelligence_summaries FOR SELECT USING (((( SELECT auth.role() AS role) = 'authenticated'::text) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: intelligence_summaries summaries_update_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY summaries_update_service ON public.intelligence_summaries FOR UPDATE TO authenticated, service_role USING ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: intelligence_summaries summaries_write_service; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY summaries_write_service ON public.intelligence_summaries FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));


--
-- Name: system_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_state ENABLE ROW LEVEL SECURITY;

--
-- Name: system_state_flag_audit; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_state_flag_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: theme_briefs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.theme_briefs ENABLE ROW LEVEL SECURITY;

--
-- Name: theme_briefs theme_briefs_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY theme_briefs_read ON public.theme_briefs FOR SELECT TO authenticated, service_role USING (true);


--
-- Name: user_item_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_item_state ENABLE ROW LEVEL SECURITY;

--
-- Name: user_item_state user_item_state_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_item_state_delete ON public.user_item_state FOR DELETE TO authenticated, service_role USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_item_state user_item_state_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_item_state_insert ON public.user_item_state FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_item_state user_item_state_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_item_state_select ON public.user_item_state FOR SELECT USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_item_state user_item_state_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_item_state_update ON public.user_item_state FOR UPDATE TO authenticated, service_role USING ((( SELECT auth.uid() AS uid) = user_id)) WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_watchlist; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_watchlist ENABLE ROW LEVEL SECURITY;

--
-- Name: user_watchlist user_watchlist_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_watchlist_delete ON public.user_watchlist FOR DELETE TO authenticated, service_role USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_watchlist user_watchlist_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_watchlist_insert ON public.user_watchlist FOR INSERT TO authenticated, service_role WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_watchlist user_watchlist_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_watchlist_select ON public.user_watchlist FOR SELECT USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: vocabulary_mentions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vocabulary_mentions ENABLE ROW LEVEL SECURITY;

--
-- Name: vocabulary_mentions vocabulary_mentions_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vocabulary_mentions_admin_read ON public.vocabulary_mentions FOR SELECT USING (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: vocabulary_terms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.vocabulary_terms ENABLE ROW LEVEL SECURITY;

--
-- Name: vocabulary_terms vocabulary_terms_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY vocabulary_terms_admin_read ON public.vocabulary_terms FOR SELECT USING (( SELECT public.is_platform_admin() AS is_platform_admin));


--
-- Name: workspace_item_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_item_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_tags workspace_tags_org_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspace_tags_org_delete ON public.workspace_tags FOR DELETE TO authenticated, service_role USING ((public.user_can_write_in_org(org_id) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: workspace_tags workspace_tags_org_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspace_tags_org_insert ON public.workspace_tags FOR INSERT TO authenticated, service_role WITH CHECK (((public.user_can_write_in_org(org_id) AND (created_by = ( SELECT auth.uid() AS uid))) OR (( SELECT auth.role() AS role) = 'service_role'::text)));


--
-- Name: workspace_tags workspace_tags_org_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY workspace_tags_org_read ON public.workspace_tags FOR SELECT USING ((public.user_belongs_to_org(org_id) OR (auth.role() = 'service_role'::text)));


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA public TO reconciler;


--
-- Name: FUNCTION _assert_org_membership(p_org_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public._assert_org_membership(p_org_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public._assert_org_membership(p_org_id uuid) TO service_role;


--
-- Name: FUNCTION _classify_jurisdiction_token(token text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public._classify_jurisdiction_token(token text) TO anon;
GRANT ALL ON FUNCTION public._classify_jurisdiction_token(token text) TO authenticated;
GRANT ALL ON FUNCTION public._classify_jurisdiction_token(token text) TO service_role;


--
-- Name: FUNCTION _derive_jurisdiction_iso_from_canonical(canonical_jurisdictions text[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public._derive_jurisdiction_iso_from_canonical(canonical_jurisdictions text[]) TO anon;
GRANT ALL ON FUNCTION public._derive_jurisdiction_iso_from_canonical(canonical_jurisdictions text[]) TO authenticated;
GRANT ALL ON FUNCTION public._derive_jurisdiction_iso_from_canonical(canonical_jurisdictions text[]) TO service_role;


--
-- Name: FUNCTION _guard_source_archive(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public._guard_source_archive() TO anon;
GRANT ALL ON FUNCTION public._guard_source_archive() TO authenticated;
GRANT ALL ON FUNCTION public._guard_source_archive() TO service_role;


--
-- Name: FUNCTION _intelligence_items_normalize_jurisdictions(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public._intelligence_items_normalize_jurisdictions() FROM PUBLIC;
GRANT ALL ON FUNCTION public._intelligence_items_normalize_jurisdictions() TO service_role;


--
-- Name: FUNCTION _normalize_jurisdictions(input text[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public._normalize_jurisdictions(input text[]) TO anon;
GRANT ALL ON FUNCTION public._normalize_jurisdictions(input text[]) TO authenticated;
GRANT ALL ON FUNCTION public._normalize_jurisdictions(input text[]) TO service_role;


--
-- Name: FUNCTION _url_host(u text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public._url_host(u text) TO anon;
GRANT ALL ON FUNCTION public._url_host(u text) TO authenticated;
GRANT ALL ON FUNCTION public._url_host(u text) TO service_role;


--
-- Name: FUNCTION _workspace_active_items(p_org_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public._workspace_active_items(p_org_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public._workspace_active_items(p_org_id uuid) TO service_role;


--
-- Name: FUNCTION accept_invitation(p_token text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.accept_invitation(p_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.accept_invitation(p_token text) TO authenticated;
GRANT ALL ON FUNCTION public.accept_invitation(p_token text) TO service_role;


--
-- Name: FUNCTION acquire_funded_pass_lock(p_key text, p_label text, p_pid integer, p_host text, p_worklist text, p_stale_seconds integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.acquire_funded_pass_lock(p_key text, p_label text, p_pid integer, p_host text, p_worklist text, p_stale_seconds integer) TO anon;
GRANT ALL ON FUNCTION public.acquire_funded_pass_lock(p_key text, p_label text, p_pid integer, p_host text, p_worklist text, p_stale_seconds integer) TO authenticated;
GRANT ALL ON FUNCTION public.acquire_funded_pass_lock(p_key text, p_label text, p_pid integer, p_host text, p_worklist text, p_stale_seconds integer) TO service_role;


--
-- Name: FUNCTION acquire_mutation_lease(p_item uuid, p_holder text, p_lane text, p_stale_seconds integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.acquire_mutation_lease(p_item uuid, p_holder text, p_lane text, p_stale_seconds integer) TO anon;
GRANT ALL ON FUNCTION public.acquire_mutation_lease(p_item uuid, p_holder text, p_lane text, p_stale_seconds integer) TO authenticated;
GRANT ALL ON FUNCTION public.acquire_mutation_lease(p_item uuid, p_holder text, p_lane text, p_stale_seconds integer) TO service_role;


--
-- Name: FUNCTION admin_attention_counts(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_attention_counts() TO anon;
GRANT ALL ON FUNCTION public.admin_attention_counts() TO authenticated;
GRANT ALL ON FUNCTION public.admin_attention_counts() TO service_role;


--
-- Name: TABLE system_state; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.system_state TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.system_state TO authenticated;
GRANT ALL ON TABLE public.system_state TO service_role;


--
-- Name: FUNCTION admin_set_judgement_drain(p_actor text, p_state text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_set_judgement_drain(p_actor text, p_state text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_set_judgement_drain(p_actor text, p_state text) TO service_role;


--
-- Name: FUNCTION admin_set_pause_state(p_actor text, p_paused boolean, p_cadence text, p_start_date date, p_clear_start boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.admin_set_pause_state(p_actor text, p_paused boolean, p_cadence text, p_start_date date, p_clear_start boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.admin_set_pause_state(p_actor text, p_paused boolean, p_cadence text, p_start_date date, p_clear_start boolean) TO service_role;


--
-- Name: FUNCTION agent_run_searches_set_result_chars(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.agent_run_searches_set_result_chars() TO anon;
GRANT ALL ON FUNCTION public.agent_run_searches_set_result_chars() TO authenticated;
GRANT ALL ON FUNCTION public.agent_run_searches_set_result_chars() TO service_role;


--
-- Name: FUNCTION assert_acyclic(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.assert_acyclic() TO anon;
GRANT ALL ON FUNCTION public.assert_acyclic() TO authenticated;
GRANT ALL ON FUNCTION public.assert_acyclic() TO service_role;


--
-- Name: FUNCTION assert_statutory_purity(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.assert_statutory_purity() TO anon;
GRANT ALL ON FUNCTION public.assert_statutory_purity() TO authenticated;
GRANT ALL ON FUNCTION public.assert_statutory_purity() TO service_role;


--
-- Name: FUNCTION backfill_market_series_entity(p_entity_id text, p_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.backfill_market_series_entity(p_entity_id text, p_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.backfill_market_series_entity(p_entity_id text, p_ids uuid[]) TO service_role;


--
-- Name: FUNCTION bucket_value(p_value numeric, p_scheme text, p_multiplier numeric); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bucket_value(p_value numeric, p_scheme text, p_multiplier numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bucket_value(p_value numeric, p_scheme text, p_multiplier numeric) TO anon;
GRANT ALL ON FUNCTION public.bucket_value(p_value numeric, p_scheme text, p_multiplier numeric) TO authenticated;
GRANT ALL ON FUNCTION public.bucket_value(p_value numeric, p_scheme text, p_multiplier numeric) TO service_role;


--
-- Name: FUNCTION bucket_width_multiplier(p_n integer, p_k_min integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.bucket_width_multiplier(p_n integer, p_k_min integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.bucket_width_multiplier(p_n integer, p_k_min integer) TO anon;
GRANT ALL ON FUNCTION public.bucket_width_multiplier(p_n integer, p_k_min integer) TO authenticated;
GRANT ALL ON FUNCTION public.bucket_width_multiplier(p_n integer, p_k_min integer) TO service_role;


--
-- Name: FUNCTION canonicalize_citation_url(u text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.canonicalize_citation_url(u text) TO anon;
GRANT ALL ON FUNCTION public.canonicalize_citation_url(u text) TO authenticated;
GRANT ALL ON FUNCTION public.canonicalize_citation_url(u text) TO service_role;


--
-- Name: FUNCTION capture_worker_fetch(queue_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.capture_worker_fetch(queue_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.capture_worker_fetch(queue_ids uuid[]) TO service_role;


--
-- Name: FUNCTION census_worklist_guarded_update(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.census_worklist_guarded_update() TO anon;
GRANT ALL ON FUNCTION public.census_worklist_guarded_update() TO authenticated;
GRANT ALL ON FUNCTION public.census_worklist_guarded_update() TO service_role;


--
-- Name: FUNCTION census_worklist_no_delete(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.census_worklist_no_delete() TO anon;
GRANT ALL ON FUNCTION public.census_worklist_no_delete() TO authenticated;
GRANT ALL ON FUNCTION public.census_worklist_no_delete() TO service_role;


--
-- Name: FUNCTION cl_corridor_field(v text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cl_corridor_field(v text) TO anon;
GRANT ALL ON FUNCTION public.cl_corridor_field(v text) TO authenticated;
GRANT ALL ON FUNCTION public.cl_corridor_field(v text) TO service_role;


--
-- Name: FUNCTION cl_corridor_id(p_origin text, p_dest text, p_mode text, p_leg_ordinal integer, p_routing_key text, p_via text[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cl_corridor_id(p_origin text, p_dest text, p_mode text, p_leg_ordinal integer, p_routing_key text, p_via text[]) TO anon;
GRANT ALL ON FUNCTION public.cl_corridor_id(p_origin text, p_dest text, p_mode text, p_leg_ordinal integer, p_routing_key text, p_via text[]) TO authenticated;
GRANT ALL ON FUNCTION public.cl_corridor_id(p_origin text, p_dest text, p_mode text, p_leg_ordinal integer, p_routing_key text, p_via text[]) TO service_role;


--
-- Name: FUNCTION community_groups_owner_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.community_groups_owner_guard() TO anon;
GRANT ALL ON FUNCTION public.community_groups_owner_guard() TO authenticated;
GRANT ALL ON FUNCTION public.community_groups_owner_guard() TO service_role;


--
-- Name: FUNCTION community_identity(p_ids uuid[], p_query text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.community_identity(p_ids uuid[], p_query text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.community_identity(p_ids uuid[], p_query text) TO authenticated;
GRANT ALL ON FUNCTION public.community_identity(p_ids uuid[], p_query text) TO service_role;


--
-- Name: FUNCTION community_member_profiles_verification_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.community_member_profiles_verification_guard() TO anon;
GRANT ALL ON FUNCTION public.community_member_profiles_verification_guard() TO authenticated;
GRANT ALL ON FUNCTION public.community_member_profiles_verification_guard() TO service_role;


--
-- Name: FUNCTION community_post_signoff_requests_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.community_post_signoff_requests_guard() TO anon;
GRANT ALL ON FUNCTION public.community_post_signoff_requests_guard() TO authenticated;
GRANT ALL ON FUNCTION public.community_post_signoff_requests_guard() TO service_role;


--
-- Name: FUNCTION community_posts_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.community_posts_guard() TO anon;
GRANT ALL ON FUNCTION public.community_posts_guard() TO authenticated;
GRANT ALL ON FUNCTION public.community_posts_guard() TO service_role;


--
-- Name: FUNCTION community_region_counts(p_privacy text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.community_region_counts(p_privacy text) TO anon;
GRANT ALL ON FUNCTION public.community_region_counts(p_privacy text) TO authenticated;
GRANT ALL ON FUNCTION public.community_region_counts(p_privacy text) TO service_role;


--
-- Name: FUNCTION coverage_matrix(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.coverage_matrix() TO anon;
GRANT ALL ON FUNCTION public.coverage_matrix() TO authenticated;
GRANT ALL ON FUNCTION public.coverage_matrix() TO service_role;


--
-- Name: FUNCTION create_item_correction(p_item_id uuid, p_target_kind text, p_target_ref text, p_op text, p_value jsonb, p_reason text, p_created_by uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_item_correction(p_item_id uuid, p_target_kind text, p_target_ref text, p_op text, p_value jsonb, p_reason text, p_created_by uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_item_correction(p_item_id uuid, p_target_kind text, p_target_ref text, p_op text, p_value jsonb, p_reason text, p_created_by uuid) TO service_role;


--
-- Name: FUNCTION create_org_for_self(p_org_name text, p_org_slug text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_org_for_self(p_org_name text, p_org_slug text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_org_for_self(p_org_name text, p_org_slug text) TO authenticated;
GRANT ALL ON FUNCTION public.create_org_for_self(p_org_name text, p_org_slug text) TO service_role;


--
-- Name: FUNCTION decline_invitation(p_token text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.decline_invitation(p_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.decline_invitation(p_token text) TO authenticated;
GRANT ALL ON FUNCTION public.decline_invitation(p_token text) TO service_role;


--
-- Name: FUNCTION derive_canonical_instrument_key(p_instr text, p_src_url text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.derive_canonical_instrument_key(p_instr text, p_src_url text) TO anon;
GRANT ALL ON FUNCTION public.derive_canonical_instrument_key(p_instr text, p_src_url text) TO authenticated;
GRANT ALL ON FUNCTION public.derive_canonical_instrument_key(p_instr text, p_src_url text) TO service_role;


--
-- Name: FUNCTION derive_source_category(p_role text, p_name text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.derive_source_category(p_role text, p_name text) TO anon;
GRANT ALL ON FUNCTION public.derive_source_category(p_role text, p_name text) TO authenticated;
GRANT ALL ON FUNCTION public.derive_source_category(p_role text, p_name text) TO service_role;


--
-- Name: FUNCTION derive_source_intelligence_types(p_category text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.derive_source_intelligence_types(p_category text) TO anon;
GRANT ALL ON FUNCTION public.derive_source_intelligence_types(p_category text) TO authenticated;
GRANT ALL ON FUNCTION public.derive_source_intelligence_types(p_category text) TO service_role;


--
-- Name: FUNCTION effective_confidence(base numeric, asserted_at timestamp with time zone, half_life_days integer, now_ts timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.effective_confidence(base numeric, asserted_at timestamp with time zone, half_life_days integer, now_ts timestamp with time zone) TO anon;
GRANT ALL ON FUNCTION public.effective_confidence(base numeric, asserted_at timestamp with time zone, half_life_days integer, now_ts timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.effective_confidence(base numeric, asserted_at timestamp with time zone, half_life_days integer, now_ts timestamp with time zone) TO service_role;


--
-- Name: FUNCTION emission_factors_append_only(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.emission_factors_append_only() TO anon;
GRANT ALL ON FUNCTION public.emission_factors_append_only() TO authenticated;
GRANT ALL ON FUNCTION public.emission_factors_append_only() TO service_role;


--
-- Name: FUNCTION emit_propagation_event(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.emit_propagation_event() TO anon;
GRANT ALL ON FUNCTION public.emit_propagation_event() TO authenticated;
GRANT ALL ON FUNCTION public.emit_propagation_event() TO service_role;


--
-- Name: FUNCTION emit_propagation_events_for_region(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.emit_propagation_events_for_region() FROM PUBLIC;
GRANT ALL ON FUNCTION public.emit_propagation_events_for_region() TO anon;
GRANT ALL ON FUNCTION public.emit_propagation_events_for_region() TO authenticated;
GRANT ALL ON FUNCTION public.emit_propagation_events_for_region() TO service_role;


--
-- Name: FUNCTION enqueue_corpus_turn_request(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enqueue_corpus_turn_request() TO anon;
GRANT ALL ON FUNCTION public.enqueue_corpus_turn_request() TO authenticated;
GRANT ALL ON FUNCTION public.enqueue_corpus_turn_request() TO service_role;


--
-- Name: FUNCTION enqueue_pending_first_fetch(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enqueue_pending_first_fetch() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enqueue_pending_first_fetch() TO service_role;


--
-- Name: FUNCTION entity_aliases_refuse_change(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.entity_aliases_refuse_change() FROM PUBLIC;
GRANT ALL ON FUNCTION public.entity_aliases_refuse_change() TO anon;
GRANT ALL ON FUNCTION public.entity_aliases_refuse_change() TO authenticated;
GRANT ALL ON FUNCTION public.entity_aliases_refuse_change() TO service_role;


--
-- Name: FUNCTION entity_relations_refuse_cycle(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.entity_relations_refuse_cycle() FROM PUBLIC;
GRANT ALL ON FUNCTION public.entity_relations_refuse_cycle() TO anon;
GRANT ALL ON FUNCTION public.entity_relations_refuse_cycle() TO authenticated;
GRANT ALL ON FUNCTION public.entity_relations_refuse_cycle() TO service_role;


--
-- Name: FUNCTION gate_a_health(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.gate_a_health() FROM PUBLIC;
GRANT ALL ON FUNCTION public.gate_a_health() TO service_role;


--
-- Name: FUNCTION gate_a_health_compute(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.gate_a_health_compute() TO anon;
GRANT ALL ON FUNCTION public.gate_a_health_compute() TO authenticated;
GRANT ALL ON FUNCTION public.gate_a_health_compute() TO service_role;


--
-- Name: FUNCTION gate_a_health_refresh(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.gate_a_health_refresh() FROM PUBLIC;
GRANT ALL ON FUNCTION public.gate_a_health_refresh() TO service_role;


--
-- Name: FUNCTION get_all_surface_counts(p_org_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_all_surface_counts(p_org_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_all_surface_counts(p_org_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_all_surface_counts(p_org_id uuid) TO service_role;


--
-- Name: FUNCTION get_market_intel_items(p_org_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_market_intel_items(p_org_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_market_intel_items(p_org_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_market_intel_items(p_org_id uuid) TO service_role;


--
-- Name: FUNCTION get_market_intel_items_public(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_market_intel_items_public() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_market_intel_items_public() TO anon;
GRANT ALL ON FUNCTION public.get_market_intel_items_public() TO authenticated;
GRANT ALL ON FUNCTION public.get_market_intel_items_public() TO service_role;


--
-- Name: FUNCTION get_operations_items_public(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_operations_items_public() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_operations_items_public() TO anon;
GRANT ALL ON FUNCTION public.get_operations_items_public() TO authenticated;
GRANT ALL ON FUNCTION public.get_operations_items_public() TO service_role;


--
-- Name: FUNCTION get_research_items_public(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_research_items_public() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_research_items_public() TO anon;
GRANT ALL ON FUNCTION public.get_research_items_public() TO authenticated;
GRANT ALL ON FUNCTION public.get_research_items_public() TO service_role;


--
-- Name: FUNCTION get_research_source_coverage(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_research_source_coverage() TO anon;
GRANT ALL ON FUNCTION public.get_research_source_coverage() TO authenticated;
GRANT ALL ON FUNCTION public.get_research_source_coverage() TO service_role;


--
-- Name: FUNCTION get_source_citation_stats(source_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_source_citation_stats(source_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.get_source_citation_stats(source_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.get_source_citation_stats(source_ids uuid[]) TO service_role;


--
-- Name: FUNCTION get_surface_counts(p_org_id uuid, p_surface text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_surface_counts(p_org_id uuid, p_surface text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_surface_counts(p_org_id uuid, p_surface text) TO authenticated;
GRANT ALL ON FUNCTION public.get_surface_counts(p_org_id uuid, p_surface text) TO service_role;


--
-- Name: FUNCTION get_tier_opinion_disagreements(window_days integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_tier_opinion_disagreements(window_days integer) TO anon;
GRANT ALL ON FUNCTION public.get_tier_opinion_disagreements(window_days integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_tier_opinion_disagreements(window_days integer) TO service_role;


--
-- Name: FUNCTION get_workspace_due_next(p_org_id uuid, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_workspace_due_next(p_org_id uuid, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_workspace_due_next(p_org_id uuid, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_workspace_due_next(p_org_id uuid, p_limit integer) TO service_role;


--
-- Name: FUNCTION get_workspace_intelligence(p_org_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_workspace_intelligence(p_org_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_workspace_intelligence(p_org_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_workspace_intelligence(p_org_id uuid) TO service_role;


--
-- Name: FUNCTION get_workspace_intelligence_aggregates(p_org_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_workspace_intelligence_aggregates(p_org_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_aggregates(p_org_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_aggregates(p_org_id uuid) TO service_role;


--
-- Name: FUNCTION get_workspace_intelligence_aggregates_scoped(p_org_id uuid, p_scope_filter jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_workspace_intelligence_aggregates_scoped(p_org_id uuid, p_scope_filter jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_aggregates_scoped(p_org_id uuid, p_scope_filter jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_aggregates_scoped(p_org_id uuid, p_scope_filter jsonb) TO service_role;


--
-- Name: FUNCTION get_workspace_intelligence_dashboard(p_org_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_workspace_intelligence_dashboard(p_org_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_dashboard(p_org_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_dashboard(p_org_id uuid) TO service_role;


--
-- Name: FUNCTION get_workspace_intelligence_listings(p_org_id uuid, p_domain integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_workspace_intelligence_listings(p_org_id uuid, p_domain integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_listings(p_org_id uuid, p_domain integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_listings(p_org_id uuid, p_domain integer) TO service_role;


--
-- Name: FUNCTION get_workspace_intelligence_listings_public(p_domain integer, p_after_priority text, p_after_added_date date, p_after_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_workspace_intelligence_listings_public(p_domain integer, p_after_priority text, p_after_added_date date, p_after_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_listings_public(p_domain integer, p_after_priority text, p_after_added_date date, p_after_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_listings_public(p_domain integer, p_after_priority text, p_after_added_date date, p_after_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_listings_public(p_domain integer, p_after_priority text, p_after_added_date date, p_after_id uuid) TO service_role;


--
-- Name: FUNCTION get_workspace_intelligence_slim(p_org_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_workspace_intelligence_slim(p_org_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_slim(p_org_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_slim(p_org_id uuid) TO service_role;


--
-- Name: FUNCTION get_workspace_intelligence_slim_public(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_workspace_intelligence_slim_public() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_slim_public() TO anon;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_slim_public() TO authenticated;
GRANT ALL ON FUNCTION public.get_workspace_intelligence_slim_public() TO service_role;


--
-- Name: FUNCTION get_workspace_recent_changes(p_org_id uuid, p_days integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_workspace_recent_changes(p_org_id uuid, p_days integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_workspace_recent_changes(p_org_id uuid, p_days integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_workspace_recent_changes(p_org_id uuid, p_days integer) TO service_role;


--
-- Name: FUNCTION guard_data_audit_block(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.guard_data_audit_block() TO anon;
GRANT ALL ON FUNCTION public.guard_data_audit_block() TO authenticated;
GRANT ALL ON FUNCTION public.guard_data_audit_block() TO service_role;


--
-- Name: FUNCTION guard_judgement_drain_writer(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.guard_judgement_drain_writer() TO anon;
GRANT ALL ON FUNCTION public.guard_judgement_drain_writer() TO authenticated;
GRANT ALL ON FUNCTION public.guard_judgement_drain_writer() TO service_role;


--
-- Name: FUNCTION guard_pause_flag_writer(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.guard_pause_flag_writer() TO anon;
GRANT ALL ON FUNCTION public.guard_pause_flag_writer() TO authenticated;
GRANT ALL ON FUNCTION public.guard_pause_flag_writer() TO service_role;


--
-- Name: FUNCTION guard_provenance_flip(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.guard_provenance_flip() TO anon;
GRANT ALL ON FUNCTION public.guard_provenance_flip() TO authenticated;
GRANT ALL ON FUNCTION public.guard_provenance_flip() TO service_role;


--
-- Name: FUNCTION heartbeat_funded_pass_lock(p_key text, p_pid integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.heartbeat_funded_pass_lock(p_key text, p_pid integer) TO anon;
GRANT ALL ON FUNCTION public.heartbeat_funded_pass_lock(p_key text, p_pid integer) TO authenticated;
GRANT ALL ON FUNCTION public.heartbeat_funded_pass_lock(p_key text, p_pid integer) TO service_role;


--
-- Name: FUNCTION heartbeat_mutation_lease(p_item uuid, p_holder text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.heartbeat_mutation_lease(p_item uuid, p_holder text) TO anon;
GRANT ALL ON FUNCTION public.heartbeat_mutation_lease(p_item uuid, p_holder text) TO authenticated;
GRANT ALL ON FUNCTION public.heartbeat_mutation_lease(p_item uuid, p_holder text) TO service_role;


--
-- Name: FUNCTION intelligence_items_theme_guard(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.intelligence_items_theme_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.intelligence_items_theme_guard() TO service_role;


--
-- Name: FUNCTION invalidate_dependents(p_table text, p_pk text, p_event bigint, p_apply boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.invalidate_dependents(p_table text, p_pk text, p_event bigint, p_apply boolean) TO anon;
GRANT ALL ON FUNCTION public.invalidate_dependents(p_table text, p_pk text, p_event bigint, p_apply boolean) TO authenticated;
GRANT ALL ON FUNCTION public.invalidate_dependents(p_table text, p_pk text, p_event bigint, p_apply boolean) TO service_role;


--
-- Name: FUNCTION is_platform_admin(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_platform_admin() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_platform_admin() TO anon;
GRANT ALL ON FUNCTION public.is_platform_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_platform_admin() TO service_role;


--
-- Name: FUNCTION is_sanctioned_writer(p_rel regclass); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_sanctioned_writer(p_rel regclass) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_sanctioned_writer(p_rel regclass) TO anon;
GRANT ALL ON FUNCTION public.is_sanctioned_writer(p_rel regclass) TO authenticated;
GRANT ALL ON FUNCTION public.is_sanctioned_writer(p_rel regclass) TO service_role;


--
-- Name: FUNCTION item_assignments_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.item_assignments_guard() TO anon;
GRANT ALL ON FUNCTION public.item_assignments_guard() TO authenticated;
GRANT ALL ON FUNCTION public.item_assignments_guard() TO service_role;


--
-- Name: FUNCTION item_corrections_append_only(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.item_corrections_append_only() TO anon;
GRANT ALL ON FUNCTION public.item_corrections_append_only() TO authenticated;
GRANT ALL ON FUNCTION public.item_corrections_append_only() TO service_role;


--
-- Name: FUNCTION item_corrections_apply_claims(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.item_corrections_apply_claims() FROM PUBLIC;
GRANT ALL ON FUNCTION public.item_corrections_apply_claims() TO service_role;


--
-- Name: FUNCTION item_corrections_apply_items(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.item_corrections_apply_items() FROM PUBLIC;
GRANT ALL ON FUNCTION public.item_corrections_apply_items() TO service_role;


--
-- Name: FUNCTION item_corrections_apply_sections(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.item_corrections_apply_sections() FROM PUBLIC;
GRANT ALL ON FUNCTION public.item_corrections_apply_sections() TO service_role;


--
-- Name: FUNCTION item_corrections_before_insert(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.item_corrections_before_insert() FROM PUBLIC;
GRANT ALL ON FUNCTION public.item_corrections_before_insert() TO service_role;


--
-- Name: FUNCTION item_corrections_block_tombstoned_edge(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.item_corrections_block_tombstoned_edge() FROM PUBLIC;
GRANT ALL ON FUNCTION public.item_corrections_block_tombstoned_edge() TO service_role;


--
-- Name: TABLE item_corrections; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.item_corrections TO anon;
GRANT SELECT ON TABLE public.item_corrections TO authenticated;
GRANT ALL ON TABLE public.item_corrections TO service_role;


--
-- Name: FUNCTION item_corrections_latest(p_item_id uuid, p_kind text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.item_corrections_latest(p_item_id uuid, p_kind text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.item_corrections_latest(p_item_id uuid, p_kind text) TO service_role;


--
-- Name: FUNCTION item_corrections_note(p_correction_id uuid, p_machine_value jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.item_corrections_note(p_correction_id uuid, p_machine_value jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.item_corrections_note(p_correction_id uuid, p_machine_value jsonb) TO service_role;


--
-- Name: FUNCTION item_corrections_pair_tombstoned(p_a uuid, p_b uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.item_corrections_pair_tombstoned(p_a uuid, p_b uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.item_corrections_pair_tombstoned(p_a uuid, p_b uuid) TO service_role;


--
-- Name: FUNCTION item_corrections_patch(p_item_id uuid, p_table text, p_row jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.item_corrections_patch(p_item_id uuid, p_table text, p_row jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.item_corrections_patch(p_item_id uuid, p_table text, p_row jsonb) TO service_role;


--
-- Name: FUNCTION item_corrections_span_is_verbatim(p_item_id uuid, p_search_result_id uuid, p_span text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.item_corrections_span_is_verbatim(p_item_id uuid, p_search_result_id uuid, p_span text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.item_corrections_span_is_verbatim(p_item_id uuid, p_search_result_id uuid, p_span text) TO service_role;


--
-- Name: FUNCTION item_notes_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.item_notes_guard() TO anon;
GRANT ALL ON FUNCTION public.item_notes_guard() TO authenticated;
GRANT ALL ON FUNCTION public.item_notes_guard() TO service_role;


--
-- Name: FUNCTION lookup_invitation(p_token text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.lookup_invitation(p_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.lookup_invitation(p_token text) TO authenticated;
GRANT ALL ON FUNCTION public.lookup_invitation(p_token text) TO service_role;


--
-- Name: FUNCTION move_override_notes_to_item_notes(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.move_override_notes_to_item_notes() FROM PUBLIC;
GRANT ALL ON FUNCTION public.move_override_notes_to_item_notes() TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT DELETE ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: COLUMN profiles.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id),INSERT(id),UPDATE(id) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.email; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(email),UPDATE(email) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.display_name; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(display_name),INSERT(display_name),UPDATE(display_name) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.role; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(role) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.settings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(settings),INSERT(settings),UPDATE(settings) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_at),INSERT(created_at),UPDATE(created_at) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(updated_at),INSERT(updated_at),UPDATE(updated_at) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.full_name; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(full_name),INSERT(full_name),UPDATE(full_name) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.headline; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(headline),INSERT(headline),UPDATE(headline) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.bio; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(bio),INSERT(bio),UPDATE(bio) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.avatar_url; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(avatar_url),INSERT(avatar_url),UPDATE(avatar_url) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.organization; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(organization),INSERT(organization),UPDATE(organization) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.job_title; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(job_title),INSERT(job_title),UPDATE(job_title) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.linkedin_url; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(linkedin_url),INSERT(linkedin_url),UPDATE(linkedin_url) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.linkedin_sub; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(linkedin_sub),INSERT(linkedin_sub),UPDATE(linkedin_sub) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.linkedin_verified; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(linkedin_verified) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.linkedin_identity_verified; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(linkedin_identity_verified) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.linkedin_workplace_verified; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(linkedin_workplace_verified) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.linkedin_verification_checked_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(linkedin_verification_checked_at) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.verification_tier; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(verification_tier) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.affiliation_type; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(affiliation_type),INSERT(affiliation_type),UPDATE(affiliation_type) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.region; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(region),INSERT(region),UPDATE(region) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.topic_interests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(topic_interests),INSERT(topic_interests),UPDATE(topic_interests) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.membership_tier; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(membership_tier) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.contribution_score; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(contribution_score) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.notification_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(notification_preferences),INSERT(notification_preferences),UPDATE(notification_preferences) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.last_active_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(last_active_at),INSERT(last_active_at),UPDATE(last_active_at) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.timezone; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(timezone),INSERT(timezone),UPDATE(timezone) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.sector_overrides; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(sector_overrides),INSERT(sector_overrides),UPDATE(sector_overrides) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.jurisdiction_overrides; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(jurisdiction_overrides),INSERT(jurisdiction_overrides),UPDATE(jurisdiction_overrides) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.transport_mode_overrides; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(transport_mode_overrides),INSERT(transport_mode_overrides),UPDATE(transport_mode_overrides) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.verifier_status; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(verifier_status) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.verifier_since; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(verifier_since) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.org_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(org_id) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.workspace_role; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(workspace_role) ON TABLE public.profiles TO authenticated;


--
-- Name: COLUMN profiles.sector; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(sector),INSERT(sector),UPDATE(sector) ON TABLE public.profiles TO authenticated;


--
-- Name: FUNCTION my_profile(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.my_profile() FROM PUBLIC;
GRANT ALL ON FUNCTION public.my_profile() TO authenticated;
GRANT ALL ON FUNCTION public.my_profile() TO service_role;


--
-- Name: FUNCTION next_uncensused_portal_candidates(p_source_id uuid, p_limit integer, p_newest boolean, p_after_first_seen timestamp with time zone, p_after_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.next_uncensused_portal_candidates(p_source_id uuid, p_limit integer, p_newest boolean, p_after_first_seen timestamp with time zone, p_after_id uuid) TO anon;
GRANT ALL ON FUNCTION public.next_uncensused_portal_candidates(p_source_id uuid, p_limit integer, p_newest boolean, p_after_first_seen timestamp with time zone, p_after_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.next_uncensused_portal_candidates(p_source_id uuid, p_limit integer, p_newest boolean, p_after_first_seen timestamp with time zone, p_after_id uuid) TO service_role;


--
-- Name: FUNCTION obligation_objects_guard(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.obligation_objects_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.obligation_objects_guard() TO service_role;


--
-- Name: FUNCTION org_membership_role_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.org_membership_role_guard() TO anon;
GRANT ALL ON FUNCTION public.org_membership_role_guard() TO authenticated;
GRANT ALL ON FUNCTION public.org_membership_role_guard() TO service_role;


--
-- Name: FUNCTION org_memberships_ban_guard(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.org_memberships_ban_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.org_memberships_ban_guard() TO service_role;


--
-- Name: FUNCTION organizations_plan_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.organizations_plan_guard() TO anon;
GRANT ALL ON FUNCTION public.organizations_plan_guard() TO authenticated;
GRANT ALL ON FUNCTION public.organizations_plan_guard() TO service_role;


--
-- Name: FUNCTION portfolio_members_cap(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.portfolio_members_cap() TO anon;
GRANT ALL ON FUNCTION public.portfolio_members_cap() TO authenticated;
GRANT ALL ON FUNCTION public.portfolio_members_cap() TO service_role;


--
-- Name: FUNCTION portfolios_org_cap(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.portfolios_org_cap() TO anon;
GRANT ALL ON FUNCTION public.portfolios_org_cap() TO authenticated;
GRANT ALL ON FUNCTION public.portfolios_org_cap() TO service_role;


--
-- Name: FUNCTION profiles_privilege_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.profiles_privilege_guard() TO anon;
GRANT ALL ON FUNCTION public.profiles_privilege_guard() TO authenticated;
GRANT ALL ON FUNCTION public.profiles_privilege_guard() TO service_role;


--
-- Name: FUNCTION publish_aggregate(p_table text, p_column text, p_cohort_filter jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.publish_aggregate(p_table text, p_column text, p_cohort_filter jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.publish_aggregate(p_table text, p_column text, p_cohort_filter jsonb) TO service_role;


--
-- Name: FUNCTION recompute_agent_integrity_flag(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.recompute_agent_integrity_flag() TO anon;
GRANT ALL ON FUNCTION public.recompute_agent_integrity_flag() TO authenticated;
GRANT ALL ON FUNCTION public.recompute_agent_integrity_flag() TO service_role;


--
-- Name: FUNCTION recompute_source_accuracy(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.recompute_source_accuracy() TO anon;
GRANT ALL ON FUNCTION public.recompute_source_accuracy() TO authenticated;
GRANT ALL ON FUNCTION public.recompute_source_accuracy() TO service_role;


--
-- Name: FUNCTION region_dimension_coverage_sync_fact_count(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.region_dimension_coverage_sync_fact_count() TO anon;
GRANT ALL ON FUNCTION public.region_dimension_coverage_sync_fact_count() TO authenticated;
GRANT ALL ON FUNCTION public.region_dimension_coverage_sync_fact_count() TO service_role;


--
-- Name: FUNCTION register_derived_value(p_entity_id text, p_method_id text, p_method_version text, p_value numeric, p_value_low numeric, p_value_high numeric, p_unit text, p_currency text, p_derivation text, p_origin_class text, p_lifecycle text, p_admissibility text, p_base_confidence numeric, p_asserted_at timestamp with time zone, p_half_life_days integer, p_inputs jsonb, p_computed_by text, p_supersedes uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.register_derived_value(p_entity_id text, p_method_id text, p_method_version text, p_value numeric, p_value_low numeric, p_value_high numeric, p_unit text, p_currency text, p_derivation text, p_origin_class text, p_lifecycle text, p_admissibility text, p_base_confidence numeric, p_asserted_at timestamp with time zone, p_half_life_days integer, p_inputs jsonb, p_computed_by text, p_supersedes uuid) TO anon;
GRANT ALL ON FUNCTION public.register_derived_value(p_entity_id text, p_method_id text, p_method_version text, p_value numeric, p_value_low numeric, p_value_high numeric, p_unit text, p_currency text, p_derivation text, p_origin_class text, p_lifecycle text, p_admissibility text, p_base_confidence numeric, p_asserted_at timestamp with time zone, p_half_life_days integer, p_inputs jsonb, p_computed_by text, p_supersedes uuid) TO authenticated;
GRANT ALL ON FUNCTION public.register_derived_value(p_entity_id text, p_method_id text, p_method_version text, p_value numeric, p_value_low numeric, p_value_high numeric, p_unit text, p_currency text, p_derivation text, p_origin_class text, p_lifecycle text, p_admissibility text, p_base_confidence numeric, p_asserted_at timestamp with time zone, p_half_life_days integer, p_inputs jsonb, p_computed_by text, p_supersedes uuid) TO service_role;


--
-- Name: FUNCTION register_inference_record(p_subject_id text, p_claim_text text, p_status_token text, p_confidence numeric, p_cited_item_ids uuid[], p_origin_class text, p_method_id text, p_method_version text, p_computed_by text, p_trigger_question_ref text, p_inputs jsonb, p_supersedes uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.register_inference_record(p_subject_id text, p_claim_text text, p_status_token text, p_confidence numeric, p_cited_item_ids uuid[], p_origin_class text, p_method_id text, p_method_version text, p_computed_by text, p_trigger_question_ref text, p_inputs jsonb, p_supersedes uuid) TO anon;
GRANT ALL ON FUNCTION public.register_inference_record(p_subject_id text, p_claim_text text, p_status_token text, p_confidence numeric, p_cited_item_ids uuid[], p_origin_class text, p_method_id text, p_method_version text, p_computed_by text, p_trigger_question_ref text, p_inputs jsonb, p_supersedes uuid) TO authenticated;
GRANT ALL ON FUNCTION public.register_inference_record(p_subject_id text, p_claim_text text, p_status_token text, p_confidence numeric, p_cited_item_ids uuid[], p_origin_class text, p_method_id text, p_method_version text, p_computed_by text, p_trigger_question_ref text, p_inputs jsonb, p_supersedes uuid) TO service_role;


--
-- Name: FUNCTION release_funded_pass_lock(p_key text, p_pid integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.release_funded_pass_lock(p_key text, p_pid integer) TO anon;
GRANT ALL ON FUNCTION public.release_funded_pass_lock(p_key text, p_pid integer) TO authenticated;
GRANT ALL ON FUNCTION public.release_funded_pass_lock(p_key text, p_pid integer) TO service_role;


--
-- Name: FUNCTION release_mutation_lease(p_item uuid, p_holder text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.release_mutation_lease(p_item uuid, p_holder text) TO anon;
GRANT ALL ON FUNCTION public.release_mutation_lease(p_item uuid, p_holder text) TO authenticated;
GRANT ALL ON FUNCTION public.release_mutation_lease(p_item uuid, p_holder text) TO service_role;


--
-- Name: FUNCTION reorder_user_list_item(p_user_id uuid, p_list_key text, p_item_id text, p_prev_item_id text, p_next_item_id text, p_seed_item_ids text[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reorder_user_list_item(p_user_id uuid, p_list_key text, p_item_id text, p_prev_item_id text, p_next_item_id text, p_seed_item_ids text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reorder_user_list_item(p_user_id uuid, p_list_key text, p_item_id text, p_prev_item_id text, p_next_item_id text, p_seed_item_ids text[]) TO service_role;


--
-- Name: FUNCTION request_verification(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.request_verification() FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_verification() TO authenticated;
GRANT ALL ON FUNCTION public.request_verification() TO service_role;


--
-- Name: FUNCTION revoke_invitation(p_invitation_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.revoke_invitation(p_invitation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.revoke_invitation(p_invitation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.revoke_invitation(p_invitation_id uuid) TO service_role;


--
-- Name: FUNCTION revoke_item_correction(p_item_id uuid, p_correction_id uuid, p_revoked_by uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.revoke_item_correction(p_item_id uuid, p_correction_id uuid, p_revoked_by uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.revoke_item_correction(p_item_id uuid, p_correction_id uuid, p_revoked_by uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION search_intelligence_items(q text, max_rows integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.search_intelligence_items(q text, max_rows integer) TO anon;
GRANT ALL ON FUNCTION public.search_intelligence_items(q text, max_rows integer) TO authenticated;
GRANT ALL ON FUNCTION public.search_intelligence_items(q text, max_rows integer) TO service_role;


--
-- Name: FUNCTION set_canonical_instrument_key(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_canonical_instrument_key() TO anon;
GRANT ALL ON FUNCTION public.set_canonical_instrument_key() TO authenticated;
GRANT ALL ON FUNCTION public.set_canonical_instrument_key() TO service_role;


--
-- Name: FUNCTION set_provenance_status(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_provenance_status() TO anon;
GRANT ALL ON FUNCTION public.set_provenance_status() TO authenticated;
GRANT ALL ON FUNCTION public.set_provenance_status() TO service_role;


--
-- Name: FUNCTION set_source_label(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_source_label() TO anon;
GRANT ALL ON FUNCTION public.set_source_label() TO authenticated;
GRANT ALL ON FUNCTION public.set_source_label() TO service_role;


--
-- Name: FUNCTION source_reliability_ledger_append_only(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.source_reliability_ledger_append_only() TO anon;
GRANT ALL ON FUNCTION public.source_reliability_ledger_append_only() TO authenticated;
GRANT ALL ON FUNCTION public.source_reliability_ledger_append_only() TO service_role;


--
-- Name: FUNCTION surface_of(p_item_type text, p_domain integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.surface_of(p_item_type text, p_domain integer) TO anon;
GRANT ALL ON FUNCTION public.surface_of(p_item_type text, p_domain integer) TO authenticated;
GRANT ALL ON FUNCTION public.surface_of(p_item_type text, p_domain integer) TO service_role;


--
-- Name: FUNCTION sync_sources_tier_columns(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_sources_tier_columns() TO anon;
GRANT ALL ON FUNCTION public.sync_sources_tier_columns() TO authenticated;
GRANT ALL ON FUNCTION public.sync_sources_tier_columns() TO service_role;


--
-- Name: FUNCTION trg_intelligence_items_version_snapshot(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.trg_intelligence_items_version_snapshot() FROM PUBLIC;
GRANT ALL ON FUNCTION public.trg_intelligence_items_version_snapshot() TO service_role;


--
-- Name: FUNCTION update_community_group_member_count(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.update_community_group_member_count() FROM PUBLIC;
GRANT ALL ON FUNCTION public.update_community_group_member_count() TO service_role;


--
-- Name: FUNCTION update_community_post_reply_count(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.update_community_post_reply_count() FROM PUBLIC;
GRANT ALL ON FUNCTION public.update_community_post_reply_count() TO service_role;


--
-- Name: FUNCTION update_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_updated_at() TO service_role;


--
-- Name: FUNCTION user_belongs_to_org(check_org_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_belongs_to_org(check_org_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_belongs_to_org(check_org_id uuid) TO anon;
GRANT ALL ON FUNCTION public.user_belongs_to_org(check_org_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.user_belongs_to_org(check_org_id uuid) TO service_role;


--
-- Name: FUNCTION user_can_write_in_org(p_org uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_can_write_in_org(p_org uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_can_write_in_org(p_org uuid) TO authenticated;
GRANT ALL ON FUNCTION public.user_can_write_in_org(p_org uuid) TO service_role;


--
-- Name: FUNCTION user_group_role(p_group uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_group_role(p_group uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_group_role(p_group uuid) TO authenticated;
GRANT ALL ON FUNCTION public.user_group_role(p_group uuid) TO service_role;


--
-- Name: FUNCTION user_is_group_admin(_group_id uuid, _user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_is_group_admin(_group_id uuid, _user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_is_group_admin(_group_id uuid, _user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.user_is_group_admin(_group_id uuid, _user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.user_is_group_admin(_group_id uuid, _user_id uuid) TO service_role;


--
-- Name: FUNCTION user_is_group_member(_group_id uuid, _user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_is_group_member(_group_id uuid, _user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_is_group_member(_group_id uuid, _user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.user_is_group_member(_group_id uuid, _user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.user_is_group_member(_group_id uuid, _user_id uuid) TO service_role;


--
-- Name: FUNCTION user_org_role(p_org uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_org_role(p_org uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_org_role(p_org uuid) TO authenticated;
GRANT ALL ON FUNCTION public.user_org_role(p_org uuid) TO service_role;


--
-- Name: FUNCTION user_owns_group(_group_id uuid, _user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.user_owns_group(_group_id uuid, _user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.user_owns_group(_group_id uuid, _user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.user_owns_group(_group_id uuid, _user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.user_owns_group(_group_id uuid, _user_id uuid) TO service_role;


--
-- Name: FUNCTION validate_item_provenance(p_item_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_item_provenance(p_item_id uuid) TO anon;
GRANT ALL ON FUNCTION public.validate_item_provenance(p_item_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.validate_item_provenance(p_item_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.validate_item_provenance(p_item_id uuid) TO reconciler;


--
-- Name: TABLE admin_action_cooldowns; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.admin_action_cooldowns TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.admin_action_cooldowns TO authenticated;
GRANT ALL ON TABLE public.admin_action_cooldowns TO service_role;


--
-- Name: TABLE agent_run_searches; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.agent_run_searches TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_run_searches TO authenticated;
GRANT ALL ON TABLE public.agent_run_searches TO service_role;
GRANT SELECT ON TABLE public.agent_run_searches TO reconciler;


--
-- Name: TABLE agent_runs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.agent_runs TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.agent_runs TO authenticated;
GRANT ALL ON TABLE public.agent_runs TO service_role;


--
-- Name: TABLE aggregate_query_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.aggregate_query_log TO service_role;


--
-- Name: TABLE assumption_register; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.assumption_register TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.assumption_register TO authenticated;
GRANT ALL ON TABLE public.assumption_register TO service_role;


--
-- Name: TABLE auxiliary_energy_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.auxiliary_energy_profiles TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.auxiliary_energy_profiles TO authenticated;
GRANT ALL ON TABLE public.auxiliary_energy_profiles TO service_role;


--
-- Name: TABLE brief_apply_runs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.brief_apply_runs TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.brief_apply_runs TO authenticated;
GRANT ALL ON TABLE public.brief_apply_runs TO service_role;


--
-- Name: TABLE bulk_imports; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.bulk_imports TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.bulk_imports TO authenticated;
GRANT ALL ON TABLE public.bulk_imports TO service_role;


--
-- Name: TABLE canonical_source_candidates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.canonical_source_candidates TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.canonical_source_candidates TO authenticated;
GRANT ALL ON TABLE public.canonical_source_candidates TO service_role;


--
-- Name: TABLE census_worklist; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.census_worklist TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.census_worklist TO authenticated;
GRANT ALL ON TABLE public.census_worklist TO service_role;


--
-- Name: TABLE coverage_gap_census_findings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.coverage_gap_census_findings TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.coverage_gap_census_findings TO authenticated;
GRANT ALL ON TABLE public.coverage_gap_census_findings TO service_role;


--
-- Name: TABLE census_rollup_by_surface; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.census_rollup_by_surface TO anon;
GRANT SELECT ON TABLE public.census_rollup_by_surface TO authenticated;
GRANT ALL ON TABLE public.census_rollup_by_surface TO service_role;


--
-- Name: TABLE claim_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.claim_versions TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.claim_versions TO authenticated;
GRANT ALL ON TABLE public.claim_versions TO service_role;


--
-- Name: TABLE community_group_invitations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.community_group_invitations TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.community_group_invitations TO authenticated;
GRANT ALL ON TABLE public.community_group_invitations TO service_role;


--
-- Name: TABLE community_group_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.community_group_members TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.community_group_members TO authenticated;
GRANT ALL ON TABLE public.community_group_members TO service_role;


--
-- Name: TABLE community_groups; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.community_groups TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.community_groups TO authenticated;
GRANT ALL ON TABLE public.community_groups TO service_role;


--
-- Name: TABLE community_member_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT DELETE ON TABLE public.community_member_profiles TO authenticated;
GRANT ALL ON TABLE public.community_member_profiles TO service_role;


--
-- Name: COLUMN community_member_profiles.user_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(user_id),INSERT(user_id),UPDATE(user_id) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(user_id) ON TABLE public.community_member_profiles TO anon;


--
-- Name: COLUMN community_member_profiles.org_type; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(org_type),INSERT(org_type),UPDATE(org_type) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(org_type) ON TABLE public.community_member_profiles TO anon;


--
-- Name: COLUMN community_member_profiles.role; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(role),INSERT(role),UPDATE(role) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(role) ON TABLE public.community_member_profiles TO anon;


--
-- Name: COLUMN community_member_profiles.sector; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(sector),INSERT(sector),UPDATE(sector) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(sector) ON TABLE public.community_member_profiles TO anon;


--
-- Name: COLUMN community_member_profiles.region; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(region),INSERT(region),UPDATE(region) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(region) ON TABLE public.community_member_profiles TO anon;


--
-- Name: COLUMN community_member_profiles.verified; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(verified) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(verified) ON TABLE public.community_member_profiles TO anon;


--
-- Name: COLUMN community_member_profiles.verified_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(verified_at) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(verified_at) ON TABLE public.community_member_profiles TO anon;


--
-- Name: COLUMN community_member_profiles.verification_method; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(verification_method) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(verification_method) ON TABLE public.community_member_profiles TO anon;


--
-- Name: COLUMN community_member_profiles.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_at),INSERT(created_at),UPDATE(created_at) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(created_at) ON TABLE public.community_member_profiles TO anon;


--
-- Name: COLUMN community_member_profiles.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(updated_at),INSERT(updated_at),UPDATE(updated_at) ON TABLE public.community_member_profiles TO authenticated;
GRANT SELECT(updated_at) ON TABLE public.community_member_profiles TO anon;


--
-- Name: COLUMN community_member_profiles.default_anonymous; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(default_anonymous),UPDATE(default_anonymous) ON TABLE public.community_member_profiles TO authenticated;


--
-- Name: TABLE community_post_signoff_requests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.community_post_signoff_requests TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.community_post_signoff_requests TO authenticated;
GRANT ALL ON TABLE public.community_post_signoff_requests TO service_role;


--
-- Name: TABLE community_posts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.community_posts TO anon;
GRANT SELECT,DELETE ON TABLE public.community_posts TO authenticated;
GRANT ALL ON TABLE public.community_posts TO service_role;


--
-- Name: COLUMN community_posts.id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(id),UPDATE(id) ON TABLE public.community_posts TO authenticated;


--
-- Name: COLUMN community_posts.group_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(group_id),UPDATE(group_id) ON TABLE public.community_posts TO authenticated;


--
-- Name: COLUMN community_posts.parent_post_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(parent_post_id),UPDATE(parent_post_id) ON TABLE public.community_posts TO authenticated;


--
-- Name: COLUMN community_posts.author_user_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(author_user_id) ON TABLE public.community_posts TO authenticated;


--
-- Name: COLUMN community_posts.title; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(title),UPDATE(title) ON TABLE public.community_posts TO authenticated;


--
-- Name: COLUMN community_posts.body; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(body),UPDATE(body) ON TABLE public.community_posts TO authenticated;


--
-- Name: COLUMN community_posts.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(created_at),UPDATE(created_at) ON TABLE public.community_posts TO authenticated;


--
-- Name: COLUMN community_posts.last_reply_at; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(last_reply_at),UPDATE(last_reply_at) ON TABLE public.community_posts TO authenticated;


--
-- Name: COLUMN community_posts.reply_count; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(reply_count),UPDATE(reply_count) ON TABLE public.community_posts TO authenticated;


--
-- Name: COLUMN community_posts.promoted_from_post_id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(promoted_from_post_id),UPDATE(promoted_from_post_id) ON TABLE public.community_posts TO authenticated;


--
-- Name: COLUMN community_posts.attribution; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(attribution),UPDATE(attribution) ON TABLE public.community_posts TO authenticated;


--
-- Name: COLUMN community_posts.referenced_intelligence_item_ids; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(referenced_intelligence_item_ids),UPDATE(referenced_intelligence_item_ids) ON TABLE public.community_posts TO authenticated;


--
-- Name: COLUMN community_posts.anonymous; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(anonymous),UPDATE(anonymous) ON TABLE public.community_posts TO authenticated;


--
-- Name: TABLE community_thread_entities; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.community_thread_entities TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.community_thread_entities TO authenticated;
GRANT ALL ON TABLE public.community_thread_entities TO service_role;


--
-- Name: TABLE community_topic_groups; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.community_topic_groups TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.community_topic_groups TO authenticated;
GRANT ALL ON TABLE public.community_topic_groups TO service_role;


--
-- Name: TABLE community_topics; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.community_topics TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.community_topics TO authenticated;
GRANT ALL ON TABLE public.community_topics TO service_role;


--
-- Name: TABLE connection_theme_runs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.connection_theme_runs TO authenticated;
GRANT ALL ON TABLE public.connection_theme_runs TO service_role;


--
-- Name: TABLE connection_themes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.connection_themes TO authenticated;
GRANT ALL ON TABLE public.connection_themes TO service_role;


--
-- Name: TABLE corpus_census; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.corpus_census TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.corpus_census TO authenticated;
GRANT ALL ON TABLE public.corpus_census TO service_role;


--
-- Name: TABLE corpus_turn_requests; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.corpus_turn_requests TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.corpus_turn_requests TO authenticated;
GRANT ALL ON TABLE public.corpus_turn_requests TO service_role;


--
-- Name: TABLE coverage_gap_candidates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.coverage_gap_candidates TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.coverage_gap_candidates TO authenticated;
GRANT ALL ON TABLE public.coverage_gap_candidates TO service_role;


--
-- Name: TABLE coverage_gaps; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.coverage_gaps TO authenticated;
GRANT ALL ON TABLE public.coverage_gaps TO service_role;


--
-- Name: TABLE data_sources; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.data_sources TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.data_sources TO authenticated;
GRANT ALL ON TABLE public.data_sources TO service_role;


--
-- Name: TABLE derivation_edges; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.derivation_edges TO service_role;


--
-- Name: TABLE derived_values; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.derived_values TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.derived_values TO authenticated;
GRANT ALL ON TABLE public.derived_values TO service_role;


--
-- Name: TABLE derived_values_admissible; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.derived_values_admissible TO anon;
GRANT SELECT ON TABLE public.derived_values_admissible TO authenticated;
GRANT ALL ON TABLE public.derived_values_admissible TO service_role;


--
-- Name: TABLE disposition_ledger; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.disposition_ledger TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.disposition_ledger TO authenticated;
GRANT ALL ON TABLE public.disposition_ledger TO service_role;


--
-- Name: TABLE emission_factors; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.emission_factors TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.emission_factors TO authenticated;
GRANT ALL ON TABLE public.emission_factors TO service_role;


--
-- Name: TABLE licence_clear_sources; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.licence_clear_sources TO anon;
GRANT SELECT ON TABLE public.licence_clear_sources TO authenticated;
GRANT ALL ON TABLE public.licence_clear_sources TO service_role;


--
-- Name: TABLE emission_factor_candidates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.emission_factor_candidates TO anon;
GRANT SELECT ON TABLE public.emission_factor_candidates TO authenticated;
GRANT ALL ON TABLE public.emission_factor_candidates TO service_role;


--
-- Name: TABLE entities; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.entities TO authenticated;
GRANT ALL ON TABLE public.entities TO service_role;


--
-- Name: TABLE entity_aliases; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.entity_aliases TO authenticated;
GRANT SELECT,INSERT,REFERENCES,TRIGGER ON TABLE public.entity_aliases TO service_role;


--
-- Name: TABLE entity_identifiers; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.entity_identifiers TO authenticated;
GRANT ALL ON TABLE public.entity_identifiers TO service_role;


--
-- Name: TABLE entity_refs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.entity_refs TO authenticated;
GRANT ALL ON TABLE public.entity_refs TO service_role;


--
-- Name: TABLE entity_relations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.entity_relations TO authenticated;
GRANT ALL ON TABLE public.entity_relations TO service_role;


--
-- Name: TABLE entity_scope; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.entity_scope TO authenticated;
GRANT ALL ON TABLE public.entity_scope TO service_role;


--
-- Name: TABLE error_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.error_events TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.error_events TO authenticated;
GRANT ALL ON TABLE public.error_events TO service_role;


--
-- Name: TABLE estimated_values; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.estimated_values TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.estimated_values TO authenticated;
GRANT ALL ON TABLE public.estimated_values TO service_role;


--
-- Name: TABLE funded_pass_runlock; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.funded_pass_runlock TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.funded_pass_runlock TO authenticated;
GRANT ALL ON TABLE public.funded_pass_runlock TO service_role;


--
-- Name: TABLE gate_a_health_cache; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.gate_a_health_cache TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.gate_a_health_cache TO authenticated;
GRANT ALL ON TABLE public.gate_a_health_cache TO service_role;


--
-- Name: TABLE grid_connection_queues; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.grid_connection_queues TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.grid_connection_queues TO authenticated;
GRANT ALL ON TABLE public.grid_connection_queues TO service_role;


--
-- Name: TABLE harness_runs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.harness_runs TO service_role;


--
-- Name: TABLE holdings_quality; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.holdings_quality TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.holdings_quality TO authenticated;
GRANT ALL ON TABLE public.holdings_quality TO service_role;


--
-- Name: TABLE indexation_clauses; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.indexation_clauses TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.indexation_clauses TO authenticated;
GRANT ALL ON TABLE public.indexation_clauses TO service_role;


--
-- Name: TABLE inference_records; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.inference_records TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.inference_records TO authenticated;
GRANT ALL ON TABLE public.inference_records TO service_role;


--
-- Name: TABLE ingest_rejections; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.ingest_rejections TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.ingest_rejections TO authenticated;
GRANT ALL ON TABLE public.ingest_rejections TO service_role;


--
-- Name: TABLE institutions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.institutions TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.institutions TO authenticated;
GRANT ALL ON TABLE public.institutions TO service_role;


--
-- Name: TABLE integrity_flags; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.integrity_flags TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.integrity_flags TO authenticated;
GRANT ALL ON TABLE public.integrity_flags TO service_role;
GRANT SELECT,INSERT ON TABLE public.integrity_flags TO reconciler;


--
-- Name: TABLE intelligence_changes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.intelligence_changes TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.intelligence_changes TO authenticated;
GRANT ALL ON TABLE public.intelligence_changes TO service_role;


--
-- Name: TABLE intelligence_item_citations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.intelligence_item_citations TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.intelligence_item_citations TO authenticated;
GRANT ALL ON TABLE public.intelligence_item_citations TO service_role;


--
-- Name: TABLE intelligence_item_sections; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.intelligence_item_sections TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.intelligence_item_sections TO authenticated;
GRANT ALL ON TABLE public.intelligence_item_sections TO service_role;
GRANT SELECT ON TABLE public.intelligence_item_sections TO reconciler;


--
-- Name: TABLE intelligence_item_versions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.intelligence_item_versions TO anon;
GRANT SELECT,INSERT ON TABLE public.intelligence_item_versions TO authenticated;
GRANT ALL ON TABLE public.intelligence_item_versions TO service_role;


--
-- Name: TABLE intelligence_items; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.intelligence_items TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.intelligence_items TO authenticated;
GRANT ALL ON TABLE public.intelligence_items TO service_role;
GRANT SELECT ON TABLE public.intelligence_items TO reconciler;


--
-- Name: COLUMN intelligence_items.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(updated_at) ON TABLE public.intelligence_items TO reconciler;


--
-- Name: COLUMN intelligence_items.provenance_status; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(provenance_status) ON TABLE public.intelligence_items TO reconciler;


--
-- Name: COLUMN intelligence_items.provenance_verified_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(provenance_verified_at) ON TABLE public.intelligence_items TO reconciler;


--
-- Name: TABLE intelligence_summaries; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.intelligence_summaries TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.intelligence_summaries TO authenticated;
GRANT ALL ON TABLE public.intelligence_summaries TO service_role;


--
-- Name: TABLE item_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_assignments TO authenticated;
GRANT ALL ON TABLE public.item_assignments TO service_role;


--
-- Name: TABLE item_changelog; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.item_changelog TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_changelog TO authenticated;
GRANT ALL ON TABLE public.item_changelog TO service_role;


--
-- Name: TABLE item_correction_evidence; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.item_correction_evidence TO anon;
GRANT SELECT ON TABLE public.item_correction_evidence TO authenticated;
GRANT ALL ON TABLE public.item_correction_evidence TO service_role;


--
-- Name: TABLE item_cross_references; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.item_cross_references TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_cross_references TO authenticated;
GRANT ALL ON TABLE public.item_cross_references TO service_role;


--
-- Name: TABLE item_disputes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.item_disputes TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_disputes TO authenticated;
GRANT ALL ON TABLE public.item_disputes TO service_role;


--
-- Name: TABLE item_forward_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.item_forward_events TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_forward_events TO authenticated;
GRANT ALL ON TABLE public.item_forward_events TO service_role;


--
-- Name: TABLE item_gate_a_state; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.item_gate_a_state TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_gate_a_state TO authenticated;
GRANT ALL ON TABLE public.item_gate_a_state TO service_role;


--
-- Name: TABLE item_notes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,UPDATE ON TABLE public.item_notes TO authenticated;
GRANT ALL ON TABLE public.item_notes TO service_role;


--
-- Name: TABLE item_supersessions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.item_supersessions TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_supersessions TO authenticated;
GRANT ALL ON TABLE public.item_supersessions TO service_role;


--
-- Name: TABLE item_timelines; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.item_timelines TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_timelines TO authenticated;
GRANT ALL ON TABLE public.item_timelines TO service_role;


--
-- Name: TABLE item_type_required_slots; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.item_type_required_slots TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_type_required_slots TO authenticated;
GRANT ALL ON TABLE public.item_type_required_slots TO service_role;
GRANT SELECT ON TABLE public.item_type_required_slots TO reconciler;


--
-- Name: TABLE item_workspace_tags; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.item_workspace_tags TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.item_workspace_tags TO authenticated;
GRANT ALL ON TABLE public.item_workspace_tags TO service_role;


--
-- Name: TABLE market_series; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.market_series TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.market_series TO authenticated;
GRANT ALL ON TABLE public.market_series TO service_role;


--
-- Name: TABLE moderation_reports; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.moderation_reports TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.moderation_reports TO authenticated;
GRANT ALL ON TABLE public.moderation_reports TO service_role;


--
-- Name: TABLE monitoring_queue; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.monitoring_queue TO authenticated;
GRANT ALL ON TABLE public.monitoring_queue TO service_role;


--
-- Name: TABLE mutation_leases; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.mutation_leases TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.mutation_leases TO authenticated;
GRANT ALL ON TABLE public.mutation_leases TO service_role;


--
-- Name: TABLE notification_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.notification_preferences TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.notification_preferences TO authenticated;
GRANT ALL ON TABLE public.notification_preferences TO service_role;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.notifications TO anon;
GRANT SELECT,INSERT,DELETE ON TABLE public.notifications TO authenticated;
GRANT ALL ON TABLE public.notifications TO service_role;


--
-- Name: COLUMN notifications.read_at; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(read_at) ON TABLE public.notifications TO authenticated;


--
-- Name: TABLE obligation_objects; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.obligation_objects TO service_role;
GRANT SELECT ON TABLE public.obligation_objects TO authenticated;


--
-- Name: TABLE obligations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.obligations TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.obligations TO authenticated;
GRANT ALL ON TABLE public.obligations TO service_role;


--
-- Name: TABLE oem_tech_roadmaps; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.oem_tech_roadmaps TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.oem_tech_roadmaps TO authenticated;
GRANT ALL ON TABLE public.oem_tech_roadmaps TO service_role;


--
-- Name: TABLE org_invitations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.org_invitations TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.org_invitations TO authenticated;
GRANT ALL ON TABLE public.org_invitations TO service_role;


--
-- Name: TABLE org_member_bans; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.org_member_bans TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.org_member_bans TO authenticated;
GRANT ALL ON TABLE public.org_member_bans TO service_role;


--
-- Name: TABLE org_memberships; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.org_memberships TO authenticated;
GRANT ALL ON TABLE public.org_memberships TO service_role;


--
-- Name: TABLE org_watchlist; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.org_watchlist TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.org_watchlist TO authenticated;
GRANT ALL ON TABLE public.org_watchlist TO service_role;


--
-- Name: TABLE organizations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,DELETE ON TABLE public.organizations TO authenticated;
GRANT ALL ON TABLE public.organizations TO service_role;


--
-- Name: COLUMN organizations.id; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(id),UPDATE(id) ON TABLE public.organizations TO authenticated;


--
-- Name: COLUMN organizations.name; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(name),UPDATE(name) ON TABLE public.organizations TO authenticated;


--
-- Name: COLUMN organizations.slug; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(slug),UPDATE(slug) ON TABLE public.organizations TO authenticated;


--
-- Name: COLUMN organizations.settings; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(settings),UPDATE(settings) ON TABLE public.organizations TO authenticated;


--
-- Name: COLUMN organizations.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(created_at),UPDATE(created_at) ON TABLE public.organizations TO authenticated;


--
-- Name: COLUMN organizations.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT(updated_at),UPDATE(updated_at) ON TABLE public.organizations TO authenticated;


--
-- Name: TABLE pending_first_fetch; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pending_first_fetch TO service_role;


--
-- Name: TABLE pending_jurisdiction_review; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.pending_jurisdiction_review TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.pending_jurisdiction_review TO authenticated;
GRANT ALL ON TABLE public.pending_jurisdiction_review TO service_role;


--
-- Name: TABLE portal_link_candidates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.portal_link_candidates TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.portal_link_candidates TO authenticated;
GRANT ALL ON TABLE public.portal_link_candidates TO service_role;


--
-- Name: TABLE portfolio_members; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE public.portfolio_members TO authenticated;
GRANT ALL ON TABLE public.portfolio_members TO service_role;


--
-- Name: TABLE portfolios; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE ON TABLE public.portfolios TO authenticated;
GRANT ALL ON TABLE public.portfolios TO service_role;


--
-- Name: COLUMN portfolios.name; Type: ACL; Schema: public; Owner: -
--

GRANT UPDATE(name) ON TABLE public.portfolios TO authenticated;


--
-- Name: TABLE propagation_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.propagation_events TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.propagation_events TO authenticated;
GRANT ALL ON TABLE public.propagation_events TO service_role;


--
-- Name: SEQUENCE propagation_events_event_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.propagation_events_event_id_seq TO anon;
GRANT ALL ON SEQUENCE public.propagation_events_event_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.propagation_events_event_id_seq TO service_role;


--
-- Name: TABLE propagation_queue_depth; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.propagation_queue_depth TO anon;
GRANT SELECT ON TABLE public.propagation_queue_depth TO authenticated;
GRANT ALL ON TABLE public.propagation_queue_depth TO service_role;


--
-- Name: TABLE provisional_sources; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.provisional_sources TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.provisional_sources TO authenticated;
GRANT ALL ON TABLE public.provisional_sources TO service_role;


--
-- Name: TABLE published_price_statistics; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.published_price_statistics TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.published_price_statistics TO authenticated;
GRANT ALL ON TABLE public.published_price_statistics TO service_role;


--
-- Name: TABLE raw_fetches; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.raw_fetches TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.raw_fetches TO authenticated;
GRANT ALL ON TABLE public.raw_fetches TO service_role;


--
-- Name: TABLE region_dimension_coverage; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.region_dimension_coverage TO authenticated;
GRANT ALL ON TABLE public.region_dimension_coverage TO service_role;


--
-- Name: TABLE regional_data_facts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.regional_data_facts TO authenticated;
GRANT ALL ON TABLE public.regional_data_facts TO service_role;


--
-- Name: TABLE regions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.regions TO authenticated;
GRANT ALL ON TABLE public.regions TO service_role;


--
-- Name: TABLE reroute_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.reroute_events TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.reroute_events TO authenticated;
GRANT ALL ON TABLE public.reroute_events TO service_role;


--
-- Name: TABLE research_assessments; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.research_assessments TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.research_assessments TO authenticated;
GRANT ALL ON TABLE public.research_assessments TO service_role;


--
-- Name: TABLE research_assessments_current; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.research_assessments_current TO authenticated;
GRANT ALL ON TABLE public.research_assessments_current TO service_role;


--
-- Name: TABLE section_claim_provenance; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.section_claim_provenance TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.section_claim_provenance TO authenticated;
GRANT ALL ON TABLE public.section_claim_provenance TO service_role;
GRANT SELECT ON TABLE public.section_claim_provenance TO reconciler;


--
-- Name: TABLE sector_contexts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.sector_contexts TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sector_contexts TO authenticated;
GRANT ALL ON TABLE public.sector_contexts TO service_role;


--
-- Name: TABLE sensitive_field_policy; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sensitive_field_policy TO service_role;


--
-- Name: TABLE signposts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.signposts TO authenticated;
GRANT ALL ON TABLE public.signposts TO service_role;


--
-- Name: TABLE source_bias_tags; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.source_bias_tags TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.source_bias_tags TO authenticated;
GRANT ALL ON TABLE public.source_bias_tags TO service_role;


--
-- Name: TABLE source_citations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.source_citations TO authenticated;
GRANT ALL ON TABLE public.source_citations TO service_role;


--
-- Name: TABLE source_reliability_ledger; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.source_reliability_ledger TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.source_reliability_ledger TO authenticated;
GRANT ALL ON TABLE public.source_reliability_ledger TO service_role;


--
-- Name: SEQUENCE source_reliability_ledger_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.source_reliability_ledger_id_seq TO anon;
GRANT ALL ON SEQUENCE public.source_reliability_ledger_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.source_reliability_ledger_id_seq TO service_role;


--
-- Name: TABLE source_tier_opinions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.source_tier_opinions TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.source_tier_opinions TO authenticated;
GRANT ALL ON TABLE public.source_tier_opinions TO service_role;


--
-- Name: TABLE source_trust_events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.source_trust_events TO authenticated;
GRANT ALL ON TABLE public.source_trust_events TO service_role;


--
-- Name: TABLE source_verifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.source_verifications TO authenticated;
GRANT ALL ON TABLE public.source_verifications TO service_role;


--
-- Name: TABLE sources; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.sources TO authenticated;
GRANT ALL ON TABLE public.sources TO service_role;
GRANT SELECT ON TABLE public.sources TO reconciler;


--
-- Name: TABLE staged_updates; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.staged_updates TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.staged_updates TO authenticated;
GRANT ALL ON TABLE public.staged_updates TO service_role;


--
-- Name: TABLE state_cost_facts; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.state_cost_facts TO authenticated;
GRANT ALL ON TABLE public.state_cost_facts TO service_role;


--
-- Name: TABLE statutory_computations; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.statutory_computations TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.statutory_computations TO authenticated;
GRANT ALL ON TABLE public.statutory_computations TO service_role;


--
-- Name: TABLE system_state_flag_audit; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.system_state_flag_audit TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.system_state_flag_audit TO authenticated;
GRANT ALL ON TABLE public.system_state_flag_audit TO service_role;


--
-- Name: SEQUENCE system_state_flag_audit_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.system_state_flag_audit_id_seq TO anon;
GRANT ALL ON SEQUENCE public.system_state_flag_audit_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.system_state_flag_audit_id_seq TO service_role;


--
-- Name: TABLE theme_briefs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.theme_briefs TO authenticated;
GRANT ALL ON TABLE public.theme_briefs TO service_role;


--
-- Name: TABLE user_item_state; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.user_item_state TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_item_state TO authenticated;
GRANT ALL ON TABLE public.user_item_state TO service_role;


--
-- Name: TABLE user_watchlist; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.user_watchlist TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.user_watchlist TO authenticated;
GRANT ALL ON TABLE public.user_watchlist TO service_role;


--
-- Name: TABLE vocabulary_mentions; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.vocabulary_mentions TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.vocabulary_mentions TO authenticated;
GRANT ALL ON TABLE public.vocabulary_mentions TO service_role;


--
-- Name: TABLE vocabulary_terms; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.vocabulary_terms TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.vocabulary_terms TO authenticated;
GRANT ALL ON TABLE public.vocabulary_terms TO service_role;


--
-- Name: TABLE workspace_item_overrides; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.workspace_item_overrides TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.workspace_item_overrides TO authenticated;
GRANT ALL ON TABLE public.workspace_item_overrides TO service_role;


--
-- Name: TABLE workspace_settings; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.workspace_settings TO authenticated;
GRANT ALL ON TABLE public.workspace_settings TO service_role;


--
-- Name: TABLE workspace_tags; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT ON TABLE public.workspace_tags TO anon;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.workspace_tags TO authenticated;
GRANT ALL ON TABLE public.workspace_tags TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,DELETE,UPDATE ON TABLES  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES  TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES  TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES  TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES  TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES  TO service_role;


--
-- PostgreSQL database dump complete
--


