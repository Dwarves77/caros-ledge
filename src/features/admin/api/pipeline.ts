// Ported from old_repo/src/components/admin/ResearchPipelineQueueView.tsx (lines 66-101)
import { boundedRead, exactCount, qb, type Qb } from "@/core/db";
import { LookupError } from "@/core/http/errors";
import { surfaceOf } from "@/core/routing";

import { adminRoute, reply } from "./shared";

const PIPELINE_BOUND = 200;

interface Draft {
  id: string;
  legacy_id: string | null;
  title: string;
  summary: string | null;
  item_type: string | null;
  domain: number | null;
  severity: string | null;
  added_date: string | null;
  last_regenerated_at: string | null;
  agent_integrity_flag: boolean | null;
  provenance_status: string | null;
  source: { id: string; name: string | null; category: string | null } | null;
}

/**
 * The items the machine gates are still holding: live-lifecycle (not archived) and not yet verified, newest first, with the exact total. Customer visibility gates on provenance_status = verified; nothing here is
 * published by a person. Each row names the surface it would appear on once the gates pass.
 */
export const GET = adminRoute("/api/admin/pipeline/drafts", async (admin) => {
  const db = admin.service();
  const held = <T,>(q: Qb<T>): Qb<T> => q.eq("is_archived", false).neq("provenance_status", "verified");
  const page = await boundedRead<Draft>((n) => held(qb<Draft>(db.from("intelligence_items").select("id, legacy_id, title, summary, item_type, domain, severity, added_date, last_regenerated_at, agent_integrity_flag, provenance_status, source:sources(id, name, category)"))).order("added_date", { ascending: false }).order("id", { ascending: true }).limit(n), { limit: PIPELINE_BOUND });
  if (page.error) throw new LookupError("intelligence_items", page.error);
  const total = await exactCount(held(qb(db.from("intelligence_items").select("id", { count: "exact", head: true }))));
  const items = page.data.map((r) => ({ ...r, surface: surfaceOf(r.item_type ?? "", r.domain ?? null) }));
  return reply(admin, { items, total, capped: total > items.length });
});
