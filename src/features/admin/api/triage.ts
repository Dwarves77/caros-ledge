// Ported from old_repo/src/app/api/admin/triage/ingest-rejections/route.ts (lines 8-112)
// Ported from old_repo/src/app/api/admin/triage/pending-jurisdiction-review/route.ts (lines 9-197)
import { z } from "zod";

import { boundedRead, exactCount, isMissingObject, qb } from "@/core/db";
import type { Db } from "@/core/db";
import { dbError, HttpError, LookupError } from "@/core/http/errors";
import { parseJson, uuid } from "@/core/http/parse";

import { JURISDICTION_ACTIONS, REJECTION_ACTIONS } from "../vocab";

import { adminRoute, notInstalled, reply, text } from "./shared";

export const TRIAGE_BOUND = 200;

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

const rejectionBody = z.object({ id: uuid, action: z.enum(REJECTION_ACTIONS), notes: z.string().trim().max(2000).nullish() });

/** Stamp an ingest rejection triaged: who, when, what, and a note. Only the stamp is written, never an item (INV-284); a row already triaged answers 409 and a missing one 404 (INV-289). */
export const triageRejection = adminRoute("/api/admin/triage/ingest-rejections", async (admin, request) => {
  const body = await parseJson(request, rejectionBody);
  const db = admin.service();
  const at = new Date().toISOString();
  const { data, error } = await db.from("ingest_rejections").update({ triage_action: body.action, triaged_by: admin.userId, triaged_at: at, triage_notes: text(body.notes) }).eq("id", body.id).is("triaged_at", null).select("id");
  if (error) throw dbError(error);
  if (!data?.length) {
    const found = await db.from("ingest_rejections").select("id").eq("id", body.id).maybeSingle();
    if (found.error) throw new LookupError("ingest_rejections", found.error);
    throw new HttpError(found.data ? 409 : 404, found.data ? "row already triaged" : "row not found");
  }
  return reply(admin, { success: true, id: body.id, triage_action: body.action, triaged_at: at });
});

export const listJurisdictionReview = adminRoute("/api/admin/triage/pending-jurisdiction-review", async (admin) => {
  const q = await readQueue(admin.service(), "pending_jurisdiction_review", "id, intelligence_item_id, current_value, flagged_reason, source_column, flagged_at, item:intelligence_items(id, title, jurisdictions, jurisdiction_iso)", "resolved_at", "flagged_at");
  return reply(admin, { items: q.items, total_unresolved: q.total, list_capped: q.capped });
});

const jurisdictionBody = z.object({ id: uuid, action: z.enum(JURISDICTION_ACTIONS), resolution_value: z.string().trim().max(120).nullish() });

/**
 * Resolve a flagged jurisdiction token. The item array swap and the queue stamp are ONE database call (INV-283, INV-289): either both land or neither does, so a
 * failed second write can no longer leave an item changed under an open row. A resolved row answers 409, a missing one 404.
 */
export const resolveJurisdictionReview = adminRoute("/api/admin/triage/pending-jurisdiction-review", async (admin, request) => {
  const body = await parseJson(request, jurisdictionBody);
  const value = text(body.resolution_value);
  if (body.action === "manually-classify" && !value) throw new HttpError(400, "resolution_value is required for manually-classify");
  const { data, error } = await admin.service().rpc("resolve_pending_jurisdiction_review", { p_review_id: body.id, p_action: body.action, p_resolution: body.action === "manually-classify" ? value : null, p_actor: admin.userId });
  if (isMissingObject(error)) throw notInstalled("resolve_pending_jurisdiction_review", "0035");
  if (error) throw dbError(error, { notFound: "row not found" });
  return reply(admin, { success: true, id: body.id, action: body.action, ...(data as Record<string, unknown> | null) });
});
