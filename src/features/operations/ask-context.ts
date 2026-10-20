// Ported from old_repo/src/lib/agent/operations-ask-context.mjs (lines 1-142)
// The Operations lines the Assistant answers with: one line per regional fact and one per state cost fact, each with its source. Pure over already-read facts (the reader is readOperationsAskLines in read/operations-reads).
// It uses the ONE fact shape of the grid and the statements (camelCase).
import { isEnvelopedFact, type OperationsFact } from "./model/region-grid";
import type { StateCostFact } from "./read/operations-reads";

const NO_SOURCE = "no canonical source on record";
const dateOnly = (v: string | null | undefined): string | null => (v ? (String(v).match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? String(v)) : null);

/** One regional fact as one grounding line: the enveloped branch states value, unit, origin, derivation, as-of and observation count; a legacy row states its text value, status and trend. */
export function regionalFactLine(f: OperationsFact): string {
  const head = `[${f.regionCode}/${f.dimension}] ${f.factLabel}`;
  const bits: string[] = [];
  if (isEnvelopedFact(f)) {
    bits.push(`value: ${f.valueNumeric} ${f.unit}${f.currency ? ` ${f.currency}` : ""}`);
    if (f.originClass) bits.push(`origin: ${f.originClass}`);
    if (f.derivation) bits.push(`derivation: ${f.derivation}`);
    bits.push(`as of: ${dateOnly(f.asAtDate) ?? (f.referencePeriod ? `period ${f.referencePeriod}` : "unknown")}`);
    if (typeof f.nObservations === "number" && f.nObservations > 0) bits.push(`n=${f.nObservations}`);
    bits.push(`source: ${f.sourceName ?? (f.sourceKey ? `${f.sourceKey}${f.sourceRef ? ` ${f.sourceRef}` : ""}` : NO_SOURCE)}`);
  } else {
    bits.push(`value: ${f.value}`);
    if (f.status) bits.push(`status: ${f.status}`);
    if (f.trend) bits.push(`trend: ${f.trend}`);
    bits.push(`source: ${f.sourceName ?? f.sourceNote ?? NO_SOURCE}`);
    bits.push(`last updated: ${dateOnly(f.lastUpdated) ?? "unknown"}`);
  }
  return `- ${head} — ${bits.join(" | ")}`;
}

/** One state cost fact as one line: it carries a statute citation and an effective date, not a number envelope. */
export function stateCostLine(f: StateCostFact): string {
  const bits = [`value: ${f.value}${f.unit ? ` ${f.unit}` : ""}`];
  if (f.trend) bits.push(`trend: ${f.trend}`);
  bits.push(`source: ${f.sourceName ?? f.statuteCitation ?? NO_SOURCE}`, `effective: ${dateOnly(f.effectiveDate) ?? "unknown"}`);
  return `- [${f.stateLabel ? `${f.stateCode} ${f.stateLabel}` : f.stateCode}] ${f.factLabel} — ${bits.join(" | ")}`;
}
