// Ported from old_repo/src/app/api/workspace/overrides/route.ts (lines 12-27)
// Ported from old_repo/src/app/api/workspace/personal-state/route.ts (lines 28-43)
import type { Db } from "@/core/db/clients";
import { HttpError, LookupError } from "@/core/http/errors";
import { resolveItemUuid } from "@/core/shared/ids";

/** An item key (uuid or legacy id) to intelligence_items.id: 404 when there is no such item, 503 when the read failed (never "not found"). */
export async function itemUuidOr404(client: Db, itemId: string): Promise<string> {
  let uuid: string | null;
  try {
    uuid = await resolveItemUuid(client, itemId);
  } catch (e) {
    throw new LookupError("intelligence_items", e);
  }
  if (!uuid) throw new HttpError(404, `intelligence_items row not found for itemId=${itemId}`);
  return uuid;
}
