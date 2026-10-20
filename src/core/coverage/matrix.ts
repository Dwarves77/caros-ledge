// Ported from old_repo/src/lib/coverage/coverage-matrix.mjs (lines 1-326)
import { formatNumber } from "@/core/shared";

import vocab from "./data/coverage.json";

const MATRIX_SCHEMA_VERSION = 1;
/** The "no filter" token for each axis. */
export const ALL = "all";
export const UNTAGGED = "untagged";
/** Upper case like every geography code, so a link round-trips through parseCoverageQuery. */
const UNKNOWN_GEOGRAPHY = "UNKNOWN";

const MODES = [...vocab.modes].sort((a, b) => a.order - b.order);
const MODE_ALIASES = vocab.modeAliases as Record<string, string>;
/** The canonical transport mode for a token or alias, or null when unrecognised. Never guesses. */
function normaliseMode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (MODES.some((m) => m.code === raw)) return raw;
  return Object.prototype.hasOwnProperty.call(MODE_ALIASES, raw) ? (MODE_ALIASES[raw] ?? null) : null;
}

/** Data classes in display order. */
const DATA_CLASSES = [
  { code: "regulations", label: "Regulations" },
  { code: "operations", label: "Operations" },
  { code: "market_intel", label: "Market Intel" },
  { code: "research", label: "Research" },
] as const;
const UNTAGGED_CLASS = { code: UNTAGGED, label: "Not tagged to a surface" };
const UNTAGGED_MODE = { code: UNTAGGED, label: "Mode not tagged" };
const DEFINITIONS = {
  denominator: "Instruments the discovery census catalogued as relevant to freight sustainability, in this cell. A catalogued instrument is a pointer to a primary source, not a grounded brief.",
  numerator: "Catalogued instruments whose identity resolved to a registered primary source and that scored firm-core relevance (dual-verified). Still a pointer, not a grounded brief.",
  numerator_one_line: "A cell's figure is the catalogued instruments that are dual-verified (firm-core relevance and a resolved, registered primary source) over all instruments catalogued in that cell.",
  verified_briefs: "Grounded, verified briefs on the platform, counted separately and never mixed into the cells.",
  untagged_mode: "An instrument takes the transport modes its source carries in the registry; one whose source carries none sits in the untagged mode.",
} as const;
const DATA_CLASS_CODES = new Set<string>(DATA_CLASSES.map((c) => c.code));

export interface CoverageEntry {
  id?: string;
  jurisdiction: string | null;
  surfaces: string[];
  relevance: string;
  identity: string;
  modes?: string[];
  checkedAt?: string | null;
}
/** An entry is in the numerator when it is dual-verified: firm-core relevance AND identity verified. */
const isNumerator = (e: Pick<CoverageEntry, "relevance" | "identity">): boolean => e.relevance === "firm" && e.identity === "verified";
const classesOf = (e: CoverageEntry): string[] => {
  const known = Array.isArray(e.surfaces) ? e.surfaces.filter((s) => DATA_CLASS_CODES.has(s)) : [];
  return known.length ? [...new Set(known)] : [UNTAGGED];
};
const modesOf = (e: CoverageEntry): string[] => {
  const canon = [...new Set((Array.isArray(e.modes) ? e.modes : []).map((m) => normaliseMode(m)).filter((m): m is string => !!m))];
  return canon.length ? canon : [UNTAGGED];
};
/** A geography code, upper-cased. A `|` is replaced so the cell key (which joins on `|`) can never be corrupted by a code. */
const geographyOf = (e: CoverageEntry): string => (typeof e.jurisdiction === "string" ? e.jurisdiction.trim().toUpperCase().replace(/\|/g, "/") : "") || UNKNOWN_GEOGRAPHY;
const cellKey = (mode: string, dataClass: string, geography: string): string => `${mode}|${dataClass}|${geography}`;

/** FNV-1a 32-bit, hex: deterministic and client-safe; the matrix version is a content hash. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
type Counts = { numerator: number; denominator: number };
function bump(map: Map<string, Counts>, key: string, isNum: boolean): void {
  const cur = map.get(key) ?? { numerator: 0, denominator: 0 };
  cur.denominator += 1;
  if (isNum) cur.numerator += 1;
  map.set(key, cur);
}

export interface CoverageMatrix {
  schemaVersion: number;
  version: string;
  generatedAt: string;
  dataAsOf: string | null;
  totals: Counts;
  verifiedBriefs: number | null;
  modeTagging: { tagged: number; total: number };
  dataClasses: Array<{ code: string; label: string } & Counts>;
  modes: Array<{ code: string; label: string } & Counts>;
  geographies: Array<{ code: string; label: string } & Counts>;
  cells: Array<{ key: string; mode: string; dataClass: string; geography: string } & Counts>;
  definitions: typeof DEFINITIONS;
}
/** The matrix. The clock is injected (`generatedAt`), never read. A cell counts a numerator only for dual-verified entries; an entry with no mode sits in the untagged mode. */
export function buildCoverageMatrix(entries: CoverageEntry[], options: { generatedAt: string; verifiedBriefs?: number | null; labelOf?: (code: string) => string }): CoverageMatrix {
  if (typeof options?.generatedAt !== "string" || Number.isNaN(Date.parse(options.generatedAt))) throw new Error("buildCoverageMatrix needs a valid generatedAt ISO instant (the clock is injected, never read)");
  const labelOf = options.labelOf ?? ((c: string) => c);
  const list = Array.isArray(entries) ? entries : [];
  const cells = new Map<string, Counts>();
  const byGeo = new Map<string, Counts>();
  const byClass = new Map<string, Counts>();
  const byMode = new Map<string, Counts>();
  let taggedMode = 0;
  let numeratorTotal = 0;
  let asOf: string | null = null;
  for (const e of list) {
    const num = isNumerator(e);
    const modes = modesOf(e);
    const geo = geographyOf(e);
    if (num) numeratorTotal += 1;
    if (!(modes.length === 1 && modes[0] === UNTAGGED)) taggedMode += 1;
    if (typeof e.checkedAt === "string" && !Number.isNaN(Date.parse(e.checkedAt)) && (asOf === null || Date.parse(e.checkedAt) > Date.parse(asOf))) asOf = e.checkedAt;
    bump(byGeo, geo, num);
    for (const c of classesOf(e)) {
      bump(byClass, c, num);
      bump(cells, cellKey(ALL, c, geo), num);
      for (const m of modes) bump(cells, cellKey(m, c, geo), num);
    }
    for (const m of modes) bump(byMode, m, num);
  }
  const zero: Counts = { numerator: 0, denominator: 0 };
  const classOrder = [...DATA_CLASSES, UNTAGGED_CLASS].filter((c) => byClass.has(c.code));
  const modeOrder = [...MODES.filter((m) => byMode.has(m.code)).map((m) => ({ code: m.code, label: m.label })), ...(byMode.has(UNTAGGED) ? [UNTAGGED_MODE] : [])];
  const geographies = [...byGeo.entries()].map(([code, c]) => ({ code, label: code === UNKNOWN_GEOGRAPHY ? "Jurisdiction not recorded" : labelOf(code), ...c })).sort((a, b) => b.denominator - a.denominator || a.label.localeCompare(b.label));
  const cellList = [...cells.entries()].map(([key, c]) => {
    const [mode = "", dataClass = "", geography = ""] = key.split("|");
    return { key, mode, dataClass, geography, ...c };
  }).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const canonical = cellList.map((c) => `${c.key}=${c.numerator}/${c.denominator}`).join(";");
  return {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    version: `cv${MATRIX_SCHEMA_VERSION}-${fnv1a(canonical)}`,
    generatedAt: options.generatedAt,
    dataAsOf: asOf,
    totals: { numerator: numeratorTotal, denominator: list.length },
    verifiedBriefs: Number.isFinite(options.verifiedBriefs) ? (options.verifiedBriefs as number) : null,
    modeTagging: { tagged: taggedMode, total: list.length },
    dataClasses: classOrder.map((c) => ({ ...c, ...(byClass.get(c.code) ?? zero) })),
    modes: modeOrder.map((m) => ({ ...m, ...(byMode.get(m.code) ?? zero) })),
    geographies,
    cells: cellList,
    definitions: DEFINITIONS,
  };
}
/** A matrix with nothing in it, for an empty census; the same shape, so callers never branch on shape. A FAILED read is never this: it is an error state. */
export const emptyCoverageMatrix = (generatedAt: string): CoverageMatrix => buildCoverageMatrix([], { generatedAt });

export interface CoverageQuery {
  mode: string;
  dataClass: string;
  geography: string;
}
const pick = (params: unknown, key: string): string | null => {
  const p = params as { get?: (k: string) => unknown } & Record<string, unknown>;
  const v = typeof p?.get === "function" ? p.get(key) : p?.[key];
  const one = Array.isArray(v) ? v[0] : v;
  return typeof one === "string" && one.trim() ? one.trim() : null;
};
/** The three axes from URLSearchParams or a plain object (Next searchParams); missing means "all". */
export function parseCoverageQuery(params: unknown): CoverageQuery {
  const mode = pick(params, "mode");
  const dataClass = pick(params, "data_class");
  const geography = pick(params, "geography");
  return { mode: mode ? (normaliseMode(mode) ?? mode.toLowerCase()) : ALL, dataClass: dataClass ? dataClass.toLowerCase() : ALL, geography: geography ? geography.toUpperCase() : ALL };
}
/** The static, linkable URL for a query; only non-default axes appear. */
export function coverageHref(query: Partial<CoverageQuery> = {}, base = "/dashboard/coverage"): string {
  const sp: string[] = [];
  if (query.mode && query.mode !== ALL) sp.push(`mode=${encodeURIComponent(query.mode)}`);
  if (query.dataClass && query.dataClass !== ALL) sp.push(`data_class=${encodeURIComponent(query.dataClass)}`);
  if (query.geography && query.geography !== ALL) sp.push(`geography=${encodeURIComponent(query.geography)}`);
  return sp.length ? `${base}?${sp.join("&")}` : base;
}
const sumCells = (cells: Counts[]): Counts => cells.reduce((a, c) => ({ numerator: a.numerator + c.numerator, denominator: a.denominator + c.denominator }), { numerator: 0, denominator: 0 });

/** The view for one query. A cell with no catalogued instrument is `present: false`: a real gap the page renders as "not covered" with a request action, never as a zero (INV-162). */
export function buildCoverageView(matrix: CoverageMatrix, query: Partial<CoverageQuery> | null | undefined) {
  const q: CoverageQuery = { mode: query?.mode ?? ALL, dataClass: query?.dataClass ?? ALL, geography: query?.geography ?? ALL };
  const index = new Map(matrix.cells.map((c) => [c.key, c]));
  const validAxes = (q.mode === ALL || matrix.modes.some((m) => m.code === q.mode)) && (q.dataClass === ALL || matrix.dataClasses.some((c) => c.code === q.dataClass)) && (q.geography === ALL || matrix.geographies.some((g) => g.code === q.geography));
  const columns = q.dataClass === ALL ? matrix.dataClasses : matrix.dataClasses.filter((c) => c.code === q.dataClass);
  const geoRows = q.geography === ALL ? matrix.geographies : matrix.geographies.filter((g) => g.code === q.geography);
  const rows = geoRows.map((g) => {
    const cells = columns.map((c) => {
      const hit = index.get(cellKey(q.mode, c.code, g.code));
      const cellQuery = { mode: q.mode, dataClass: c.code, geography: g.code };
      return { dataClass: c.code, dataClassLabel: c.label, present: !!hit, numerator: hit?.numerator ?? 0, denominator: hit?.denominator ?? 0, href: coverageHref(cellQuery), query: cellQuery };
    });
    return { geography: g.code, label: g.label, cells, ...sumCells(cells.filter((c) => c.present)) };
  }).filter((r) => r.cells.some((c) => c.present) || q.geography !== ALL);
  const hit = q.dataClass !== ALL && q.geography !== ALL ? index.get(cellKey(q.mode, q.dataClass, q.geography)) : undefined;
  const selected = q.dataClass !== ALL && q.geography !== ALL ? { query: q, present: !!hit, numerator: hit?.numerator ?? 0, denominator: hit?.denominator ?? 0, validAxes } : null;
  return { query: q, validAxes, columns, rows, selected, scoped: sumCells(rows.flatMap((r) => r.cells.filter((c) => c.present))) };
}

const CSV_COLUMNS = ["version", "generated_at", "data_as_of", "mode", "data_class", "geography_code", "geography", "numerator", "denominator"];
/** Spreadsheet formula injection: a cell starting with = + - @ is read as a formula, so the guard is unconditional (the export is a public artefact). */
function csvEscape(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** The CSV for a query. Provenance (version, generated_at, data_as_of) travels as COLUMNS so it survives a spreadsheet round trip. Rows are the cells of the query's mode. */
export function matrixToCsv(matrix: CoverageMatrix, query: Partial<CoverageQuery> | null | undefined): string {
  const q: CoverageQuery = { mode: query?.mode ?? ALL, dataClass: query?.dataClass ?? ALL, geography: query?.geography ?? ALL };
  const classLabel = new Map(matrix.dataClasses.map((c) => [c.code, c.label]));
  const geoLabel = new Map(matrix.geographies.map((g) => [g.code, g.label]));
  const modeLabel = new Map<string, string>([[ALL, "All modes"], ...matrix.modes.map((m) => [m.code, m.label] as [string, string])]);
  const rows = matrix.cells.filter((c) => c.mode === q.mode && (q.dataClass === ALL || c.dataClass === q.dataClass) && (q.geography === ALL || c.geography === q.geography)).sort((a, b) => b.denominator - a.denominator || (a.key < b.key ? -1 : 1));
  return [CSV_COLUMNS.join(","), ...rows.map((c) => [matrix.version, matrix.generatedAt, matrix.dataAsOf ?? "not recorded", modeLabel.get(c.mode) ?? c.mode, classLabel.get(c.dataClass) ?? c.dataClass, c.geography, geoLabel.get(c.geography) ?? c.geography, c.numerator, c.denominator].map(csvEscape).join(","))].join("\r\n") + "\r\n";
}
/** The download name for a query's CSV. */
export function csvFilename(matrix: CoverageMatrix, query: Partial<CoverageQuery> | null | undefined): string {
  const part = (v: string | undefined) => (v && v !== ALL ? v.toLowerCase().replace(/[^a-z0-9]+/g, "-") : null);
  return `${["coverage", part(query?.dataClass), part(query?.geography), part(query?.mode), matrix.generatedAt.slice(0, 10)].filter(Boolean).join("-")}.csv`;
}

export interface DenominatorLine {
  surface: string;
  label: string;
  numerator: number;
  denominator: number;
  verifiedBriefs: number | null;
  href: string;
}
/** The denominator line a surface shows: numerator and denominator side by side, the separate verified-brief count, and the link to the cell. */
export function surfaceDenominator(surface: string, counts: { total: number; dualVerified?: number; verifiedBriefs?: number | null } | null | undefined): DenominatorLine | null {
  const cls = DATA_CLASSES.find((c) => c.code === surface);
  if (!cls || !counts || !Number.isFinite(counts.total)) return null;
  return { surface, label: cls.label, numerator: counts.dualVerified ?? 0, denominator: counts.total, verifiedBriefs: Number.isFinite(counts.verifiedBriefs) ? (counts.verifiedBriefs as number) : null, href: coverageHref({ dataClass: surface }) };
}
export function formatDenominatorLine(d: DenominatorLine): string {
  const briefs = d.verifiedBriefs === null ? "" : ` ${formatNumber(d.verifiedBriefs)} verified briefs are on the platform.`;
  return `Coverage: ${formatNumber(d.numerator)} of ${formatNumber(d.denominator)} catalogued ${d.label} instruments are dual-verified.${briefs}`;
}
/** The portfolio-add line: coverage of the cell the thing being added sits in. */
export const formatPortfolioCoverageLine = (d: DenominatorLine): string => `Coverage for this: ${formatNumber(d.numerator)} of ${formatNumber(d.denominator)} catalogued ${d.label} instruments are dual-verified.`;
