// Ported from old_repo/src/lib/scoring.ts (lines 102-175)
// Ported from old_repo/src/lib/constants.ts (lines 209-300)
// The sector-weighted urgency composite (BUILD-PLAN ruling 6): the Dashboard's ranking of which changes surface first. The old function had no caller and read keyword lists the rebuild does
// not carry; this one reads what is stored on the item (priority, stored impact, nearest binding date, jurisdiction, verticals) and the workspace profile (its sectors and jurisdiction weights).
// An unknown priority is the LOW weight (1), stated; an unscored item multiplies by 1, it never zeroes the product.
import { z } from "zod";

import type { ImpactScores } from "@/core/types";

import weightsJson from "./data/weights.json";

const weights = z.object({ jurisdictionWeights: z.record(z.string(), z.number().min(0).max(1)), sectorAdjacency: z.record(z.string(), z.array(z.string())) }).parse(weightsJson);

/** Platform default jurisdiction weights (a workspace overrides them through workspace_settings.jurisdiction_weights). */
export const JURISDICTION_WEIGHTS: Readonly<Record<string, number>> = Object.freeze(weights.jurisdictionWeights);
const ADJACENT: Readonly<Record<string, readonly string[]>> = weights.sectorAdjacency;
const LOW_WEIGHT = 1;
const PRIORITY_WEIGHT: Readonly<Record<string, number>> = { CRITICAL: 4, HIGH: 3, MODERATE: 2, LOW: LOW_WEIGHT };
/** The weight of a jurisdiction no table names. */
export const UNLISTED_JURISDICTION_WEIGHT = 0.5;
export const SECTOR_WEIGHT = { direct: 1, passThrough: 0.6, adjacent: 0.3, none: 0.1 } as const;

export interface UrgencyInput {
  priority: string | null | undefined;
  impact?: ImpactScores | null;
  /** Days to the nearest future binding date, or null when the item carries none. */
  daysToNext: number | null;
  jurisdiction: string | null | undefined;
  /** The item's cargo verticals (intelligence_items.verticals); empty means a general rule. */
  verticals: readonly string[] | null | undefined;
}
export interface UrgencyContext {
  /** workspace_settings.jurisdiction_weights; merged over the platform defaults. */
  jurisdictionWeights?: Readonly<Record<string, number>> | null;
  /** workspace_settings.sector_profile; empty means no sector weighting. */
  sectors?: readonly string[] | null;
}

/** How much the workspace's sectors care about an item: 1 when its verticals name an active sector, 0.6 for a general rule, 0.3 when a vertical is adjacent to an active sector, else 0.1. */
export function sectorWeight(verticals: readonly string[] | null | undefined, sectors: readonly string[] | null | undefined): number {
  if (!sectors || sectors.length === 0) return 1;
  const own = verticals ?? [];
  if (own.length === 0) return SECTOR_WEIGHT.passThrough;
  if (own.some((v) => sectors.includes(v))) return SECTOR_WEIGHT.direct;
  return sectors.some((s) => own.some((v) => ADJACENT[s]?.includes(v))) ? SECTOR_WEIGHT.adjacent : SECTOR_WEIGHT.none;
}

/** priority x time x jurisdiction x sector x (1 + stored impact / 12), to one decimal. Higher ranks first. */
export function urgencyScore(item: UrgencyInput, ctx: UrgencyContext = {}): number {
  const priority = PRIORITY_WEIGHT[String(item.priority ?? "")] ?? LOW_WEIGHT;
  const time = item.daysToNext === null ? 1 : Math.min(5, 365 / Math.max(1, item.daysToNext));
  const table = { ...JURISDICTION_WEIGHTS, ...(ctx.jurisdictionWeights ?? {}) };
  const jurisdiction = table[String(item.jurisdiction ?? "global").toLowerCase()] ?? UNLISTED_JURISDICTION_WEIGHT;
  const impact = item.impact ? item.impact.cost + item.impact.compliance + item.impact.client + item.impact.operational : 0;
  return Math.round(priority * time * (0.5 + jurisdiction * 0.5) * sectorWeight(item.verticals, ctx.sectors) * (1 + impact / 12) * 10) / 10;
}
