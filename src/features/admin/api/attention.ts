// Ported from old_repo/src/app/api/admin/attention/logic.ts (lines 1-52)
// Ported from old_repo/src/app/api/admin/attention/route.ts (lines 17-45)
import { isMissingObject, type Db } from "@/core/db";
import { LookupError } from "@/core/http/errors";

import { adminRoute, notInstalled, reply } from "./shared";

export interface AttentionCounts {
  provisional_sources_pending: number;
  staged_updates_pending: number;
  staged_updates_materialization_failed: number;
  integrity_flags_unresolved: number;
  platform_integrity_flags_open: number;
  source_attribution_mismatches: number;
  auto_approved_awaiting_spotcheck: number;
  coverage_gaps_critical: number;
  /** Absent until the database reports it (migration 0035); a missing count is not a zero. */
  ingest_rejections_untriaged?: number;
  total: number;
}

/** The one attention read: the rpc's single row. A failed read or an empty answer throws (503); it is never a row of zeros. */
export async function readAttention(db: Db): Promise<AttentionCounts> {
  const { data, error } = await db.rpc("admin_attention_counts");
  if (isMissingObject(error)) throw notInstalled("admin_attention_counts", "0035");
  if (error) throw new LookupError("admin_attention_counts", error);
  const row = (Array.isArray(data) ? data[0] : data) as AttentionCounts | undefined;
  if (!row) throw new LookupError("admin_attention_counts", "the rpc returned no row");
  return row;
}

export const GET = adminRoute("/api/admin/attention", async (admin) => reply(admin, await readAttention(admin.service()), 200, { "Cache-Control": "private, no-store" }));
