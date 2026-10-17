// Ported from old_repo/src/app/api/admin/sources/[id]/pause/route.ts (lines 7-43)
// Ported from old_repo/src/app/api/admin/sources/[id]/visibility/route.ts (lines 7-43)
// Ported from old_repo/src/app/api/admin/sources/[id]/tier-override/route.ts (lines 33-255)
// Ported from old_repo/src/app/api/admin/sources/commit-tier-change/logic.ts (lines 50-66)
// Ported from old_repo/src/app/api/admin/sources/commit-tier-change/route.ts (lines 9-52)
// Ported from old_repo/src/app/api/admin/sources/[id]/bias-tags/logic.ts (lines 23-86)
// Ported from old_repo/src/app/api/admin/sources/[id]/bias-tags/route.ts (lines 12-124)
// Ported from old_repo/src/app/api/admin/sources/[id]/fetch-now/route.ts (lines 48-144)
import { z } from "zod";

import type { Db } from "@/core/db";
import { fetchDirect, FetchHoldError } from "@/core/fetch";
import { decideFetchOutcome } from "@/core/fetch/reachability";
import { dbError, HttpError, LookupError } from "@/core/http/errors";
import { parseJson, parseWith, uuid } from "@/core/http/parse";
import { notUnderTierOverride } from "@/core/sources/tier-writers";

import { adminRoute, reply, text, writeTrustEvent } from "./shared";

type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx): Promise<string> => parseWith(uuid, (await ctx.params).id, "source id");

/** Update one source row and report a row that matched nothing as a 404: a success that changed nothing is not a success. */
async function updateSource(db: Db, id: string, patch: Record<string, unknown>): Promise<void> {
  const { data, error } = await db.from("sources").update(patch).eq("id", id).select("id");
  if (error) throw dbError(error);
  if (!data?.length) throw new HttpError(404, "source not found");
}

export const pauseSource = adminRoute<Ctx>("/api/admin/sources/[id]/pause", async (admin, request, ctx) => {
  const { paused } = await parseJson(request, z.object({ paused: z.boolean() }));
  const id = await idOf(ctx);
  await updateSource(admin.service(), id, { processing_paused: paused });
  return reply(admin, { success: true, sourceId: id, paused });
});

export const setVisibility = adminRoute<Ctx>("/api/admin/sources/[id]/visibility", async (admin, request, ctx) => {
  const { admin_only } = await parseJson(request, z.object({ admin_only: z.boolean() }));
  const id = await idOf(ctx);
  await updateSource(admin.service(), id, { admin_only });
  return reply(admin, { success: true, sourceId: id, admin_only });
});

interface TierRow {
  id: string;
  base_tier: number | null;
  tier_override: number | null;
  effective_tier: number | null;
  override_reason: string | null;
  override_date: string | null;
}
const TIER_COLUMNS = "id, base_tier, tier_override, effective_tier, override_reason, override_date";

async function readTier(db: Db, id: string): Promise<TierRow> {
  const { data, error } = await db.from("sources").select(TIER_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new LookupError("sources", error);
  if (!data) throw new HttpError(404, "source not found");
  return data as TierRow;
}

export const getTierOverride = adminRoute<Ctx>("/api/admin/sources/[id]/tier-override", async (admin, _request, ctx) => {
  const id = await idOf(ctx);
  const db = admin.service();
  const s = await readTier(db, id);
  const events = await db.from("source_trust_events").select("event_type, reviewer_id, created_at, details").eq("source_id", id).in("event_type", ["tier_override", "tier_override_revert"]).order("created_at", { ascending: false }).limit(20);
  if (events.error) throw new LookupError("source_trust_events", events.error);
  return reply(admin, { base_tier: s.base_tier, tier_override: s.tier_override, effective_tier: s.effective_tier, override_reason: s.override_reason, override_date: s.override_date, audit: events.data ?? [] });
});

/**
 * Set or revert an operator tier (the ONE tier path, INV-286): tier_override with a reason (required when setting), then ONE checked audit row naming the actor (INV-288). base_tier is never
 * touched. When the audit row cannot be written the override is put back as it was and the call fails: an override with no record of who made it does not stand.
 */
export async function applyTierOverride(db: Db, actorId: string, id: string, input: { tier: number | null; reason: string | null }): Promise<{ action: "set" | "revert"; before_tier: number | null; after_tier: number | null; override_date: string }> {
  if (input.tier !== null && !input.reason) throw new HttpError(400, "override_reason is required when tier_override is set (the operator's reason is the audit)");
  const prior = await readTier(db, id);
  const revert = input.tier === null;
  const before = prior.tier_override ?? prior.base_tier;
  const after = revert ? prior.base_tier : input.tier;
  const date = new Date().toISOString();
  await updateSource(db, id, { tier_override: revert ? null : input.tier, override_reason: revert ? null : input.reason, override_date: date });
  try {
    await writeTrustEvent(db, { sourceId: id, type: revert ? "tier_override_revert" : "tier_override", details: revert ? { previous_override: prior.tier_override, reason: input.reason } : { before_tier: before, after_tier: after, reason: input.reason }, actorId });
  } catch (e) {
    const undo = await db.from("sources").update({ tier_override: prior.tier_override, override_reason: prior.override_reason, override_date: prior.override_date }).eq("id", id);
    throw new HttpError(500, `${e instanceof Error ? e.message : String(e)}; ${undo.error ? `the override could not be put back (${undo.error.message}); check source ${id}` : "the override was put back as it was"}`);
  }
  return { action: revert ? "revert" : "set", before_tier: before, after_tier: after, override_date: date };
}

const overrideBody = z.object({ tier_override: z.number().int().min(1).max(7).nullable(), override_reason: z.string().trim().max(2000).nullish() });
export const postTierOverride = adminRoute<Ctx>("/api/admin/sources/[id]/tier-override", async (admin, request, ctx) => {
  const body = await parseJson(request, overrideBody);
  const id = await idOf(ctx);
  const done = await applyTierOverride(admin.service(), admin.userId, id, { tier: body.tier_override, reason: text(body.override_reason) });
  return reply(admin, { success: true, sourceId: id, tier_override: body.tier_override, override_reason: body.tier_override === null ? null : text(body.override_reason), ...done });
});

/**
 * The operator's base_tier change for a seeded source: refused (409) while an override stands, both on the read and inside the UPDATE (INV-073), and now with its audit row (INV-288). Kept as the brief names it;
 * no screen mounts it, because the tier decision is the override.
 */
export const commitTierChange = adminRoute("/api/admin/sources/commit-tier-change", async (admin, request) => {
  const body = await parseJson(request, z.object({ source_id: uuid, tier: z.number().int().min(1).max(7) }));
  const db = admin.service();
  const prior = await readTier(db, body.source_id);
  const refused = `source ${body.source_id} carries an operator tier override; base_tier is not written underneath it. Revert the override first, then commit the tier change.`;
  if (prior.tier_override != null) throw new HttpError(409, refused);
  const { data, error } = await notUnderTierOverride(db.from("sources").update({ base_tier: body.tier }).eq("id", body.source_id)).select("id");
  if (error) throw dbError(error);
  if (!data?.length) throw new HttpError(409, refused);
  await writeTrustEvent(db, { sourceId: body.source_id, type: "manual_review", details: { decision: "base_tier_commit", before_tier: prior.base_tier, after_tier: body.tier }, actorId: admin.userId });
  return reply(admin, { success: true, source_id: body.source_id, prior_tier: prior.base_tier, tier: body.tier });
});

/** A machine-adopted tag can be confirmed or removed by an operator; a row that already carries an operator decision has nothing left to decide. */
const OPERATOR_DECIDED = new Set(["operator_confirmed", "operator_set"]);
export const patchBiasTag = adminRoute<Ctx>("/api/admin/sources/[id]/bias-tags", async (admin, request, ctx) => {
  const body = await parseJson(request, z.object({ biasTagId: uuid, decision: z.enum(["confirm", "reject"]) }));
  const sourceId = await idOf(ctx);
  const db = admin.service();
  const read = await db.from("source_bias_tags").select("id, source_id, dimension, tag, confidence, assignment_source").eq("id", body.biasTagId).eq("source_id", sourceId).maybeSingle();
  if (read.error) throw new LookupError("source_bias_tags", read.error);
  const row = read.data as { dimension: string; tag: string; confidence: number | null; assignment_source: string } | null;
  if (!row) throw new HttpError(404, "bias tag not found for this source");
  if (OPERATOR_DECIDED.has(row.assignment_source)) throw new HttpError(409, `bias tag already carries an operator decision (assignment_source is "${row.assignment_source}")`);
  const write = body.decision === "confirm" ? await db.from("source_bias_tags").update({ assignment_source: "operator_confirmed" }).eq("id", body.biasTagId) : await db.from("source_bias_tags").delete().eq("id", body.biasTagId);
  if (write.error) throw dbError(write.error);
  await writeTrustEvent(db, { sourceId, type: "manual_review", details: { decision: body.decision === "confirm" ? "bias_tag_confirm" : "bias_tag_reject", biasTagId: body.biasTagId, dimension: row.dimension, tag: row.tag, confidence: row.confidence, previous_assignment_source: row.assignment_source }, actorId: admin.userId });
  return reply(admin, { success: true, sourceId, biasTagId: body.biasTagId, decision: body.decision });
});

/**
 * Fetch one source now, through the free direct fetch behind the hold (INV-177): while the cadence is off or the emergency stop is set nothing reaches the network and the answer says so (423).
 * A fetch that did not answer is INCONCLUSIVE (503) and stamps only last_checked; only a definitive 404 or 410 stamps last_inaccessible.
 */
export const fetchNow = adminRoute<Ctx>("/api/admin/sources/[id]/fetch-now", async (admin, _request, ctx) => {
  const id = await idOf(ctx);
  const db = admin.service();
  const { data, error } = await db.from("sources").select("id, name, url").eq("id", id).maybeSingle();
  if (error) throw new LookupError("sources", error);
  if (!data) throw new HttpError(404, "Source not found");
  const source = data as { id: string; name: string; url: string };
  const started = Date.now();
  let content: string | null = null;
  let failure: { status?: number; message: string } | null = null;
  try {
    const r = await fetchDirect(source.url, { db, env: process.env, caller: "admin-fetch-now" }, { max: 100_000 });
    if (r.status >= 400 || r.refusal) failure = { ...(r.status ? { status: r.status } : {}), message: r.refusal?.reason ?? `HTTP ${r.status}` };
    else content = r.text;
  } catch (e) {
    if (e instanceof FetchHoldError) throw new HttpError(423, `Nothing is fetched while the hold is on (${e.reason.replace(/_/g, " ")}). Lift the hold first.`);
    failure = { message: e instanceof Error ? e.message : String(e) };
  }
  const decision = decideFetchOutcome({ content, error: failure });
  const now = new Date().toISOString();
  const stamp = { last_checked: now, ...(decision.kind === "dead" ? { last_inaccessible: now } : {}), ...(decision.kind === "ok" ? { last_accessible: now } : {}) };
  await updateSource(db, id, stamp);
  if (decision.kind === "dead") return reply(admin, { success: false, dead: true, error: failure?.message, source: source.name }, decision.httpStatus);
  if (decision.kind === "inconclusive") return reply(admin, { success: false, inconclusive: true, reason: "reason" in decision ? decision.reason : "no-answer", error: failure?.message, source: source.name }, decision.httpStatus);
  const body = content ?? "";
  return reply(admin, { success: true, source: source.name, url: source.url, contentLength: body.length, contentPreview: body.slice(0, 800), durationMs: Date.now() - started });
});
