// Ported from old_repo/src/app/api/admin/corpus-turn-requests/route.ts (lines 61-271)
// Ported from old_repo/src/app/api/admin/integrity-flags/[id]/regenerate/route.ts (lines 17-43)
// Ported from old_repo/src/app/api/admin/sources/[id]/regenerate-brief/route.ts (lines 20-28)
import { z } from "zod";

import { boundedRead, exactCount, qb, rowsByIds } from "@/core/db";
import { LookupError } from "@/core/http/errors";
import { parseJson, parseWith, uuid } from "@/core/http/parse";
import { runTurn } from "@/core/turn";

import { adminDeps } from "./deps";
import { adminAct, adminRoute, reasonOf, reply } from "./shared";

const OPEN_BOUND = 200;

/** The open turn queue, oldest first, with each item's title, the exact open count, and the last time anything was consumed (the signal that something is actually running). */
export const GET = adminRoute("/api/admin/corpus-turn-requests", async (admin, request) => {
  const q = new URL(request.url).searchParams;
  if (q.get("preview")) {
    const scope = q.get("preview") === "source" ? "source" : "all";
    const sourceId = scope === "source" ? parseWith(uuid, q.get("source_id"), "source_id") : null;
    return reply(admin, await adminAct(admin, "admin_corpus_turn_preview", { p_scope: scope, p_source_id: sourceId }));
  }
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

const body = z.union([z.object({ itemId: uuid, reason: reasonOf }), z.object({ sourceId: uuid, reason: reasonOf }), z.object({ all: z.literal(true), reason: reasonOf }), z.object({ sweep: z.object({ topic: z.string().trim().min(2).max(200), jurisdiction: z.string().trim().max(60).optional() }) })]);

/**
 * The one entry for every manual trigger (INV-292, rule 17). A regeneration or re-capture request for one item, every live item of one source, or the whole live corpus is ONE open corpus_turn_requests row per item,
 * reason manual, consumed by the turn with its outcome in the harness ledger; no route runs a model. The requests, their counts and the operator's reason are one database call (admin_request_corpus_turns, migration 0102); GET ?preview= gives the count before the click. A topic-and-jurisdiction sweep is dispatched as the research walk through the turn, in the mode the frame resolves
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
  const scoped = "all" in b ? { p_scope: "all", p_source_id: null, p_item_id: null } : "sourceId" in b ? { p_scope: "source", p_source_id: b.sourceId, p_item_id: null } : { p_scope: "item", p_source_id: null, p_item_id: b.itemId };
  const done = await adminAct<{ inserted: number; already_open: number; total_live: number }>(admin, "admin_request_corpus_turns", { ...scoped, p_reason: b.reason });
  return reply(admin, { ok: true, ...done, ...("itemId" in b ? { already_open: done.already_open > 0 } : {}) });
});
