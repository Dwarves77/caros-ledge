// Ported from old_repo/src/app/api/admin/corpus-turn-requests/route.ts (lines 61-271)
// Ported from old_repo/src/app/api/admin/integrity-flags/[id]/regenerate/route.ts (lines 17-43)
// Ported from old_repo/src/app/api/admin/sources/[id]/regenerate-brief/route.ts (lines 20-28)
import { z } from "zod";

import { allRows, boundedRead, exactCount, qb, rowsByIds } from "@/core/db";
import type { Db } from "@/core/db";
import { HttpError, LookupError } from "@/core/http/errors";
import { parseJson, uuid } from "@/core/http/parse";
import { runTurn } from "@/core/turn";

import { adminDeps } from "./deps";
import { adminRoute, reply } from "./shared";

export const OPEN_BOUND = 200;
const INSERT_CHUNK = 500;
/** The one reason an operator request carries: the value the trigger never writes. */
const MANUAL = "manual";

interface Live {
  id: string;
}
const liveItems = (db: Db, source?: string) => allRows<Live>(db, "intelligence_items", "id", { where: (q) => (source ? q.eq("source_id", source) : q).eq("is_archived", false).eq("provenance_status", "verified") });
const openItemIds = async (db: Db): Promise<Set<string>> => new Set((await allRows<{ id: string; intelligence_item_id: string }>(db, "corpus_turn_requests", "id, intelligence_item_id", { where: (q) => q.is("consumed_at", null) })).map((r) => r.intelligence_item_id));

/** The open turn queue, oldest first, with each item's title, the exact open count, and the last time anything was consumed (the signal that something is actually running). */
export const GET = adminRoute("/api/admin/corpus-turn-requests", async (admin) => {
  const db = admin.service();
  const page = await boundedRead<{ id: string; intelligence_item_id: string; reason: string; requested_at: string }>((n) => qb<{ id: string; intelligence_item_id: string; reason: string; requested_at: string }>(db.from("corpus_turn_requests").select("id, intelligence_item_id, reason, requested_at")).is("consumed_at", null).order("requested_at", { ascending: true }).order("id", { ascending: true }).limit(n), { limit: OPEN_BOUND });
  if (page.error) throw new LookupError("corpus_turn_requests", page.error);
  const total = await exactCount(qb(db.from("corpus_turn_requests").select("id", { count: "exact", head: true })).is("consumed_at", null));
  const items = await rowsByIds<{ id: string; title: string; legacy_id: string | null }>(db, "intelligence_items", "id, title, legacy_id", page.data.map((r) => r.intelligence_item_id));
  const byId = new Map(items.map((i) => [i.id, i]));
  const last = await db.from("corpus_turn_requests").select("consumed_at").not("consumed_at", "is", null).order("consumed_at", { ascending: false }).limit(1).maybeSingle();
  if (last.error) throw new LookupError("corpus_turn_requests", last.error);
  return reply(admin, { open: page.data.map((r) => ({ ...r, item: byId.get(r.intelligence_item_id) ?? null })), open_count: total, capped: total > page.data.length, last_consumed_at: (last.data as { consumed_at: string } | null)?.consumed_at ?? null });
});

/** Open one manual request for each of these items that has none; the ids without a live item are not asked for. Returns the number inserted. */
async function request(db: Db, itemIds: readonly string[]): Promise<{ inserted: number; already_open: number }> {
  const open = await openItemIds(db);
  const fresh = itemIds.filter((id) => !open.has(id));
  let inserted = 0;
  for (let i = 0; i < fresh.length; i += INSERT_CHUNK) {
    const { data, error } = await db.from("corpus_turn_requests").insert(fresh.slice(i, i + INSERT_CHUNK).map((id) => ({ intelligence_item_id: id, reason: MANUAL }))).select("id");
    if (error) throw new HttpError(500, `insert failed after ${inserted} row(s): ${error.message}`);
    inserted += data?.length ?? 0;
  }
  return { inserted, already_open: itemIds.length - fresh.length };
}

const body = z.union([z.object({ itemId: uuid }), z.object({ sourceId: uuid }), z.object({ all: z.literal(true) }), z.object({ sweep: z.object({ topic: z.string().trim().min(2).max(200), jurisdiction: z.string().trim().max(60).optional() }) })]);

/**
 * The one entry for every manual trigger (INV-292, rule 17). A regeneration or re-capture request for one item, every live item of one source, or the whole live corpus is ONE open corpus_turn_requests row per item,
 * reason manual, consumed by the turn with its outcome in the harness ledger; no route runs a model. A topic-and-jurisdiction sweep is dispatched as the research walk through the turn, in the mode the frame resolves
 * (while the cadence is off it is planned, not run, and the answer says so).
 */
export const POST = adminRoute("/api/admin/corpus-turn-requests", async (admin, req) => {
  const b = await parseJson(req, body);
  const db = admin.service();
  if ("sweep" in b) {
    const query = [b.sweep.topic, b.sweep.jurisdiction].filter(Boolean).join(" ");
    const result = await runTurn({ stage: "sweep-research", mode: "apply", trigger: "dispatch", chain: false, input: { "sweep-research": { walk: { query } } } }, { d: adminDeps(db), env: process.env, now: () => new Date() });
    const run = result.runs[0];
    return reply(admin, { ok: result.exit === 0, dispatched: "sweep-research", query, mode: result.resolved.mode, reason: result.resolved.reason, outcome: run?.row?.outcome ?? null, counts: run?.result?.counts ?? {}, notes: run?.result?.notes ?? [], rootRunId: result.rootRunId });
  }
  if ("all" in b) {
    const live = (await liveItems(db)).map((r) => r.id);
    return reply(admin, { ok: true, ...(await request(db, live)), total_live: live.length });
  }
  if ("sourceId" in b) {
    const src = await db.from("sources").select("id").eq("id", b.sourceId).maybeSingle();
    if (src.error) throw new LookupError("sources", src.error);
    if (!src.data) throw new HttpError(404, `source ${b.sourceId} not found`);
    const live = (await liveItems(db, b.sourceId)).map((r) => r.id);
    return reply(admin, { ok: true, ...(await request(db, live)), total_live: live.length });
  }
  const item = await db.from("intelligence_items").select("id, is_archived, provenance_status").eq("id", b.itemId).maybeSingle();
  if (item.error) throw new LookupError("intelligence_items", item.error);
  if (!item.data) throw new HttpError(404, `item ${b.itemId} not found`);
  const it = item.data as { is_archived: boolean; provenance_status: string };
  if (it.is_archived || it.provenance_status !== "verified") throw new HttpError(409, "item is not live (archived or not verified): nothing for a corpus turn to act on");
  const r = await request(db, [b.itemId]);
  return reply(admin, { ok: true, inserted: r.inserted, already_open: r.already_open > 0 });
});
