// Ported from old_repo/src/lib/entities/crosswalk.mjs (lines 1-161)
// The crosswalk to published identifier schemes: 17 schemes, each with a format or check-digit validator (LEI mod 97, IMO, ORCID, ISO 6346).
// identifierRow throws on an unknown scheme, an invalid value or a blank asserter; the clock is injected (B-0254). ROR and IMO_COMPANY rules
// are unconfirmed in the source and kept as written.
import { assertEntityId } from "./kinds";

export const SCHEMES = ["LEI", "IMO_SHIP", "IMO_COMPANY", "UNLOCODE", "IATA", "ICAO", "ISO3166_1", "ISO3166_2", "NUTS", "CELEX", "ELI", "ROR", "ORCID", "EORI", "SCAC", "ISO6346", "HOST"] as const;
export type Scheme = (typeof SCHEMES)[number];

function leiNumeric(str: string): string | null {
  let out = "";
  for (const ch of str) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch >= "A" && ch <= "Z") out += String(ch.charCodeAt(0) - 55);
    else return null;
  }
  return out;
}
function isValidLei(value: unknown): boolean {
  const s = String(value ?? "").toUpperCase();
  if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(s)) return false;
  const numeric = leiNumeric(s);
  return numeric != null && BigInt(numeric) % 97n === 1n;
}
function imoCheckDigitValid(value: unknown): boolean {
  const s = String(value ?? "").replace(/^IMO\s*/i, "").trim();
  if (!/^[0-9]{7}$/.test(s)) return false;
  const d = s.split("").map(Number);
  let sum = 0;
  for (let i = 0; i < 6; i += 1) sum += (d[i] as number) * (7 - i);
  return sum % 10 === d[6];
}
function isValidOrcid(value: unknown): boolean {
  const s = String(value ?? "").toUpperCase().replace(/[^0-9X]/g, "");
  if (!/^[0-9]{15}[0-9X]$/.test(s)) return false;
  let total = 0;
  for (const d of s.slice(0, 15)) total = (total + Number(d)) * 2;
  const result = (12 - (total % 11)) % 11;
  return (result === 10 ? "X" : String(result)) === s[15];
}
const ISO6346_LETTER_VALUES: Record<string, number> = {
  A: 10, B: 12, C: 13, D: 14, E: 15, F: 16, G: 17, H: 18, I: 19, J: 20, K: 21, L: 23, M: 24, N: 25,
  O: 26, P: 27, Q: 28, R: 29, S: 30, T: 31, U: 32, V: 34, W: 35, X: 36, Y: 37, Z: 38,
};
function isValidIso6346(value: unknown): boolean {
  const s = String(value ?? "").toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-Z]{3}[UJZ][0-9]{7}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    const ch = s[i] as string;
    const val = /[0-9]/.test(ch) ? Number(ch) : ISO6346_LETTER_VALUES[ch];
    if (val === undefined) return false;
    sum += val * 2 ** i;
  }
  let remainder = sum % 11;
  if (remainder === 10) remainder = 0;
  return remainder === Number(s[10]);
}

const up = (v: unknown): string => String(v ?? "").toUpperCase();
const re = (pattern: RegExp, lower = false) => (v: unknown): boolean => pattern.test(lower ? String(v ?? "").toLowerCase() : up(v));

export const VALIDATORS: Readonly<Record<Scheme, (value: unknown) => boolean>> = {
  LEI: isValidLei,
  IMO_SHIP: imoCheckDigitValid,
  IMO_COMPANY: imoCheckDigitValid,
  UNLOCODE: re(/^[A-Z]{2}[A-Z2-9]{3}$/),
  IATA: re(/^[A-Z0-9]{2,3}$/),
  ICAO: re(/^[A-Z0-9]{3,4}$/),
  ISO3166_1: re(/^[A-Z]{2}$/),
  ISO3166_2: re(/^[A-Z]{2}-[A-Z0-9]{1,3}$/),
  NUTS: re(/^[A-Z]{2}[A-Z0-9]{0,3}$/),
  CELEX: re(/^[1-9]\d{4}[A-Z]\d{4}(\(\d{2}\))?$/),
  ELI: (v) => /^(?:https?:\/\/[^\s]+\/eli\/|eli\/)(?:reg|dir|dec)(?:_impl|_del)?\/\d{4}\/\d+(?:\/oj)?$/i.test(String(v ?? "")),
  ROR: re(/^0[a-hj-km-np-tv-z0-9]{6}[0-9]{2}$/, true),
  ORCID: isValidOrcid,
  EORI: re(/^[A-Z]{2}[A-Z0-9]{1,15}$/),
  SCAC: re(/^[A-Z]{2,4}$/),
  ISO6346: isValidIso6346,
  HOST: re(/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/, true),
};

export interface IdentifierRow {
  entity_id: string;
  scheme: Scheme;
  value: string;
  scheme_version: string | null;
  asserted_by: string;
  asserted_at: string;
}

/** One validated entity_identifiers row. The asserter is mandatory (provenance on the alias, not just on the entity); the clock is injected. */
export function identifierRow(entityId: string, scheme: Scheme, value: unknown, assertedBy: string, opts: { now: Date; schemeVersion?: string | null }): IdentifierRow {
  assertEntityId(entityId);
  if (!(SCHEMES as readonly string[]).includes(scheme)) throw new Error(`crosswalk: unknown identifier scheme "${scheme}", must be one of ${SCHEMES.join(", ")}`);
  const raw = String(value ?? "");
  if (!raw.trim()) throw new Error(`crosswalk: empty identifier value for scheme "${scheme}" (entity ${entityId})`);
  if (!VALIDATORS[scheme](raw)) throw new Error(`crosswalk: "${raw}" does not validate against scheme "${scheme}"'s format/check-digit rule`);
  if (!assertedBy || !String(assertedBy).trim()) throw new Error("crosswalk: identifierRow requires a non-empty assertedBy (provenance on the alias, not just the entity)");
  return { entity_id: entityId, scheme, value: raw, scheme_version: opts.schemeVersion ?? null, asserted_by: String(assertedBy), asserted_at: opts.now.toISOString() };
}
