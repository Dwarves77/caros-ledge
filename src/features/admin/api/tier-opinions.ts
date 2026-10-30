// Ported from old_repo/src/app/api/admin/sources/tier-opinions/route.ts (lines 29-169)
import { z } from "zod";

import { rowsByIds } from "@/core/db";
import type { Db } from "@/core/db";
import { dbError, HttpError, LookupError } from "@/core/http/errors";
import { parseJson, uuid } from "@/core/http/parse";

import { applyTierOverride } from "./source-controls";
import { adminRoute, reply, text } from "./shared";

const OPINION_WINDOW_DAYS = 90;

/** The most frequent tier among the analyst opinions (first seen wins a tie); null for none. Pure. */
function modalTier(values: readonly number[] | null | undefined): number | null {
  const counts = new Map<number, number>();
  for (const v of values ?? []) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [tier, n] of counts) if (n > bestCount) [best, bestCount] = [tier, n];
  return best;
}

interface Disagreement {
  target_source_id: string;
  current_base_tier: number | null;
  opined_tiers: number[] | null;
  opinion_count: number;
  distinct_disagreeing_tiers: number;
}
interface SourceRow {
  id: string;
  name: string;
  url: string | null;
  base_tier: number;
  effective_tier: number | null;
  tier_override: number | null;
  override_reason: string | null;
}

/** Sources whose analyst tier opinions disagree with the standing tier, with the modal analyst tier and the delta (INV-042: the class table's own opinions never move a tier, this is their reader). */
export const GET = adminRoute("/api/admin/sources/tier-opinions", async (admin) => {
  const db = admin.service();
  const { data, error } = await db.rpc("get_tier_opinion_disagreements", { window_days: OPINION_WINDOW_DAYS });
  if (error) throw new LookupError("get_tier_opinion_disagreements", error);
  const rows = (data ?? []) as Disagreement[];
  const sources = await rowsByIds<SourceRow>(db, "sources", "id, name, url, base_tier, effective_tier, tier_override, override_reason", rows.map((r) => r.target_source_id));
  const byId = new Map(sources.map((s) => [s.id, s]));
  const items = rows.map((d) => {
    const s = byId.get(d.target_source_id);
    const analyst = modalTier(d.opined_tiers);
    const effective = s?.tier_override ?? s?.effective_tier ?? s?.base_tier ?? d.current_base_tier;
    return { source_id: d.target_source_id, source_name: s?.name ?? null, source_url: s?.url ?? null, base_tier: s?.base_tier ?? d.current_base_tier, effective_tier: effective, tier_override: s?.tier_override ?? null, override_reason: s?.override_reason ?? null, analyst_tier: analyst, opined_tiers: d.opined_tiers ?? [], opinion_count: Number(d.opinion_count), distinct_disagreeing_tiers: d.distinct_disagreeing_tiers, delta: analyst !== null && effective !== null ? analyst - effective : null };
  });
  return reply(admin, { items });
});

async function dismiss(db: Db, actorId: string, sourceId: string, reason: string | null): Promise<number> {
  const { data, error } = await db.from("source_tier_opinions").update({ dismissed_at: new Date(performance.timeOrigin + performance.now()).toISOString(), dismissed_by: actorId, dismissed_reason: reason }).eq("target_source_id", sourceId).is("dismissed_at", null).select("id");
  if (error) throw dbError(error);
  return data?.length ?? 0;
}

const body = z.object({ source_id: uuid, action: z.enum(["accept", "reject"]), tier: z.number().int().min(1).max(7).optional(), reason: z.string().trim().max(2000).nullish() });

/**
 * The operator answers a disagreement (INV-286). Accept is a tier_override at the analyst tier WITH a reason (the one tier path), then the dismissal of the opinions it answers; reject is the dismissal alone.
 * There is no defer: it wrote nothing. When the override landed and the dismissal did not, the answer says so (partial) and the row stays in the queue for the operator to close.
 */
export const POST = adminRoute("/api/admin/sources/tier-opinions", async (admin, request) => {
  const b = await parseJson(request, body);
  const db = admin.service();
  const reason = text(b.reason);
  if (b.action === "accept") {
    if (b.tier === undefined) throw new HttpError(400, "tier is required to accept");
    if (!reason) throw new HttpError(400, "a reason is required to accept a tier");
    const done = await applyTierOverride(db, admin.userId, b.source_id, { tier: b.tier, reason });
    try {
      return reply(admin, { success: true, source_id: b.source_id, action: "accept", override: done, dismissed_count: await dismiss(db, admin.userId, b.source_id, reason) });
    } catch (e) {
      return reply(admin, { success: false, partial: true, source_id: b.source_id, action: "accept", error: `the override landed but the opinions were not dismissed: ${e instanceof Error ? e.message : String(e)}`, override: done }, 500);
    }
  }
  return reply(admin, { success: true, source_id: b.source_id, action: "reject", dismissed_count: await dismiss(db, admin.userId, b.source_id, reason) });
});
