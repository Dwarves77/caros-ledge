// Ported from old_repo/src/components/pages/MarketSignalDetailSurface.tsx (lines 175-299)
// The signal band the market detail page shows beside a signal: the stored `signal_band` column, or nothing. The keyword pass the old page ran over the title and note (and its default to "corporate") is gone: a
// signal the classification stage has not banded has no band, on the list and on the detail alike (register surfaces:3). The kind is the stored severity: ./severity.
import type { Resource } from "@/core/types";

export type BandKey = "price" | "corporate" | "corridor";

export const BAND_LABEL: Record<BandKey, string> = { price: "Price signals", corporate: "Corporate & capital", corridor: "Corridors & routes" };
export const BAND_NUM: Record<BandKey, number> = { price: 1, corporate: 2, corridor: 3 };

export function bandOf(r: Pick<Resource, "signalBand">): BandKey | null {
  return r.signalBand === "price" || r.signalBand === "corporate" || r.signalBand === "corridor" ? r.signalBand : null;
}
