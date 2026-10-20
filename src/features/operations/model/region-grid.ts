// Ported from old_repo/src/lib/operations/region-grid.mjs (lines 1-184)
// Ported from old_repo/src/lib/operations/region-grid.mjs (lines 198-263)
// The region by dimension grid: the envelope gate (a number renders as an indexed figure only with value AND unit), the index against a base, the implied base, the headline split, the grid with its coverage
// and its reconciliation against the stored coverage rows, and the kit's matrix fact. ONE fact shape (camelCase) for the grid, the statements and the assistant block; the reader maps the database once.
import { DERIVATION, roundToSampleSupport, VOCABULARIES } from "@/core/contracts";
import type { MatrixFact } from "@/ui";

export type Freshness = "current" | "ageing" | "stale" | "frozen" | "unknown";
export interface OperationsFact {
  regionCode: string;
  dimension: string;
  factLabel: string;
  value: string;
  status: string | null;
  trend: "up" | "down" | "flat" | null;
  sourceName: string | null;
  sourceUrl: string | null;
  /** The fact's registered source's customer tier (customerTierOf), null when unsourced or unrated. */
  sourceTier: number | null;
  sourceNote: string | null;
  lastUpdated: string | null;
  freshness: Freshness;
  valueNumeric: number | null;
  unit: string | null;
  currency: string | null;
  derivation: string | null;
  originClass: string | null;
  sourceKey: string | null;
  sourceRef: string | null;
  nObservations: number | null;
  methodVersion: string | null;
  asAtDate: string | null;
  referencePeriod: string | null;
}
export interface CoverageRow {
  regionCode: string;
  dimension: string;
  state: string;
  factCount: number | null;
  notes: string | null;
}
const ORIGIN_CLASS = VOCABULARIES.origin_class ?? {};
type Enveloped = { valueNumeric?: number | null | undefined; unit?: string | null | undefined };

/** THE gate for the dual-layer render: an interpretable number needs value_numeric AND unit; a number with no unit is a malformed envelope and falls back to the prose path (INV-229). */
export const isEnvelopedFact = <T extends Enveloped>(f: T | null | undefined): f is T & { valueNumeric: number; unit: string } => !!f && typeof f.valueNumeric === "number" && Number.isFinite(f.valueNumeric) && typeof f.unit === "string" && f.unit.length > 0;

/** 100 = parity with the base; null (never a made-up number) when either side is not enveloped, the units differ, or the base is 0. */
export function indexAgainstBase(fact: Enveloped | null | undefined, base: Enveloped | null | undefined): number | null {
  if (!isEnvelopedFact(fact) || !isEnvelopedFact(base) || fact.unit !== base.unit || base.valueNumeric === 0) return null;
  return (fact.valueNumeric / base.valueNumeric) * 100;
}
/** The implied base of a comparison with no chosen base: the first fact, in the order given, that is a valid envelope (one home for the matrix's compare mode and the statements). */
export const impliedBaseFact = <T extends Enveloped>(facts: ReadonlyArray<T | null | undefined>): T | null => facts.find((f): f is T => isEnvelopedFact(f)) ?? null;

/** The value rounded to what its observation count honestly supports, with its unit; null for a fact that is not enveloped. */
export function formatEnvelopedValue(f: Enveloped & { nObservations?: number | null | undefined }): string | null {
  return isEnvelopedFact(f) ? `${roundToSampleSupport(f.valueNumeric, f.nObservations ?? null)} ${f.unit}` : null;
}
export const originClassLabel = (code: string | null | undefined): string | null => (code ? (ORIGIN_CLASS[code]?.label ?? null) : null);
export const originClassStrength = (code: string | null | undefined): number | null => (code ? (ORIGIN_CLASS[code]?.strength ?? null) : null);
export const derivationLabel = (code: string | null | undefined): string | null => (code ? (DERIVATION[code]?.label ?? null) : null);

const sourceUrlFromNote = (note: string | null | undefined): string | null => (typeof note === "string" ? (note.match(/https?:\/\/[^\s)]+/)?.[0] ?? null) : null);
function sourceNameFromNote(note: string | null | undefined): string | null {
  if (typeof note !== "string") return null;
  const cleaned = note.replace(/https?:\/\/[^\s)]+/g, "").replace(/[·|\-–—\s]+$/, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Longest string still read as a figure rather than a sentence (the artboard's own figures run 9 to 15 characters). */
const FIGURE_MAX_CHARS = 24;
/** A fact into the artboard's slots: the enveloped figure, else a short numeric `value`, else no figure at all (the sentence is set as prose). Nothing is derived out of prose. */
function factHeadline(f: OperationsFact): { figure: string | null; description: string; prose: string | null } {
  const enveloped = formatEnvelopedValue(f);
  if (enveloped) return { figure: enveloped, description: f.factLabel, prose: null };
  const value = f.value.trim();
  if (!value) return { figure: null, description: f.factLabel, prose: null };
  return value.length <= FIGURE_MAX_CHARS && /\d/.test(value) ? { figure: value, description: f.factLabel, prose: null } : { figure: null, description: f.factLabel, prose: value };
}

/** The kit's matrix fact card input, resolved here (the kit does no region arithmetic): headline, claim, index, source line and provenance words (a fact past its cadence says so). */
export function toMatrixFact(f: OperationsFact, base: OperationsFact | null): MatrixFact {
  const { figure, description, prose } = factHeadline(f);
  const words = [originClassLabel(f.originClass), derivationLabel(f.derivation), f.freshness === "ageing" || f.freshness === "stale" || f.freshness === "frozen" ? f.freshness : null].filter(Boolean).join(" · ");
  const rest = description.trim().split(/\s+/).slice(6).join(" ");
  return {
    figure, headline: description || prose || "", claim: figure ? description : rest, prose, indexVsBase: base ? indexAgainstBase(f, base) : null,
    sourceName: f.sourceName ?? sourceNameFromNote(f.sourceNote), sourceUrl: f.sourceUrl ?? sourceUrlFromNote(f.sourceNote), sourceTier: f.sourceTier,
    period: f.referencePeriod || (f.asAtDate ? f.asAtDate.slice(0, 7) : null), provenance: words, written: f.lastUpdated ? f.lastUpdated.slice(0, 10) : null,
  };
}

export interface GridCell {
  regionKey: string;
  dimension: string;
  factCount: number;
  state: "populated" | "absent";
  facts: OperationsFact[];
  lastUpdated: string | null;
}
export interface RegionGrid {
  byCell: Record<string, GridCell>;
  regionCoverage: Array<{ regionKey: string; filled: number; total: number; pct: number; crossReferenceCount: number | null }>;
  fillRate: { filled: number; total: number; pct: number };
  reconciliation: { checked: number; agreed: number; disagreed: Array<{ cell: string; claimed: number; actual: number }> };
  emptyRegions: string[];
}
export const cellKey = (region: string, dimension: string): string => `${region}|${dimension}`;
const pct = (n: number, d: number): number => (d > 0 ? Math.round((n / d) * 100) : 0);

/** The grid over the roster and the sourced dimensions: a fact for an unknown region or dimension is dropped (a cell the roster lacks would invent a column); coverage is computed from the facts and reconciled, never silently preferred, against the stored coverage rows. */
export function buildRegionGrid(i: { regionKeys: readonly string[]; sourcedDimensions: readonly string[]; facts: readonly OperationsFact[]; coverageRows?: readonly CoverageRow[]; crossRefCountsByRegion?: Record<string, number> | null }): RegionGrid {
  const regions = [...i.regionKeys];
  const dims = [...i.sourcedDimensions];
  const bucket = new Map<string, OperationsFact[]>();
  for (const f of i.facts) if (regions.includes(f.regionCode) && dims.includes(f.dimension)) bucket.set(cellKey(f.regionCode, f.dimension), [...(bucket.get(cellKey(f.regionCode, f.dimension)) ?? []), f]);
  const byCell: Record<string, GridCell> = {};
  for (const regionKey of regions) {
    for (const dimension of dims) {
      const facts = (bucket.get(cellKey(regionKey, dimension)) ?? []).slice().sort((a, b) => a.factLabel.localeCompare(b.factLabel));
      byCell[cellKey(regionKey, dimension)] = { regionKey, dimension, factCount: facts.length, state: facts.length > 0 ? "populated" : "absent", facts, lastUpdated: facts.reduce<string | null>((acc, f) => (f.lastUpdated && (!acc || f.lastUpdated > acc) ? f.lastUpdated : acc), null) };
    }
  }
  const regionCoverage = regions.map((regionKey) => {
    const filled = dims.filter((d) => (byCell[cellKey(regionKey, d)]?.factCount ?? 0) > 0).length;
    return { regionKey, filled, total: dims.length, pct: pct(filled, dims.length), crossReferenceCount: i.crossRefCountsByRegion ? (i.crossRefCountsByRegion[regionKey] ?? 0) : null };
  });
  const cells = Object.values(byCell);
  const disagreed: RegionGrid["reconciliation"]["disagreed"] = [];
  let checked = 0;
  for (const row of i.coverageRows ?? []) {
    const cell = byCell[cellKey(row.regionCode, row.dimension)];
    if (!cell || row.factCount === null || !Number.isFinite(row.factCount)) continue;
    checked += 1;
    if (row.factCount !== cell.factCount) disagreed.push({ cell: cellKey(row.regionCode, row.dimension), claimed: row.factCount, actual: cell.factCount });
  }
  disagreed.sort((a, b) => a.cell.localeCompare(b.cell));
  const filled = cells.filter((c) => c.factCount > 0).length;
  return { byCell, regionCoverage, fillRate: { filled, total: cells.length, pct: pct(filled, cells.length) }, reconciliation: { checked, agreed: checked - disagreed.length, disagreed }, emptyRegions: regionCoverage.filter((r) => r.filled === 0).map((r) => r.regionKey) };
}
