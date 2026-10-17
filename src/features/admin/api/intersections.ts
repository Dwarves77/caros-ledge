// Ported from old_repo/src/app/api/admin/intersections/route.ts (lines 8-77)
import { rowsByIds } from "@/core/db";
import { assemblePairs, readAllEdges } from "@/core/flywheel";

import { adminRoute, boundedInt, reply } from "./shared";

interface PairItemRow {
  id: string;
  title: string;
  legacy_id: string | null;
  priority: string | null;
  intersection_summary: string | null;
  item_type: string | null;
  domain: number | null;
}

/** Cross-reference pairs above a score (or explicitly linked), strongest first: the full edge set, the live items it touches, then the one pure assembly. */
export const GET = adminRoute("/api/admin/intersections", async (admin, request) => {
  const q = new URL(request.url).searchParams;
  const asked = Number.parseFloat(q.get("minScore") ?? "");
  const minScore = Number.isFinite(asked) ? Math.min(1, Math.max(0, asked)) : 0.3;
  const limit = boundedInt(q.get("limit"), 100, 500);
  const db = admin.service();
  const edges = await readAllEdges(db);
  const items = await rowsByIds<PairItemRow>(db, "intelligence_items", "id, title, legacy_id, priority, intersection_summary, item_type, domain", edges.flatMap((e) => [e.source_item_id, e.target_item_id]), "id", "id");
  const { pairs, stats } = assemblePairs(edges, new Map(items.map((i) => [i.id, i])), { minScore, limit });
  return reply(admin, { intersections: pairs, stats, params: { minScore, limit } });
});
