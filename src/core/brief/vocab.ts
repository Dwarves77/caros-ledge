// Ported from old_repo/src/lib/agent/metadata-vocab.ts (lines 3-159)
// Ported from old_repo/src/lib/agent/analysis-labels.mjs (lines 3-20)
// Ported from old_repo/src/lib/agent/timeline-harvest.mjs (lines 1-5)
// The live DB value sets (derived from the contract table, never typed twice), the write-boundary gates, the closed analysis
// labels and the month table.
import { CAPS, DB_SEVERITY_EXTRA, PRIORITIES, SEVERITIES, SIGNAL_BANDS, THEMES, URGENCY_TIERS, FORMAT_TYPES, type AdoptedTerms } from "./contract";

export const SEVERITY_DISPLAY_TO_DB: Readonly<Record<string, string>> = Object.fromEntries(SEVERITIES.map((s) => [s.label, s.db]));
export const SEVERITY_TO_PRIORITY: Readonly<Record<string, string>> = Object.fromEntries(SEVERITIES.map((s) => [s.label, s.priority]));
export const SEVERITY_DB_TO_DISPLAY: Readonly<Record<string, string>> = Object.fromEntries(SEVERITIES.map((s) => [s.db, s.label]));

export const DB_SEVERITY_VALUES: ReadonlySet<string> = new Set([...SEVERITIES.map((s) => s.db), ...DB_SEVERITY_EXTRA]);
export const DB_PRIORITY_VALUES: ReadonlySet<string> = new Set(PRIORITIES);
export const DB_URGENCY_TIER_VALUES: ReadonlySet<string> = new Set(URGENCY_TIERS);
export const DB_FORMAT_TYPE_VALUES: ReadonlySet<string> = new Set(FORMAT_TYPES);
export const DB_SIGNAL_BAND_VALUES: ReadonlySet<string> = new Set(SIGNAL_BANDS);
export const DB_THEME_VALUES: ReadonlySet<string> = new Set(THEMES);

/** The stored token of an adopted theme: whitespace runs become one underscore. */
export const themeToken = (key: string): string => String(key ?? "").trim().replace(/\s+/g, "_");
export const adoptedThemeTokens = (adopted: AdoptedTerms | undefined): string[] => (adopted?.theme ?? []).map((e) => themeToken(e.key));
export const adoptedKeys = (adopted: AdoptedTerms | undefined, kind: keyof AdoptedTerms): string[] => (adopted?.[kind] ?? []).map((e) => e.key);

/** The agent's display severity to the DB form. A DB-form value passes through; anything else is a contract break and throws. */
export function toDbSeverity(value: string | null | undefined): string | null {
  if (value == null || value === "") return null;
  const mapped = SEVERITY_DISPLAY_TO_DB[value];
  if (mapped) return mapped;
  if (DB_SEVERITY_VALUES.has(value)) return value;
  throw new Error(`unmappable severity "${value}" (expected a display label or a db-form value)`);
}
export const toDisplaySeverity = (value: string | null | undefined): string | null => (value == null || value === "" ? null : (SEVERITY_DB_TO_DISPLAY[value] ?? value));

/**
 * Candidate banking at the write boundary (capture, never drop): a vocabulary value is HELD, anything else is a CANDIDATE the
 * recurrence counter can see. Compliance objects match the closed list exactly or an adopted term case-insensitively; a theme
 * matches the DB list or an adopted theme token.
 */
export function bankCandidate(kind: "compliance_object" | "theme", value: string | null | undefined, adopted?: AdoptedTerms, closed: readonly string[] = []): { held: string | null; candidate: string | null } {
  if (value == null || value === "") return { held: null, candidate: null };
  if (kind === "theme") return DB_THEME_VALUES.has(value) || adoptedThemeTokens(adopted).includes(value) ? { held: value, candidate: null } : { held: null, candidate: value };
  if (closed.includes(value)) return { held: value, candidate: null };
  const lc = value.toLowerCase();
  return adoptedKeys(adopted, "compliance_object").some((k) => k.toLowerCase() === lc) ? { held: lc, candidate: null } : { held: null, candidate: value.length <= CAPS.candidateMaxLength ? value : null };
}
export const toDbTheme = (value: string | null | undefined, adopted?: AdoptedTerms): string | null => bankCandidate("theme", value, adopted).held;
export const toThemeCandidate = (value: string | null | undefined, adopted?: AdoptedTerms): string | null => bankCandidate("theme", value, adopted).candidate;

/** Defensive check for the pass-through enum fields: a violation means parser/DB drift, so it throws with the field named. */
export function assertDbValue(field: string, value: string | null | undefined, allowed: ReadonlySet<string>, nullable = true): void {
  if (value == null || value === "") {
    if (nullable) return;
    throw new Error(`${field} is required but null`);
  }
  if (!allowed.has(value)) throw new Error(`${field}="${value}" is not in the live DB allowed set {${[...allowed].join(", ")}}`);
}

/** The closed ANALYSIS label vocabulary: tokens, the lowercase match form, and the key form. One home. */
export const ANALYSIS_LABEL_TOKENS: readonly string[] = ["*Analytical inference:*", "*Industry interpretation:*", "*Operational implication:*"];
export const ANALYSIS_LABELS: readonly string[] = ANALYSIS_LABEL_TOKENS.map((t) => t.replace(/[*:]/g, "").toLowerCase());
export const LEGAL_CALLOUT = "*Legal Confirmation Required:*";
/** The locked sentinel a research card states when no assessment grounds a planning-assumption shift (spec 03S1). */
export const PLANNING_ASSUMPTION_SHIFT_ABSENCE = "no shift grounded";

/** The one month table: full and abbreviated English names to 1..12. */
export const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
export const MONTH_NAMES: readonly string[] = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** Month-name alternations for date regexes: full names, and full plus the abbreviations the timeline parser accepts. */
export const MONTHS_FULL_RE = MONTH_NAMES.join("|");
export const MONTHS_ANY_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
