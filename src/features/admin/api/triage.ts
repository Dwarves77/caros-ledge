// Ported from old_repo/src/app/api/admin/triage/ingest-rejections/route.ts (lines 8-112)
// Ported from old_repo/src/app/api/admin/triage/pending-jurisdiction-review/route.ts (lines 9-197)
import { z } from "zod";

import { boundedRead, exactCount, qb } from "@/core/db";
import type { Db } from "@/core/db";
import { HttpError, LookupError } from "@/core/http/errors";
import { parseJson, uuid } from "@/core/http/parse";

import { JURISDICTION_ACTIONS, REJECTION_ACTIONS } from "../vocab";

import { adminDone, adminRoute, reasonOf, reply, text } from "./shared";

const TRIAGE_BOUND = 200;

interface QueueRead {
  items: unknown[];
  total: number;
  capped: boolean;
}

/** The oldest-last page of an unresolved queue and its exact total: a list cut short says so, and a failed read is an error. */
async function readQueue(db: Db, table: string, select: string, openColumn: string, order: string): Promise<QueueRead> {
  const page = await boundedRead<unknown>((n) => qb(db.from(table).select(select)).is(openColumn, null).order(order, { ascending: false }).order("id", { ascending: true }).limit(n), { limit: TRIAGE_BOUND });
  if (page.error) throw new LookupError(table, page.error);
  const total = await exactCount(qb(db.from(table).select("id", { count: "exact", head: true })).is(openColumn, null));
  return { items: page.data, total, capped: total > page.data.length };
}

export const listRejections = adminRoute("/api/admin/triage/ingest-rejections", async (admin) => {
  const q = await readQueue(admin.service(), "ingest_rejections", "id, raw_value, rejection_reason, source_url, source_id, ingest_attempted_at, source:sources(id, name, url)", "triaged_at", "ingest_attempted_at");
  return reply(admin, { items: q.items, total_untriaged: q.total, list_capped: q.capped });
});

const rejectionBody = z.object({ id: uuid, action: z.enum(REJECTION_ACTIONS), reason: reasonOf });

/** Stamp an ingest rejection triaged (admin_triage_rejection, migration 0102): who, when, what and the operator's reason, with the event. Only the stamp is written, never an item (INV-284); a row already triaged answers 409 and a missing one 404 (INV-289). */
export const triageRejection = adminRoute("/api/admin/triage/ingest-rejections", async (admin, request) => {
  const body = await parseJson(request, rejectionBody);
  const done = adminDone<{ triaged_at: string }>(await admin.client.rpc("admin_triage_rejection", { p_id: body.id, p_action: body.action, p_reason: body.reason }));
  return reply(admin, { success: true, id: body.id, triage_action: body.action, triaged_at: done.triaged_at });
});

export const listJurisdictionReview = adminRoute("/api/admin/triage/pending-jurisdiction-review", async (admin) => {
  const q = await readQueue(admin.service(), "pending_jurisdiction_review", "id, intelligence_item_id, current_value, flagged_reason, source_column, flagged_at, item:intelligence_items(id, title, jurisdictions, jurisdiction_iso)", "resolved_at", "flagged_at");
  return reply(admin, { items: q.items, total_unresolved: q.total, list_capped: q.capped });
});

const jurisdictionBody = z.object({ id: uuid, action: z.enum(JURISDICTION_ACTIONS), resolution_value: z.string().trim().max(120).nullish(), reason: reasonOf });

/**
 * Resolve a flagged jurisdiction token (admin_resolve_jurisdiction_review: the item array swap, the queue stamp and the event are ONE database call, INV-283, INV-289). A resolved row answers 409, a missing one 404.
 */
export const resolveJurisdictionReview = adminRoute("/api/admin/triage/pending-jurisdiction-review", async (admin, request) => {
  const body = await parseJson(request, jurisdictionBody);
  const value = text(body.resolution_value);
  if (body.action === "manually-classify" && !value) throw new HttpError(400, "resolution_value is required for manually-classify");
  const data = adminDone(await admin.client.rpc("admin_resolve_jurisdiction_review", { p_review_id: body.id, p_action: body.action, p_resolution: body.action === "manually-classify" ? value : null, p_reason: body.reason }));
  return reply(admin, { success: true, id: body.id, action: body.action, ...data });
});
