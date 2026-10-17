// Ported from old_repo/src/lib/detail/id-redirect.ts (lines 1-63)
// Ported from old_repo/src/lib/detail/item-id-filter.ts (lines 1-7)
// A uuid URL renders where it belongs or does not render (INV-269): the owning surface's page, under the item's legacy slug when it has one, else not found. The property (every uuid URL lands
// on a page that renders that item, or on not-found when no surface admits it) is proven by tests/detail/id-redirect.test.ts over a fixture corpus.
import type { Db } from "@/core/db";
import { isUuid } from "@/core/http/parse";
import { canonicalSurface, detailHref, type DetailSurface } from "@/core/lists";

export const isItemUuid = (value: string): boolean => isUuid(value);
/** The column a URL id names: `id` for a uuid, `legacy_id` for anything else. */
export const itemIdColumn = (value: string): "id" | "legacy_id" => (isItemUuid(value) ? "id" : "legacy_id");

export const ID_REDIRECT_COLUMNS = "id, legacy_id, item_type, domain, provenance_status";
export interface IdRedirectRow {
  id: string;
  legacy_id: string | null;
  item_type: string | null;
  domain: number | null;
  provenance_status: string | null;
}
export type IdRedirectDecision = { kind: "render" } | { kind: "redirect"; to: string } | { kind: "not-found" };

/** The surface that admits the row: only a verified row is admitted, on the surface its raw item_type and domain map to. */
export const admittedSurfaceFor = (row: IdRedirectRow): DetailSurface | null => (row.provenance_status === "verified" ? canonicalSurface({ type: row.item_type, domain: row.domain }) : null);

export function decideIdRedirect(surface: DetailSurface, row: IdRedirectRow | null): IdRedirectDecision {
  if (!row) return { kind: "render" };
  const home = admittedSurfaceFor(row);
  if (!home) return { kind: "not-found" };
  if (home === surface && !row.legacy_id) return { kind: "render" };
  return { kind: "redirect", to: detailHref({ id: row.legacy_id || row.id, type: row.item_type, domain: row.domain }) };
}

/** The decision for one URL id: a non-uuid renders as it is; a uuid is looked up on the caller's client. A failed lookup throws (the page says so with Retry); it is never read as "render". */
export async function resolveIdRedirect(db: Db, surface: DetailSurface, id: string): Promise<IdRedirectDecision> {
  if (!isItemUuid(id)) return { kind: "render" };
  const { data, error } = await db.from("intelligence_items").select(ID_REDIRECT_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`id-redirect lookup failed: ${error.message}`);
  return decideIdRedirect(surface, (data as IdRedirectRow | null) ?? null);
}
