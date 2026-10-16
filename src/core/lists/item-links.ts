// Ported from old_repo/src/lib/item-links.ts (lines 1-56)
import { surfaceOf } from "@/core/routing";

export type DetailSurface = "regulations" | "market" | "operations" | "research";

/** The surface an item's page lives on, from the raw item type and domain only (INV-265); an uncategorized item routes to regulations by ruling. */
export function canonicalSurface(item: { type?: string | null; domain?: number | null }): DetailSurface {
  const surface = surfaceOf(item.type ?? null, item.domain ?? null);
  return surface === "market" || surface === "research" || surface === "operations" ? surface : "regulations";
}

export const detailHref = (item: { id: string; type?: string | null; domain?: number | null }): string => `/${canonicalSurface(item)}/${encodeURIComponent(item.id)}`;
