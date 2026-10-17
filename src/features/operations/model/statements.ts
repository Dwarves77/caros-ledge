// Ported from old_repo/src/lib/operations/statements.mjs (lines 1-205)
// Industry-level statements across regions (INV-230): one sentence per (dimension, fact label) that two or more regions hold a sourced figure for, the components listed so the sentence is checkable. Only
// sourced-grade origin classes, two regions at least, no verdict word (a statement poses no decision: ADR-043), one fact per region chosen by a total order, an index all-or-nothing. A label the verdict
// screen refuses is COUNTED, not silently dropped, and the block says so.
import { derivationLabel, formatEnvelopedValue, impliedBaseFact, indexAgainstBase, isEnvelopedFact, originClassLabel, originClassStrength, type OperationsFact } from "./region-grid";

/** The origin classes a statement may state: sourced grade only (never modelled, community or community-corroborated). */
export const ELIGIBLE_ORIGIN_CLASSES: readonly string[] = ["official", "verified", "partner", "derived"];
/** What stands where a statement would be when only one region holds a sourced value. */
export const NEEDS_SECOND_REGION = "needs a second sourced region";
/** Words that pose a decision rather than state a fact (whole words, any case). "Hiring" is a labour-chain term and is not matched. */
export const VERDICT_PATTERN = /\b(automat(?:e|es|ed|ing)|hire[sd]?|cheap(?:er|est)?|better|worse|superior|inferior|recommend(?:s|ed)?|should|preferable)\b/i;
export const hasVerdictWord = (text: unknown): boolean => typeof text === "string" && VERDICT_PATTERN.test(text);

const text = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The label a reader sees: producers write "<REGION> <dash> <description>", the prefix is the row's own region, so it is stripped (which lets one label group across regions). */
export function humaniseFactLabel(raw: string, regionCode?: string): string {
  let s = typeof raw === "string" ? raw : "";
  if (text(regionCode)) s = s.replace(new RegExp(`^\\s*${escapeRe(regionCode)}\\s*(?:\\u2014|\\u2013|-|:)\\s*`, "i"), "");
  s = s.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Which of two facts for one (region, group) is stated: strongest origin class, then the later as-at date, then the better source tier, then the label. A total order, so input order never decides. */
function stronger(a: OperationsFact, b: OperationsFact): OperationsFact {
  const sa = originClassStrength(a.originClass) ?? 0;
  const sb = originClassStrength(b.originClass) ?? 0;
  if (sa !== sb) return sa > sb ? a : b;
  const da = a.asAtDate ?? "";
  const db = b.asAtDate ?? "";
  if (da !== db) return da > db ? a : b;
  const ta = a.sourceTier ?? 99;
  const tb = b.sourceTier ?? 99;
  if (ta !== tb) return ta < tb ? a : b;
  return `${a.factLabel}|${a.valueNumeric}` <= `${b.factLabel}|${b.valueNumeric}` ? a : b;
}

export interface StatementComponent {
  regionCode: string;
  regionLabel: string;
  value: number;
  unit: string;
  currency: string | null;
  valueText: string;
  sourceName: string | null;
  sourceUrl: string | null;
  sourceTier: number | null;
  datasetRef: string | null;
  referencePeriod: string | null;
  statusFlag: string | null;
  originClass: string | null;
  asAtDate: string | null;
  index: number | null;
}
export interface Statement {
  dimension: string;
  factLabel: string;
  /** Null exactly when `absence` is set. */
  sentence: string | null;
  components: StatementComponent[];
  index?: { baseRegionCode: string; baseRegionLabel: string; unit: string };
  absence?: string;
}
export interface StatementRegion {
  code: string;
  label: string;
  displayOrder?: number;
}

const orderedRoster = (regions: readonly StatementRegion[]): StatementRegion[] => {
  const list = regions.filter((r) => text(r.code) && text(r.label));
  return list.every((r) => Number.isFinite(r.displayOrder)) ? list.map((r, i) => ({ r, i })).sort((a, b) => (a.r.displayOrder as number) - (b.r.displayOrder as number) || a.i - b.i).map((x) => x.r) : list.slice();
};

/** The index across a group's components, all or nothing: one base, one unit, one currency, every index defined. */
function indexGroup(components: StatementComponent[], roster: readonly StatementRegion[], baseRegionCode?: string | null) {
  const first = components[0] as StatementComponent;
  if (!components.every((c) => c.unit === first.unit && c.currency === first.currency)) return undefined;
  const envelopes = components.map((c) => ({ valueNumeric: c.value, unit: c.unit }));
  const base = text(baseRegionCode) && roster.some((r) => r.code === baseRegionCode) ? components.find((c) => c.regionCode === baseRegionCode) : components[envelopes.indexOf(impliedBaseFact(envelopes) as (typeof envelopes)[number])];
  if (!base) return undefined;
  const indexes = components.map((c) => indexAgainstBase({ valueNumeric: c.value, unit: c.unit }, { valueNumeric: base.value, unit: base.unit }));
  if (indexes.some((x) => x === null)) return undefined;
  components.forEach((c, i) => {
    c.index = Math.round(indexes[i] as number);
  });
  return { baseRegionCode: base.regionCode, baseRegionLabel: base.regionLabel, unit: base.unit };
}

const clause = (c: StatementComponent, index: ReturnType<typeof indexGroup>): string => {
  const parens = [c.sourceName, c.referencePeriod].filter(Boolean).join(", ");
  return `${c.regionLabel} ${c.valueText}${parens ? ` (${parens})` : ""}${index && c.index !== null ? `, index ${c.index} (base ${index.baseRegionLabel} = 100)` : ""}`;
};

/** The statements for a page's facts, ordered by dimension (the order given) then label, with the count of facts whose label the verdict screen refused. */
export function buildStatements(i: { facts: readonly OperationsFact[]; regions: readonly StatementRegion[]; dimensions?: readonly string[]; baseRegionCode?: string | null }): { statements: Statement[]; droppedVerdicts: number } {
  const roster = orderedRoster(i.regions);
  const known = new Set(roster.map((r) => r.code));
  const facts = i.facts.filter((f) => known.has(f.regionCode) && text(f.dimension));
  const dims = (i.dimensions ?? []).filter(text).length > 0 ? [...(i.dimensions as string[])] : [...new Set(facts.map((f) => f.dimension))].sort();
  const groups = new Map<string, { dimension: string; label: string; byRegion: Map<string, OperationsFact> }>();
  const refused = new Set<string>();
  for (const f of facts) {
    if (!dims.includes(f.dimension) || !isEnvelopedFact(f) || !ELIGIBLE_ORIGIN_CLASSES.includes(f.originClass ?? "")) continue;
    const label = humaniseFactLabel(f.factLabel, f.regionCode);
    if (!label) continue;
    if (hasVerdictWord(label)) {
      refused.add(`${f.dimension}|${label.toLowerCase()}`);
      continue;
    }
    const key = `${f.dimension}|${label.toLowerCase()}`;
    const g = groups.get(key) ?? { dimension: f.dimension, label, byRegion: new Map<string, OperationsFact>() };
    groups.set(key, g);
    const held = g.byRegion.get(f.regionCode);
    g.byRegion.set(f.regionCode, held ? stronger(held, f) : f);
  }
  const statements: Statement[] = [];
  for (const g of groups.values()) {
    const components: StatementComponent[] = roster.filter((r) => g.byRegion.has(r.code)).map((r) => {
      const f = g.byRegion.get(r.code) as OperationsFact;
      return { regionCode: r.code, regionLabel: r.label, value: f.valueNumeric as number, unit: f.unit as string, currency: text(f.currency) ? f.currency : null, valueText: formatEnvelopedValue(f) as string, sourceName: f.sourceName ?? f.sourceKey, sourceUrl: f.sourceUrl, sourceTier: f.sourceTier, datasetRef: text(f.sourceRef) ? f.sourceRef : null, referencePeriod: text(f.referencePeriod) ? f.referencePeriod : null, statusFlag: derivationLabel(f.derivation), originClass: originClassLabel(f.originClass), asAtDate: text(f.asAtDate) ? f.asAtDate : null, index: null };
    });
    if (components.length < 2) {
      statements.push({ dimension: g.dimension, factLabel: g.label, sentence: null, components, absence: NEEDS_SECOND_REGION });
      continue;
    }
    const index = indexGroup(components, roster, i.baseRegionCode);
    const missing = roster.filter((r) => !g.byRegion.has(r.code)).map((r) => r.label);
    statements.push({ dimension: g.dimension, factLabel: g.label, sentence: `${g.label}: ${components.map((c) => clause(c, index)).join("; ")}.${missing.length > 0 ? ` ${missing.join(", ")}: not available.` : ""}`, components, ...(index ? { index } : {}) });
  }
  statements.sort((a, b) => dims.indexOf(a.dimension) - dims.indexOf(b.dimension) || a.factLabel.localeCompare(b.factLabel));
  return { statements, droppedVerdicts: refused.size };
}
