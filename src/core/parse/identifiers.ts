// Identifiers and URLs by EQUALITY on a normalised form (R2a P3), never by substring: "2019/88" is not inside "2019/883", "SB-261" is not inside
// "SB-2610", "2023/24" is a fiscal-year range and not a regulation, a URL keeps its path case. Regulation
// numbers print as "2025/2547" or as the CELEX id "32026R1030"; both resolve to one key. Schemes, suffixes and tracking parameters are data (./data).
import { escapeRe, IDENT_FILE } from "./data";

export interface Identifier { scheme: string; kind: string; key: string; type: string | null; edition?: string; literal: string; start: number; end: number; context: boolean }
interface YearRange { from: number; to: number; literal: string; start: number; end: number }

const SCHEMES = IDENT_FILE.schemes.map((s) => ({ ...s, re: new RegExp(s.pattern, s.context ? "gi" : "g") }));
const [YEAR_MIN, YEAR_MAX] = IDENT_FILE.yearBounds;
const TYPE_OF = new Map(Object.entries(IDENT_FILE.typeLetters).map(([k, v]) => [k.toLowerCase(), v] as const));
const fill = (template: string, g: Record<string, string | undefined>, ints: readonly string[]): string => template.replace(/\{(\w+)\}/g, (_, name: string) => (ints.includes(name) ? String(Number(g[name])) : (g[name] ?? "")));

/** Two-digit year range written as a fiscal or financial year ("2023/24", "2023-24", "2023/2024"): consecutive years only, so "2019/88" is never one. */
function findYearRanges(text: string): YearRange[] {
  const out: YearRange[] = [];
  for (const m of text.matchAll(new RegExp(IDENT_FILE.yearRange.pattern, "g"))) {
    const from = Number(m.groups?.start);
    const e = m.groups?.end ?? "";
    let to = e.length === 2 ? Math.floor(from / 100) * 100 + Number(e) : Number(e);
    if (e.length === 2 && to < from) to += 100;
    if (to === from + 1) out.push({ from, to, literal: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Every identifier in `text`, longest scheme first, none overlapping another. `contextOnly` drops a bare year/number token (no "Regulation (EU)" or CELEX beside it). */
export function findIdentifiers(text: string, opts: { contextOnly?: boolean } = {}): Identifier[] {
  const found: Identifier[] = [];
  const fiscal = findYearRanges(text);
  for (const s of SCHEMES) {
    if (opts.contextOnly && !s.context && s.kind === "instrument") continue;
    for (const m of text.matchAll(s.re)) {
      const [start, end] = [m.index, m.index + m[0].length];
      if (found.some((f) => start < f.end && end > f.start)) continue;
      const g = m.groups ?? {};
      if (s.kind === "instrument") {
        const year = Number(g.year);
        if (year < YEAR_MIN || year > YEAR_MAX || Number(g.number) < 1) continue;
        if (!s.context && fiscal.some((r) => start < r.end && end > r.start)) continue;
      }
      const type = g.type ? (TYPE_OF.get(g.type.toLowerCase()) ?? g.type) : g.tname ? (TYPE_OF.get(g.tname.toLowerCase()) ?? null) : null;
      found.push({ scheme: s.id, kind: s.kind, key: fill(s.key, g, s.intGroups), type, ...(g.edition ? { edition: g.edition } : {}), literal: m[0], start, end, context: s.context });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** The same instrument: equal normalised key, and equal type where both state one (a directive and a regulation can share a year and a number). */
export const sameIdentifier = (a: Pick<Identifier, "key" | "type">, b: Pick<Identifier, "key" | "type">): boolean => a.key === b.key && (a.type === null || b.type === null || a.type === b.type);
/** Does `text` name this identifier (equality on the normalised key, never a substring of the text)? */
export const mentionsIdentifier = (text: string, id: Pick<Identifier, "key" | "type">): boolean => findIdentifiers(text).some((f) => sameIdentifier(f, id));
/** The identifiers a record states of ITSELF: those of its identifier field, else the first one its title opens with. */
export function ownIdentifiers(r: { instrument_identifier?: string | null; title?: string | null }): Identifier[] {
  const stated = findIdentifiers(String(r.instrument_identifier ?? ""));
  return stated.length ? stated : findIdentifiers(String(r.title ?? "")).slice(0, 1);
}



/** The query parameters that only track a visit; canonicalizeUrl drops them and so does its SQL mirror. */
export const TRACKING_PARAMS: readonly string[] = IDENT_FILE.trackingParams;
const TRACKING = new Set(TRACKING_PARAMS);
/** One canonical URL: https, host lower-cased without www and default port, path and query CASE KEPT, query sorted and stripped of tracking parameters, no fragment, no trailing slash. */
export function canonicalizeUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim().replace(/[*`]+$/, "").replace(/[.,;:]+$/, "");
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const port = u.port && !(["80", "443"].includes(u.port)) ? `:${u.port}` : "";
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "";
  const query = [...u.searchParams].filter(([k]) => !TRACKING.has(k.toLowerCase())).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const qs = new URLSearchParams(query).toString();
  return `https://${host}${port}${path}${qs ? `?${qs}` : ""}`;
}

/** Where `needle` first occurs in `text` ignoring case, as an offset into the ORIGINAL string (lower-casing can change a string's length, so an index found in the lower-cased copy misaligns). */
export function indexOfInsensitive(text: string, needle: string): { index: number; length: number } | null {
  if (!needle) return null;
  const m = new RegExp(escapeRe(needle), "iu").exec(text);
  return m ? { index: m.index, length: m[0].length } : null;
}

/** True when `host` is `domain` or a subdomain of it: "gov.uk" and "www.gov.uk" match "gov.uk", "notgov.uk" and "gov.uk.example.com" do not. */
export function hostMatches(host: string | null | undefined, domain: string): boolean {
  const h = String(host ?? "").toLowerCase().replace(/\.$/, "");
  const d = domain.toLowerCase();
  return h !== "" && d !== "" && (h === d || h.endsWith(`.${d}`));
}

/**
 * public.canonicalize_citation_url and its two form-encoding helpers: the database mirror of canonicalizeUrl, GENERATED from the same data (the tracking parameters). Migration 0107 carries this text; a test regenerates and diffs it,
 * and schema:local runs the function and canonicalizeUrl over one list of URLs and they agree. The mirror covers absolute URLs with an ASCII host and a path that holds no dot segments or characters the URL standard re-encodes;
 * a URL it cannot read is returned trimmed, exactly as canonicalizeUrl returns it.
 */
export function renderCanonicalizeUrlSql(): string {
  const tracking = IDENT_FILE.trackingParams.map((p) => `'${p.replace(/'/g, "''")}'`).join(", ");
  return `CREATE OR REPLACE FUNCTION public.canonical_form_decode(s text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT coalesce(convert_from(string_agg(CASE WHEN r.a[1] ~ '^%[0-9A-Fa-f]{2}$' THEN decode(substr(r.a[1], 2), 'hex') ELSE convert_to(replace(r.a[1], '+', ' '), 'UTF8') END, ''::bytea ORDER BY r.n), 'UTF8'), '')
    FROM regexp_matches(s, '%[0-9A-Fa-f]{2}|[^%]+|%', 'g') WITH ORDINALITY AS r(a, n)
$$;

CREATE OR REPLACE FUNCTION public.canonical_form_encode(s text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    SET search_path TO 'public', 'pg_temp'
    AS $$
  SELECT coalesce(string_agg(CASE WHEN c.ch ~ '^[A-Za-z0-9*._-]$' THEN c.ch WHEN c.ch = ' ' THEN '+' ELSE regexp_replace(upper(encode(convert_to(c.ch, 'UTF8'), 'hex')), '(..)', '%\\1', 'g') END, '' ORDER BY c.n), '')
    FROM regexp_split_to_table(s, '') WITH ORDINALITY AS c(ch, n)
$$;

CREATE OR REPLACE FUNCTION public.canonicalize_citation_url(u text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE STRICT
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  v_t text;
  m text[];
  v_host text;
  v_port text;
  v_path text;
  v_qs text;
BEGIN
  v_t := regexp_replace(regexp_replace(regexp_replace(u, '^\\s+|\\s+$', '', 'g'), '[*\`]+$', ''), '[.,;:]+$', '');
  m := regexp_match(v_t, '^[A-Za-z][A-Za-z0-9+.-]*://([^/?#]*)([^?#]*)(?:\\?([^#]*))?(?:#.*)?$');
  IF m IS NULL THEN RETURN v_t; END IF;
  v_host := lower(regexp_replace(m[1], '^.*@', ''));
  v_port := (regexp_match(v_host, ':(\\d+)$'))[1];
  v_host := regexp_replace(regexp_replace(v_host, ':\\d*$', ''), '^www\\.', '');
  IF v_host = '' THEN RETURN v_t; END IF;
  IF v_port IS NOT NULL THEN v_port := (v_port::bigint)::text; IF v_port IN ('80', '443') THEN v_port := NULL; END IF; END IF;
  v_path := CASE WHEN length(m[2]) > 1 THEN regexp_replace(m[2], '/+$', '') ELSE '' END;
  IF m[3] IS NOT NULL THEN
    SELECT string_agg(public.canonical_form_encode(q.k) || '=' || public.canonical_form_encode(q.v), '&' ORDER BY q.k COLLATE "C", q.v COLLATE "C")
      INTO v_qs
      FROM (SELECT public.canonical_form_decode(split_part(p, '=', 1)) AS k, public.canonical_form_decode(CASE WHEN strpos(p, '=') = 0 THEN '' ELSE substr(p, strpos(p, '=') + 1) END) AS v
              FROM unnest(string_to_array(m[3], '&')) AS p WHERE p <> '') q
     WHERE lower(q.k) NOT IN (${tracking});
  END IF;
  RETURN 'https://' || v_host || coalesce(':' || v_port, '') || v_path || CASE WHEN v_qs IS NULL OR v_qs = '' THEN '' ELSE '?' || v_qs END;
EXCEPTION WHEN character_not_in_repertoire OR invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN v_t;
END;
$$;`;
}
