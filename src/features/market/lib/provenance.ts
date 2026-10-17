// Ported from old_repo/src/components/market/SeriesProvenance.tsx (lines 1-170)
// The envelope of a figure (spec 00 section 2) from each of the three kinds of market figure, WITH the rating of the source it cites (CLAUDE.md rule 18, INV-262): a series observation, an emission factor and a published
// price statistic all carry it. The drawer draws only the fields a figure has; a field it lacks stays out, never padded.
import { tierLabelOf } from "@/core/sources";

import type { FactorRow } from "./carbon";
import type { Producer } from "./registry";
import type { SeriesDisplayRow } from "./series-board";

/** A source and what the database says about it: its licence terms (only where redistribution is permitted) and the tier its host class or registry row gives it. */
export interface SourceRating {
  sourceKey: string;
  name: string | null;
  url: string | null;
  licence: string | null;
  attribution: string | null;
  tier: number | null;
  via: "registry" | "class" | null;
}

export interface FigureEnvelope {
  derivation?: string | null;
  originClass?: string | null;
  methodVersion?: string | null;
  nObservations?: number | null;
  sourceKey?: string | null;
  sourceRef?: string | null;
  sourceUrl?: string | null;
  licence?: string | null;
  attribution?: string | null;
  /** The rating of the source, as a tier number; null when the source could not be placed in the class table. */
  sourceTier?: number | null;
  asOf?: string | null;
  /** Whether the one-week change shown beside the figure has its derivation on record (null when that could not be checked). */
  changeRecorded?: boolean | null;
}

export const ratingText = (tier: number | null | undefined): string => (tier == null ? "Unrated" : `T${tier} · ${tierLabelOf(tier)}`);

export function envelopeFromSeriesRow(row: Pick<SeriesDisplayRow, "derivation" | "originClass" | "methodVersion" | "nObservations" | "sourceKey" | "sourceRef" | "asAtDate" | "referencePeriod">, producer: Pick<Producer, "sourceUrl" | "sourceName"> | null, rating: SourceRating | null): FigureEnvelope {
  return {
    derivation: row.derivation,
    originClass: row.originClass,
    methodVersion: row.methodVersion,
    nObservations: row.nObservations,
    sourceKey: row.sourceKey,
    sourceRef: row.sourceRef,
    sourceUrl: rating?.url ?? producer?.sourceUrl ?? null,
    licence: rating?.licence ?? null,
    attribution: rating?.attribution ?? null,
    sourceTier: rating?.tier ?? null,
    asOf: row.asAtDate ?? row.referencePeriod,
  };
}

export function envelopeFromFactorRow(f: FactorRow, rating: SourceRating | null): FigureEnvelope {
  return { derivation: f.derivation ?? null, originClass: f.origin_class ?? null, methodVersion: f.method_version ?? null, nObservations: f.n_observations ?? null, sourceKey: f.source_key ?? null, sourceUrl: rating?.url ?? null, licence: rating?.licence ?? null, attribution: rating?.attribution ?? null, sourceTier: rating?.tier ?? null, asOf: f.as_at_date ?? null };
}

/** A published price statistic carries a stored rating and a release date; when it stores none, the rating of the series behind it applies. */
export function envelopeFromPriceStat(stat: { sourceTier?: number | null; releasedAt?: string | null }, seriesRating: SourceRating | null = null): FigureEnvelope {
  return { sourceTier: stat.sourceTier ?? seriesRating?.tier ?? null, asOf: stat.releasedAt ?? null };
}

export interface ProvenanceRow {
  label: string;
  value: string;
  href?: string;
}
/** The drawer's rows in the order the series board has always shown them. The source rating row is always present: a figure without a rating says "Unrated". */
export function provenanceRows(e: FigureEnvelope): ProvenanceRow[] {
  const row = (label: string, value: string | number | null | undefined, href?: string): ProvenanceRow[] => (value === null || value === undefined || value === "" ? [] : [{ label, value: String(value), ...(href ? { href } : {}) }]);
  return [
    ...row("Derivation", e.derivation),
    ...row("Origin class", e.originClass),
    ...row("Method version", e.methodVersion),
    ...row("Observations (n)", e.nObservations),
    ...row("Source key", e.sourceKey),
    ...row("Source ref", e.sourceRef, e.sourceRef && e.sourceUrl ? e.sourceUrl : undefined),
    ...row("Licence", e.licence),
    ...row("Attribution", e.attribution),
    { label: "Source rating", value: ratingText(e.sourceTier) },
    ...row("As of", e.asOf),
    ...(e.changeRecorded == null ? [] : [{ label: "Change on record", value: e.changeRecorded ? "Yes" : "No" }]),
  ];
}
