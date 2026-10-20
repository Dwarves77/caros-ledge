// Ported from old_repo/src/lib/cache/revalidate-item.ts (lines 8-33)
// Ported from old_repo/scripts/lib/revalidate.mjs (lines 14-21)
import { revalidateTag } from "next/cache";

export type DetailSurface = "regulations" | "market" | "research" | "operations";

/** The coarse tag on every per-item detail cache entry: flushing it is id-independent, so it is the correctness-bearing flush for a pipeline that holds only the item's UUID. */
export const INTEL_ITEMS_TAG = "intel-items";
/** The precise per-item tag; `id` is the UI-side id (legacy_id or uuid) the detail route reads by. */
export const itemTag = (id: string): string => `item:${id}`;

/** Invalidate the detail cache for one item: the precise tag AND the coarse one, so the flush lands whichever id form keyed the entry. Call from a route or server-action scope. */
export function revalidateItem(id: string): void {
  revalidateTag(itemTag(id), "max");
  revalidateTag(INTEL_ITEMS_TAG, "max");
}

