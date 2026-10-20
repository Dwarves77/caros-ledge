// Ported from old_repo/src/app/api/admin/integrity-flags/route.ts (lines 14-99)
// Ported from old_repo/src/app/api/admin/integrity-flags/route.ts (lines 146-359)
// Ported from old_repo/src/app/api/admin/integrity-flags/[id]/resolve/route.ts (lines 17-115)
import { z } from "zod";

import { allRows, boundedRead, exactCount, qb } from "@/core/db";
import { HttpError, LookupError } from "@/core/http/errors";
import { parseJson, uuid } from "@/core/http/parse";
import { canonicalUrl } from "@/core/shared";

import { PLATFORM_CATEGORIES, PLATFORM_STATUSES } from "../vocab";

import { adminAct, adminRoute, boundedInt, reasonOf, reply } from "./shared";

type Category = (typeof PLATFORM_CATEGORIES)[number];
type Status = (typeof PLATFORM_STATUSES)[number];
const FLAG_PAGE = 100;

const tally = <K extends string>(keys: readonly K[], rows: readonly Record<string, string>[], col: string): Record<K, number> => {
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  for (const r of rows) if (r[col] && r[col] in out) out[r[col] as K] += 1;
  return out;
};

interface BriefFlagRow {
  id: string;
  legacy_id: string | null;
  title: string | null;
  source_url: string | null;
  source_id: string | null;
  agent_integrity_phrase: string | null;
  agent_integrity_flagged_at: string | null;
  updated_at: string | null;
  source: { id: string; name: string; base_tier: number; url: string } | null;
}

/** Per-brief flags: the oldest unresolved first, bounded, with the exact unresolved total (the badge equals this list's total, INV-281). */
async function briefFlags(db: ReturnType<Parameters<Parameters<typeof adminRoute>[1]>[0]["service"]>) {
  const page = await boundedRead<BriefFlagRow>((n) => qb<BriefFlagRow>(db.from("intelligence_items").select("id, legacy_id, title, source_url, source_id, agent_integrity_phrase, agent_integrity_flagged_at, updated_at, source:sources(id, name, base_tier, url)")).eq("agent_integrity_flag", true).is("agent_integrity_resolved_at", null).order("agent_integrity_flagged_at", { ascending: true }).order("id", { ascending: true }).limit(n), { limit: 200 });
  if (page.error) throw new LookupError("intelligence_items flags", page.error);
  const unresolved = await exactCount(qb(db.from("intelligence_items").select("id", { count: "exact", head: true })).eq("agent_integrity_flag", true).is("agent_integrity_resolved_at", null));
  const totalFlagged = await exactCount(qb(db.from("intelligence_items").select("id", { count: "exact", head: true })).eq("agent_integrity_flag", true));
  const items = page.data.map((r) => ({ id: r.id, legacyId: r.legacy_id, title: r.title, sourceUrl: r.source_url, sourceId: r.source_id, sourceName: r.source?.name ?? null, sourceTier: r.source?.base_tier ?? null, phrase: r.agent_integrity_phrase, flaggedAt: r.agent_integrity_flagged_at, updatedAt: r.updated_at }));
  return { items, stats: { totalUnresolved: unresolved, totalFlagged, shown: items.length, capped: unresolved > items.length } };
}

/** Platform flags: a page of the filtered list (open and in review by default) and whole-table counts that stay true under any filter. */
async function platformFlags(db: Parameters<typeof allRows>[0], q: URLSearchParams) {
  const category = (PLATFORM_CATEGORIES as readonly string[]).includes(q.get("category") ?? "") ? (q.get("category") as Category) : null;
  const status = (PLATFORM_STATUSES as readonly string[]).includes(q.get("status") ?? "") ? (q.get("status") as Status) : null;
  const limit = boundedInt(q.get("limit"), FLAG_PAGE, 200);
  const offset = Math.max(0, Number.parseInt(q.get("offset") ?? "0", 10) || 0);
  let list = qb(db.from("integrity_flags").select("*"));
  if (category) list = list.eq("category", category);
  list = status ? list.eq("status", status) : list.in("status", ["open", "in_review"]);
  const { data, error } = await list.order("created_at", { ascending: false }).order("id", { ascending: true }).range(offset, offset + limit);
  if (error) throw new LookupError("integrity_flags", error);
  const counted = await allRows<Record<string, string>>(db, "integrity_flags", "id, category, status");
  const rows = data ?? [];
  return { items: rows.slice(0, limit), counts: { byCategory: tally(PLATFORM_CATEGORIES, counted, "category"), byStatus: tally(PLATFORM_STATUSES, counted, "status"), total: counted.length }, page: { offset, limit, hasMore: rows.length > limit } };
}

export const GET = adminRoute("/api/admin/integrity-flags", async (admin, request) => {
  const q = new URL(request.url).searchParams;
  return reply(admin, q.get("platform") === "1" ? await platformFlags(admin.service(), q) : await briefFlags(admin.service()));
});

const patchBody = z.object({ id: uuid, status: z.enum(PLATFORM_STATUSES), reason: reasonOf });

/** Move a platform flag to a status (admin_set_flag_status, migration 0102): the operator's reason is required, a terminal status stamps who and when and keeps the reason as the resolution note, and the event is written with the change. */
export const PATCH = adminRoute("/api/admin/integrity-flags", async (admin, request) => {
  if (new URL(request.url).searchParams.get("platform") !== "1") throw new HttpError(405, "PATCH is only supported on the platform surface (?platform=1)");
  const body = await parseJson(request, patchBody);
  return reply(admin, { item: await adminAct(admin, "admin_set_flag_status", { p_flag_id: body.id, p_status: body.status, p_reason: body.reason }) });
});

const resolveBody = z.object({ action: z.enum(["replace_url", "mark_resolved"]), reason: reasonOf, newSourceUrl: z.string().trim().max(2000).nullish() });
const httpUrl = (raw: string): string | null => {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? canonicalUrl(u.toString()) : null;
  } catch {
    return null;
  }
};

/**
 * Clear a per-brief flag by an operator resolution (admin_resolve_brief_flag, migration 0102): the item is stamped, a replaced URL is written in its canonical form, and the audit row is the admin_events row of the same
 * transaction, with the operator's reason, the prior URL and the phrase. There is no partial success. The flag is a statement about the brief, so the URL change alone does not recompute it.
 */
export const resolveBriefFlag = adminRoute<{ params: Promise<{ id: string }> }>("/api/admin/integrity-flags/[id]/resolve", async (admin, request, ctx) => {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new HttpError(400, "intelligence_items id required");
  const body = await parseJson(request, resolveBody);
  const next = body.action === "replace_url" ? httpUrl(body.newSourceUrl ?? "") : null;
  if (body.action === "replace_url" && !next) throw new HttpError(400, "newSourceUrl must be an http or https address");
  const done = await adminAct<{ resolved_at: string }>(admin, "admin_resolve_brief_flag", { p_item_id: id, p_action: body.action, p_new_url: next, p_reason: body.reason });
  return reply(admin, { success: true, itemId: id, action: body.action, resolvedAt: done.resolved_at });
});
