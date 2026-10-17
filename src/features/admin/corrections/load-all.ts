// Ported from old_repo/src/components/admin/corrections/load-all.mjs (lines 12-60)
import { findOrphanedFactCorrections, latestPerTarget, readAllCorrections } from "@/core/corrections/model";
import { fetchAllByIdChunks, fetchAllRows, rowsByIds } from "@/core/db";
import type { Db } from "@/core/db";

import type { CorrectionData } from "./types";

/** Items per claims read; one chunk is one `in` list, paged until a short page. */
const CLAIM_CHUNK = 50;

/**
 * Every correction, newest first, with its item's title, its state and its orphan mark. An item whose claims could not be read is COUNTED as `unchecked`, never guessed orphaned (an unreadable chunk is not an
 * empty one). A failed correction or title read throws.
 */
export async function loadAllCorrections(db: Db): Promise<{ rows: CorrectionData[]; unchecked: number }> {
  const raw = await readAllCorrections(db);
  const latestIds = new Set([...latestPerTarget(raw).values()].map((r) => r.id));
  const titles = new Map((await rowsByIds<{ id: string; title: string }>(db, "intelligence_items", "id, title", raw.map((r) => r.item_id))).map((i) => [i.id, i.title]));
  const factItems = [...new Set(raw.filter((r) => r.target_kind === "fact" && !r.revoked_at).map((r) => r.item_id))];
  const unreadable = new Set<string>();
  type Claim = { id: string; claim_text: string; intelligence_item_id: string };
  const claims = await fetchAllByIdChunks<Claim>(
    factItems,
    async (slice) => {
      try {
        return await fetchAllRows<Claim>((from, to) => db.from("section_claim_provenance").select("id, claim_text, intelligence_item_id").in("intelligence_item_id", slice).order("id").range(from, to));
      } catch {
        for (const id of slice) unreadable.add(id);
        return [];
      }
    },
    { chunk: CLAIM_CHUNK, manyPerId: true },
  );
  const orphaned = new Set<string>();
  for (const itemId of factItems) {
    if (unreadable.has(itemId)) continue;
    for (const c of findOrphanedFactCorrections(raw.filter((r) => r.item_id === itemId), claims.filter((c) => c.intelligence_item_id === itemId))) orphaned.add(String(c.id));
  }
  const rows = raw
    .map((r) => ({ ...r, active: !r.revoked_at, superseded: !r.revoked_at && !latestIds.has(r.id), orphaned: orphaned.has(String(r.id)), item_title: titles.get(r.item_id) ?? null }) as unknown as CorrectionData)
    .sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0));
  return { rows, unchecked: unreadable.size };
}
