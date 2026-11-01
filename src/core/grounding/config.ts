// Ported from old_repo/src/lib/agent/generation-config.ts (lines 15-15)
// Ported from old_repo/src/lib/agent/generation-config.ts (lines 32-32)
// Ported from old_repo/src/lib/agent/generation-config.ts (lines 38-38)
// Ported from old_repo/src/lib/agent/generation-config.ts (lines 47-49)
// Ported from old_repo/src/lib/agent/section-grounding.mjs (lines 3-15)
// The size doctrine (ADR-016, RD-12): storage is never capped below a sanity ceiling, a window cap is applied OVER a complete
// capture, and a cap either never binds or fails loud (a truncation event the caller surfaces). No environment reads: the knobs
// are constants, changed in a reviewed diff. Nothing here sizes a model call: no model runs.
export const GROUND_CONFIG = Object.freeze({
  /** Pathological-page sanity ceiling on one capture (characters). Real documents are KB to low MB. */
  STORAGE_MAX_CHARS: 10_000_000,
  /** The window the pool text export gives the author; floor-qualifying sources are always whole. */
  SYNTH_INPUT_BUDGET_CHARS: 560_000,
  /** A single floor-qualifying source over this is surfaced as a context-ceiling wall, never silently sliced. */
  SYNTH_PRIMARY_HARD_CEILING_CHARS: 560_000,
  /** A brief section over this reaches the grounder sliced and SURFACED, never silent. */
  GROUND_SECTION_HARD_CEILING_CHARS: 200_000,
  /** A capture shorter than this is a stub, not content (the usable-capture floor). */
  MIN_USABLE_POOL_CHARS: 200,
  /** A span shorter than this is never re-homed or nominated (too short to place safely). */
  MIN_SPAN_CHARS: 24,
  MAX_NOMINATION_SPAN: 1000,
  /** Nominations offered to the author per uncovered slot. */
  MAX_NOMINATIONS_PER_SLOT: 3,
  /** Rows of one item's pool a paginated read may return before it fails loud (a series-backed item holds one capture per observed week: PRODUCER-CAPTURE-1). */
  MAX_ITEM_ROWS: 1000,
});

export interface TruncEvent { url: string; collected: number; fullLength: number; cap: number; transport: string }
