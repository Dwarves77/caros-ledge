// Ported from old_repo/src/components/map/MapView.tsx (lines 69-71)
// The marker diameter for an item count: grows with the square root, between 22 and 56 px (the hit area is 44 px at least, in MapView).
const MARKER_MIN = 22;
const MARKER_MAX = 56;
export const markerSize = (count: number): number => Math.round(Math.min(MARKER_MAX, MARKER_MIN + Math.sqrt(Math.max(0, count - 2)) * 2.9));
