// Ported from old_repo/src/lib/market/market-rail-select.mjs (lines 1-90)
// The two market rail cards. Next data drops (INV-259) is NOT a prediction: it is the producer's latest observed period plus its registered cadence, the same derivation that writes next_release_at. A producer is omitted,
// never guessed at, when it is not implemented, has no cadence, or has no observation yet.
import { formatCorridorLabelCompact } from "@/core/entities";

import { addDaysIso } from "../producers/published-price-statistics";

import type { CarbonCostResult } from "./carbon";
import type { SeriesBoard } from "./series-board";

/** Artboard 04 draws three next-drop rows and two carbon-corridor rows. */
const NEXT_DROPS_ROW_CAP = 3;
const CARBON_CORRIDOR_ROW_CAP = 2;

export interface CarbonRailEntry {
  label: string;
  corridor?: { origin: string; dest: string; mode: string };
  result: CarbonCostResult;
}
export interface CarbonRailRow {
  label: string;
  fullLabel: string;
  /** How many inputs are still missing; 0 for a corridor with a figure. */
  missing: number;
  point: number | null;
  currency: string | null;
}

/** One line per corridor, in the compact one-line form when the parsed corridor is known. */
export function summariseCarbonCorridors(entries: readonly CarbonRailEntry[], { cap = CARBON_CORRIDOR_ROW_CAP } = {}): CarbonRailRow[] {
  return entries
    .filter((e) => e.label && e.result)
    .slice(0, cap)
    .map((e) => ({ label: e.corridor ? formatCorridorLabelCompact(e.corridor) : e.label, fullLabel: e.label, missing: e.result.ok ? 0 : e.result.gaps.length, point: e.result.ok ? e.result.point : null, currency: e.result.ok ? e.result.currency : null }));
}

export interface NextDrop {
  keyPrefix: string;
  name: string;
  dateIso: string;
}
export function selectNextDataDrops(board: Pick<SeriesBoard, "groups"> | null | undefined, { now, cap = NEXT_DROPS_ROW_CAP }: { now: Date; cap?: number }): NextDrop[] {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("selectNextDataDrops: now must be a valid Date (the request's one instant)");
  const rows: NextDrop[] = [];
  for (const g of board?.groups ?? []) {
    if (!g.implemented || g.cadenceDays == null) continue;
    const latest = g.series.map((s) => s.referencePeriod).filter((p): p is string => !!p).sort().pop();
    const dateIso = latest ? addDaysIso(latest, g.cadenceDays) : null;
    if (dateIso) rows.push({ keyPrefix: g.keyPrefix, name: g.name, dateIso });
  }
  return rows.sort((a, b) => (a.dateIso === b.dateIso ? a.name.localeCompare(b.name) : a.dateIso < b.dateIso ? -1 : 1)).slice(0, cap);
}
