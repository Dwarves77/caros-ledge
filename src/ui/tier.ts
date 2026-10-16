// Ported from old_repo/src/components/ui/Chips.tsx (lines 72-108)
// The one tier clamp: the vocabulary's own ceiling, never a literal (B-2144). Deep import: the sources barrel does not export SOURCE_TIER_MAX (INTERFACE GAP).
import { SOURCE_TIER_MAX } from "@/core/sources/tier-contract";

export const TIER_MAX: number = SOURCE_TIER_MAX;
export const clampTier = (tier: number): number => Math.max(1, Math.min(TIER_MAX, Math.round(tier)));
