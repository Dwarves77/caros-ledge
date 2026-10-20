// Ported from old_repo/src/lib/agent/operations-ask-context.mjs (lines 1-142)
// The Operations data block the Assistant reads (export for P2-13): the sourced-region header (COMPUTED from the roster against the facts held, so it states today's gap and updates itself), one line per regional
// fact and one per state cost fact. Pure and free: every input is already-read data, nothing here reads the database, a model or the clock. It uses the ONE fact shape of the grid and the statements (camelCase).
import { isEnvelopedFact, type OperationsFact } from "./model/region-grid";
import type { StateCostFact } from "./read/operations-reads";

const NO_SOURCE = "no canonical source on record";
const dateOnly = (v: string | null | undefined): string | null => (v ? (String(v).match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? String(v)) : null);

/** One regional fact as one grounding line: the enveloped branch states value, unit, origin, derivation, as-of and observation count; a legacy row states its text value, status and trend. */
function regionalFactLine(f: OperationsFact): string {
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
function stateCostLine(f: StateCostFact): string {
  const bits = [`value: ${f.value}${f.unit ? ` ${f.unit}` : ""}`];
  if (f.trend) bits.push(`trend: ${f.trend}`);
  bits.push(`source: ${f.sourceName ?? f.statuteCitation ?? NO_SOURCE}`, `effective: ${dateOnly(f.effectiveDate) ?? "unknown"}`);
  return `- [${f.stateLabel ? `${f.stateCode} ${f.stateLabel}` : f.stateCode}] ${f.factLabel} — ${bits.join(" | ")}`;
}

function buildOperationsAskContext(i: { regionCodes: readonly string[]; regionalFacts: readonly OperationsFact[]; stateCostFacts: readonly StateCostFact[] }): string {
  const withFacts = new Set(i.regionalFacts.map((f) => f.regionCode));
  const sourced = i.regionCodes.filter((c) => withFacts.has(c));
  const unsourced = i.regionCodes.filter((c) => !withFacts.has(c));
  const header = i.regionCodes.length ? `Regions with sourced Operations data: ${sourced.length ? sourced.join(", ") : "none"}.${unsourced.length ? ` ${unsourced.join(", ")}: no sourced Operations data yet.` : ""}` : "No Operations region roster available.";
  return [
    "AVAILABLE OPERATIONS DATA (regional cost/labour/materials/infrastructure facts and per-state cost",
    "facts from the Operations tables — background reference data, like AVAILABLE SOURCES above, NOT",
    "individually citable [Item: ...] entries; do not fabricate an [Item: ...] citation for a row below):",
    header,
    "",
    "Regional facts:",
    i.regionalFacts.map(regionalFactLine).join("\n") || "(none fetched)",
    "",
    "Per-state cost facts:",
    i.stateCostFacts.map(stateCostLine).join("\n") || "(none fetched)",
  ].join("\n");
}
