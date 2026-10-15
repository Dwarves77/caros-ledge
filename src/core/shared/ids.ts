// Ported from old_repo/src/app/api/workspace/overrides/route.ts (lines 16-27)
// Ported from old_repo/src/lib/tags/server.ts (lines 58-72)
import type { Db } from "@/core/db/clients";
import { isUuid } from "@/core/http/parse";

/**
 * The one identity helper: a UI-side identifier (a uuid or a legacy id such as "o3") to intelligence_items.id.
 * Null means no such item (answer 404); a failed read throws (answer 500), it is never read as "not found".
 */
export async function resolveItemUuid(client: Db, itemId: string): Promise<string | null> {
  if (isUuid(itemId)) return itemId;
  const { data, error } = await client.from("intelligence_items").select("id").eq("legacy_id", itemId).maybeSingle();
  if (error) throw new Error(`resolveItemUuid: intelligence_items read failed: ${error.message}`);
  return (data as { id?: string } | null)?.id ?? null;
}
