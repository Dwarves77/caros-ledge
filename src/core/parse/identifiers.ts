// Identifiers, hosts and URLs by EQUALITY on a normalised form (R2a P3), never by substring: "2019/88" is not inside "2019/883", "SB-261" is not inside
// "SB-2610", "2023/24" is a fiscal-year range and not a regulation, "fakefederalregister.gov" is not federal_register, a URL keeps its path case. Regulation
// numbers print as "2025/2547" or as the CELEX id "32026R1030"; both resolve to one key. Schemes, suffixes and tracking parameters are data (./data).
import { escapeRe, IDENT_FILE } from "./data";
import type { Refusal } from "./figure";

export interface Identifier { scheme: string; kind: string; key: string; type: string | null; edition?: string; literal: string; start: number; end: number; context: boolean }
export interface YearRange { from: number; to: number; literal: string; start: number; end: number }

const SCHEMES = IDENT_FILE.schemes.map((s) => ({ ...s, re: new RegExp(s.pattern, s.context ? "gi" : "g") }));
const [YEAR_MIN, YEAR_MAX] = IDENT_FILE.yearBounds;
const TYPE_OF = new Map(Object.entries(IDENT_FILE.typeLetters).map(([k, v]) => [k.toLowerCase(), v] as const));
const fill = (template: string, g: Record<string, string | undefined>, ints: readonly string[]): string => template.replace(/\{(\w+)\}/g, (_, name: string) => (ints.includes(name) ? String(Number(g[name])) : (g[name] ?? "")));

/** Two-digit year range written as a fiscal or financial year ("2023/24", "2023-24", "2023/2024"): consecutive years only, so "2019/88" is never one. */
export function findYearRanges(text: string): YearRange[] {
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

/** A CN code (8 digits, printed 4-2-2): the digits and the print form, or a refusal; a heading or subheading prefix is not a CN code. */
export function parseCnCode(text: string): { digits: string; print: string } | Refusal {
  const digits = text.replace(/\s/g, "");
  const { digits: want, groups, printSeparator } = IDENT_FILE.cn;
  if (!/^\d+$/.test(digits) || digits.length !== want) return { refused: true, reason: `a CN code is ${want} digits; got ${/^\d+$/.test(digits) ? digits.length : "a non-numeric value"}`, literal: text };
  let at = 0;
  return { digits, print: groups.map((n) => { const part = digits.slice(at, at + n); at += n; return part; }).join(printSeparator) };
}

const SUFFIXES = new Set(IDENT_FILE.publicSuffixes);
const hostName = (h: string): string => h.trim().toLowerCase().replace(/\.$/, "");
/** The registrable domain (one label above the public suffix); the host itself when it has no more labels than its suffix. */
export function registrableDomain(host: string): string {
  const labels = hostName(host).split(".");
  const suffixLen = labels.length >= 3 && SUFFIXES.has(labels.slice(-2).join(".")) ? 2 : 1;
  return labels.slice(-(suffixLen + 1)).join(".");
}
/** The host is the domain or a subdomain of it: equals, or ends with "." plus the domain. Never a plain suffix test, never a substring. */
export function hostMatches(host: string, domain: string): boolean {
  const [h, d] = [hostName(host), hostName(domain)];
  return h !== "" && d !== "" && (h === d || h.endsWith(`.${d}`));
}

const TRACKING = new Set(IDENT_FILE.trackingParams);
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
