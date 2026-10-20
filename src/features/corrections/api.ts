// Ported from old_repo/src/lib/corrections/admin-api/logic.mjs (lines 1-109)
// Ported from old_repo/src/lib/corrections/admin-api/handlers.ts (lines 1-55)
// The admin corrections API (platform admin only): list with machine evidence and superseded/orphan marks, create and revoke through
// the two RPCs. created_by is the session user, never the body. Every refusal is { error, code }; a failed read is an error status.
import { revalidateItem } from "@/core/cache";
import { fetchAllByIdChunks, type Db } from "@/core/db";
import { isRefusal, requireAdmin } from "@/core/http/guard";
import { isUuid } from "@/core/http/parse";
import { route } from "@/core/http/errors";
import { findOrphanedFactCorrections, latestPerTarget, validateCorrectionInput, type Correction, type CorrectionInput } from "@/core/corrections";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}
const reply = (status: number, body: Record<string, unknown>): Reply => ({ status, body });
const fail = (status: number, code: string, error: string): Reply => reply(status, { error, code });

/** Database errors raised by the correction functions (`correction_<code>: detail`) to their statuses. */
export function mapDbError(error: { message?: string } | null | undefined): Reply {
  const message = String(error?.message ?? "");
  const m = /^correction_([a-z_]+)/.exec(message);
  if (!m) return fail(500, "database_error", message || "database error");
  const code = m[1] as string;
  const detail = message.replace(/^correction_[a-z_]+:\s*/, "");
  if (code === "item_not_found" || code === "claim_not_found" || code === "section_not_found") return fail(404, code, detail);
  if (code === "not_active") return fail(409, "correction_not_active", detail);
  if (code === "reason_required" || code === "actor_required") return fail(400, code, detail);
  return fail(422, code, detail);
}

/** Validate a create request and build the RPC arguments; the actor is the session user. */
export function planCorrection(itemId: string, userId: string, body: unknown): { ok: true; args: Record<string, unknown>; input: CorrectionInput } | { ok: false; reply: Reply } {
  if (!isUuid(String(itemId))) return { ok: false, reply: fail(400, "item_id_invalid", "item id must be a uuid") };
  const v = validateCorrectionInput(body);
  if (!v.ok) return { ok: false, reply: fail(400, v.code, v.error) };
  const { input } = v;
  return { ok: true, input, args: { p_item_id: itemId, p_target_kind: input.target_kind, p_target_ref: input.target_ref, p_op: input.op, p_value: input.value, p_reason: input.reason, p_created_by: userId } };
}

export async function listCorrections(sb: Db, itemId: string): Promise<Reply> {
  if (!isUuid(String(itemId))) return fail(400, "item_id_invalid", "item id must be a uuid");
  const { data: item, error: itemErr } = await sb.from("intelligence_items").select("id").eq("id", itemId).maybeSingle();
  if (itemErr) return fail(500, "database_error", itemErr.message);
  if (!item) return fail(404, "item_not_found", `no item ${itemId}`);
  const { data: rows, error } = await sb.from("item_corrections").select("*").eq("item_id", itemId);
  if (error) return fail(500, "database_error", error.message);
  const corrections = (rows ?? []) as Correction[];
  const evidenceById = new Map<string, { correction_id: string; latest_machine_value?: unknown; observed_count?: number; observed_at?: string | null }>();
  if (corrections.length) {
    try {
      const ev = await fetchAllByIdChunks(corrections.map((c) => String(c.id)), async (slice) => {
        const r = await sb.from("item_correction_evidence").select("*").in("correction_id", slice);
        if (r.error) throw new Error(r.error.message);
        return (r.data ?? []) as { correction_id: string }[];
      });
      for (const e of ev) evidenceById.set(e.correction_id, e);
    } catch (e) {
      return fail(500, "database_error", e instanceof Error ? e.message : String(e));
    }
  }
  const claimRes = await sb.from("section_claim_provenance").select("id, claim_text").eq("intelligence_item_id", itemId);
  if (claimRes.error) return fail(500, "database_error", claimRes.error.message);
  const orphanIds = new Set(findOrphanedFactCorrections(corrections, claimRes.data ?? []).map((c) => c.id));
  const latestIds = new Set([...latestPerTarget(corrections).values()].map((r) => r.id));
  const shaped = corrections
    .map((c) => {
      const active = c.revoked_at === null || c.revoked_at === undefined;
      const e = evidenceById.get(String(c.id));
      return { ...c, active, superseded: active && !latestIds.has(c.id), orphaned: orphanIds.has(c.id), latest_machine_value: e ? (e.latest_machine_value ?? null) : null, machine_observed_count: e ? (e.observed_count ?? 0) : 0, machine_observed_at: e ? (e.observed_at ?? null) : null };
    })
    .sort((a, b) => (Date.parse(String(b.created_at)) || 0) - (Date.parse(String(a.created_at)) || 0));
  const active = shaped.filter((c) => c.active).length;
  return reply(200, { item_id: itemId, counts: { active, revoked: shaped.length - active, orphaned: orphanIds.size }, corrections: shaped });
}

export async function createCorrection(sb: Db, input: { itemId: string; userId: string; body: unknown }): Promise<Reply> {
  const plan = planCorrection(input.itemId, input.userId, input.body);
  if (!plan.ok) return plan.reply;
  const { data, error } = await sb.rpc("create_item_correction", plan.args);
  if (error) return mapDbError(error);
  return reply(201, { id: data, item_id: input.itemId, applied: true });
}

export async function revokeCorrection(sb: Db, input: { itemId: string; correctionId: string; userId: string; body: unknown }): Promise<Reply> {
  if (!isUuid(String(input.itemId))) return fail(400, "item_id_invalid", "item id must be a uuid");
  if (!isUuid(String(input.correctionId))) return fail(400, "correction_id_invalid", "correction id must be a uuid");
  const b = (input.body && typeof input.body === "object" ? input.body : {}) as { reason?: unknown };
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  const { error } = await sb.rpc("revoke_item_correction", { p_item_id: input.itemId, p_correction_id: input.correctionId, p_revoked_by: input.userId, p_reason: reason || null });
  if (error) return mapDbError(error);
  return reply(200, { id: input.correctionId, item_id: input.itemId, revoked: true });
}

/** "fresh" when the detail cache was flushed, "stale" when the flush threw: the correction has been recorded either way, and a page cached before it may show the suppressed claim until the entry expires (INV-270), so the answer says so. */
function flushDetailCache(itemId: string): "fresh" | "stale" {
  try {
    revalidateItem(itemId);
    return "fresh";
  } catch {
    return "stale";
  }
}
const withCache = (out: Reply, itemId: string): Reply => ({ ...out, body: { ...(out.body as object), cache: flushDetailCache(itemId) } });
const send = (r: Reply, headers: Record<string, string>): Response => Response.json(r.body, { status: r.status, headers });
async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

type ItemCtx = { params: Promise<{ id: string }> };
type RevokeCtx = { params: Promise<{ id: string; correctionId: string }> };

export const GET = route<ItemCtx>("/api/admin/items/[id]/corrections", async (request, ctx) => {
  const auth = await requireAdmin(request);
  if (isRefusal(auth)) return auth;
  const { id } = await ctx.params;
  return send(await listCorrections(auth.service(), id), auth.headers);
});

export const POST = route<ItemCtx>("/api/admin/items/[id]/corrections", async (request, ctx) => {
  const auth = await requireAdmin(request);
  if (isRefusal(auth)) return auth;
  const { id } = await ctx.params;
  const body = await readBody(request);
  if (body === undefined) return send(fail(400, "invalid_json", "Invalid JSON body"), auth.headers);
  const out = await createCorrection(auth.service(), { itemId: id, userId: auth.userId, body });
  return send(out.status === 201 ? withCache(out, id) : out, auth.headers);
});

export const REVOKE = route<RevokeCtx>("/api/admin/items/[id]/corrections/[correctionId]/revoke", async (request, ctx) => {
  const auth = await requireAdmin(request);
  if (isRefusal(auth)) return auth;
  const { id, correctionId } = await ctx.params;
  const out = await revokeCorrection(auth.service(), { itemId: id, correctionId, userId: auth.userId, body: await readBody(request) });
  return send(out.status === 200 ? withCache(out, id) : out, auth.headers);
});
