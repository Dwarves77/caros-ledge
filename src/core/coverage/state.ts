// Ported from old_repo/src/lib/coverage/coverage-state.mjs (lines 1-127)
import vocab from "./data/coverage.json";

/** The kinds of action a treatment can carry; the component maps each to one control. */
const COVERAGE_ACTION = { request: "request", widen: "widen", retry: "retry", status: "status" } as const;
export type CoverageStateCode = keyof typeof vocab.states;
const isCoverageState = (value: unknown): value is CoverageStateCode => typeof value === "string" && Object.prototype.hasOwnProperty.call(vocab.states, value);

const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value.trim().length > 0 ? value.trim() : null);
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

export interface CoverageStateInput {
  state: string;
  subject: string;
  reason?: string | null;
  reasonClass?: string | null;
  roadmap?: string | null;
  requestRef?: string | null;
  lastValue?: string | null;
  asOf?: string | null;
  expectedRefresh?: string | null;
  hiddenCount?: number | null;
  noun?: string | null;
  canWiden?: boolean;
  canRetry?: boolean;
  statusHref?: string | null;
}
export interface CoverageTreatment {
  code: string;
  label: string;
  treatment: string;
  role: "status" | "alert";
  suppress: boolean;
  headline: string;
  lines: string[];
  actions: Array<{ kind: string; label: string }>;
}

/** The six states of absence, six treatments, never one grey dash. Null for an unknown state. */
export function describeCoverageState(input: CoverageStateInput | null | undefined): CoverageTreatment | null {
  if (!input || !isCoverageState(input.state)) return null;
  const subject = nonEmpty(input.subject) ?? "This value";
  const entry = vocab.states[input.state];
  const base = { code: input.state, label: entry.label, treatment: entry.treatment, role: "status" as const, suppress: false };
  switch (input.state) {
    case "not_applicable":
      return { ...base, suppress: true, headline: nonEmpty(input.reason) ?? `${subject} does not apply here.`, lines: [], actions: [] };
    case "not_covered": {
      const lines = [nonEmpty(input.reason), nonEmpty(input.roadmap) ? `Roadmap position: ${nonEmpty(input.roadmap)}.` : "No roadmap position is recorded for this yet."].filter((l): l is string => !!l);
      return { ...base, headline: `${subject} is not covered yet.`, lines, actions: nonEmpty(input.requestRef) ? [{ kind: COVERAGE_ACTION.request, label: "Request coverage" }] : [] };
    }
    case "no_data_yet": {
      const refresh = nonEmpty(input.expectedRefresh);
      const last = nonEmpty(input.lastValue);
      const asOf = nonEmpty(input.asOf);
      const lines = [nonEmpty(input.reason), refresh ? `Expected refresh: ${refresh}.` : "No refresh date is recorded for this source.", last ? `Last known value: ${last} (${asOf ? `as of ${asOf}` : "as-of date not recorded"}).` : "No earlier value is on file."].filter((l): l is string => !!l);
      return { ...base, headline: `${subject}: the source has not published yet.`, lines, actions: [] };
    }
    case "suppressed": {
      const reasonLabel = (vocab.suppressionReasons as Record<string, string>)[input.reasonClass ?? ""];
      return { ...base, headline: `${subject} exists and is withheld.`, lines: [reasonLabel ? `Reason: ${reasonLabel}.` : "Reason class not recorded.", nonEmpty(input.reason)].filter((l): l is string => !!l), actions: [] };
    }
    case "not_filtered_in": {
      const noun = nonEmpty(input.noun) ?? "item";
      const known = typeof input.hiddenCount === "number" && Number.isFinite(input.hiddenCount) && input.hiddenCount >= 0;
      return { ...base, headline: known ? `${plural(input.hiddenCount as number, noun)} hidden by your scope.` : `${subject} exists outside your current scope.`, lines: nonEmpty(input.reason) ? [nonEmpty(input.reason) as string] : [], actions: input.canWiden ? [{ kind: COVERAGE_ACTION.widen, label: "Widen scope" }] : [] };
    }
    case "error": {
      const actions = [...(input.canRetry ? [{ kind: COVERAGE_ACTION.retry, label: "Retry" }] : []), ...(nonEmpty(input.statusHref) ? [{ kind: COVERAGE_ACTION.status, label: "See status" }] : [])];
      return { ...base, role: "alert", headline: `${subject} could not be loaded.`, lines: [nonEmpty(input.reason) ?? "This is a system fault, not an absence of data."], actions };
    }
  }
}
