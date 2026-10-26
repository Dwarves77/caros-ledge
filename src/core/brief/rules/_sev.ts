// New in VALID-1: the five severity tokens, their labels and the locked priority, read once from the contract (ADR-052: the token is stored, the space-separated label is rendered from it).
import { SEVERITIES } from "../contract";
import { toDbSeverity } from "../vocab";

export const TOKENS: readonly string[] = SEVERITIES.map((s) => s.db);
export const LABELS: readonly string[] = SEVERITIES.map((s) => s.label);
export const LABEL_OF: Readonly<Record<string, string>> = Object.fromEntries(SEVERITIES.map((s) => [s.db, s.label]));
export const PRIORITY_OF: Readonly<Record<string, string>> = Object.fromEntries(SEVERITIES.map((s) => [s.db, s.priority]));
/** ItemColumns.severity from a batch entry's metadata.severity (a display label) or a stored value: the ADR-052 token through toDbSeverity; a value it cannot map is kept as written, for the vocabulary rule to name. */
export function severityToken(value: string | null | undefined): string | null {
  try {
    return toDbSeverity(value);
  } catch {
    return value ?? null;
  }
}
