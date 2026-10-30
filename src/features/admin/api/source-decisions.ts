// Ported from old_repo/src/app/api/admin/canonical-sources/decide/route.ts (lines 61-317)
// Ported from old_repo/src/app/api/admin/canonical-sources/bulk-approve/route.ts (lines 52-288)
// Ported from old_repo/src/app/api/admin/sources/promote/route.ts (lines 64-293)
import { z } from "zod";

import { rowsByIds } from "@/core/db";
import type { Db } from "@/core/db";
import { dbError, HttpError, LookupError } from "@/core/http/errors";
import { parseJson, uuid } from "@/core/http/parse";
import { canonicalUrl, hostOf } from "@/core/shared";
import { writeBiasTags, classTierForHost } from "@/core/sources";
import { lookupExactHost } from "@/core/sources/register";
import { buildPromotedSourceRow, findExistingSourceByCanonicalUrl, PROVISIONAL_PROMOTED_STATUS, PROVISIONAL_REJECTED_STATUS } from "@/features/sources/provisional";
import { checkVerticalFitGate } from "@/features/sources/vertical-fit-gate";

import { applyTierOverride } from "./source-controls";
import { adminRoute, reply, text, writeTrustEvent } from "./shared";

const BULK_MAX = 300;
export type CandidateKind = "canonical" | "provisional";

export interface DecisionInput {
  kind: CandidateKind;
  id: string;
  decision: "approve" | "reject" | "defer";
  /** The operator's tier. Required only when the class table cannot place the host; when it differs from the class tier it becomes a tier_override with a reason, never a base_tier. */
  assignedTier?: number | null | undefined;
  domains?: number[] | undefined;
  jurisdictions?: string[] | undefined;
  transport_modes?: string[] | undefined;
  topic_tags?: string[] | undefined;
  reviewerNotes?: string | null | undefined;
  existingSourceId?: string | null | undefined;
  editedFields?: { candidate_url?: string | undefined; candidate_title?: string | undefined; candidate_publisher?: string | undefined } | undefined;
  /** A bulk row never fails the batch: a row that needs a person is handed back as `review`. */
  bulk?: boolean | undefined;
}

export type DecisionResult =
  | { status: "approved"; sourceId: string; itemId: string | null; created: boolean; reused: boolean; notes: string[] }
  | { status: "rejected" | "deferred"; itemId: string | null }
  | { status: "review"; reason: string; itemId: string | null; candidateUrl: string }
  | { status: "refused"; httpStatus: number; error: string; needsFreshConsent?: boolean }
  /** Some writes landed and a later one failed: what is durable, what failed, and what to do. The caller reports this as partial, never as success. */
  | { status: "partial"; sourceId: string | null; itemId: string | null; failed: string; durable: string[]; remediation: string };

interface Subject {
  url: string;
  name: string;
  description: string;
  itemId: string | null;
  discoveredVia: string | null;
  context: string;
  biasTags: unknown;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function loadSubject(db: Db, input: DecisionInput): Promise<Subject> {
  const table = input.kind === "canonical" ? "canonical_source_candidates" : "provisional_sources";
  const { data, error } = await db.from(table).select("*").eq("id", input.id).maybeSingle();
  if (error) throw new LookupError(table, error);
  if (!data) throw new HttpError(404, input.kind === "canonical" ? "Candidate not found" : "Provisional source not found");
  const row = data as Record<string, unknown>;
  const pending = input.kind === "canonical" ? row.decision === "pending" : row.status === "pending_review" || row.status === "needs_more_data";
  if (!pending) throw new HttpError(409, `already ruled (${String(input.kind === "canonical" ? row.decision : row.status)})`);
  if (input.kind === "canonical") {
    const url = String(row.candidate_url ?? "");
    return { url, name: String(row.candidate_publisher || row.candidate_title || url), description: String(row.candidate_title ?? ""), itemId: (row.intelligence_item_id as string | null) ?? null, discoveredVia: "canonical candidate", context: `Issue: ${String(row.issue_classification)}. Confidence: ${String(row.confidence)}.`, biasTags: (row.recommended_classification as { bias_tags?: unknown } | null)?.bias_tags };
  }
  return { url: String(row.url ?? ""), name: String(row.name ?? ""), description: String(row.description ?? ""), itemId: null, discoveredVia: (row.discovered_via as string | null) ?? null, context: "", biasTags: (row.recommended_classification as { bias_tags?: unknown } | null)?.bias_tags };
}

/** The mark that closes a candidate: one place for the canonical and provisional columns. */
function markPatch(input: DecisionInput, outcome: "approved" | "rejected" | "deferred", by: string, nowIso: string, sourceId: string | null, note: string | null): { table: string; patch: Record<string, unknown> } {
  if (input.kind === "canonical") {
    return { table: "canonical_source_candidates", patch: { reviewer_id: by, reviewed_at: nowIso, reviewer_notes: note, ...(outcome === "deferred" ? {} : { decision: outcome, reviewed: true, ...(sourceId ? { promoted_to_source_id: sourceId } : {}) }) } };
  }
  return { table: "provisional_sources", patch: { reviewed_at: nowIso, reviewer_notes: note ?? "", ...(outcome === "approved" ? { status: PROVISIONAL_PROMOTED_STATUS, promoted_to_source_id: sourceId } : outcome === "rejected" ? { status: PROVISIONAL_REJECTED_STATUS } : {}) } };
}

/**
 * THE operator decision on a source candidate, canonical or provisional (INV-005, INV-176, INV-287, INV-288). Dedup is canonical and FAILS CLOSED: an unreadable registry refuses before any insert, and a
 * hit reuses the existing source. A new source is born at the class table's tier for its host (never a model guess); a tier the operator chose differently is written as tier_override with its reason, and
 * base_tier of an existing source is never written here. Every trust-bearing write has one checked audit row. A write that lands and is followed by one that fails is reported as `partial`, with what is
 * durable and what to do, never as success. A bulk row that needs a person is handed back as `review`; it never fails the batch.
 */
export async function decideSourceCandidate(db: Db, actorId: string, input: DecisionInput, nowIso: string): Promise<DecisionResult> {
  const subject = await loadSubject(db, input);
  const note = text(input.reviewerNotes);
  const closed = async (outcome: "approved" | "rejected" | "deferred", sourceId: string | null, extra: string | null = null) => {
    const m = markPatch(input, outcome, actorId, nowIso, sourceId, extra ? `${note ?? ""} ${extra}`.trim() : note);
    return db.from(m.table).update(m.patch).eq("id", input.id);
  };
  if (input.decision !== "approve") {
    const done = await closed(input.decision === "reject" ? "rejected" : "deferred", null);
    if (done.error) throw dbError(done.error);
    return { status: input.decision === "reject" ? "rejected" : "deferred", itemId: subject.itemId };
  }

  let url = subject.url;
  if (input.kind === "canonical" && input.editedFields) {
    const patch: Record<string, string> = {};
    if (input.editedFields.candidate_url !== undefined) patch.candidate_url = canonicalUrl(input.editedFields.candidate_url) ?? input.editedFields.candidate_url;
    if (input.editedFields.candidate_title !== undefined) patch.candidate_title = input.editedFields.candidate_title;
    if (input.editedFields.candidate_publisher !== undefined) patch.candidate_publisher = input.editedFields.candidate_publisher;
    if (Object.keys(patch).length) {
      const e = await db.from("canonical_source_candidates").update(patch).eq("id", input.id);
      if (e.error) throw dbError(e.error);
      url = patch.candidate_url ?? url;
      Object.assign(subject, { name: patch.candidate_publisher || patch.candidate_title || subject.name, description: patch.candidate_title ?? subject.description });
    }
  }
  const canon = canonicalUrl(url) ?? url;
  const refuse = (httpStatus: number, error: string, needsFreshConsent = false): DecisionResult => (input.bulk ? { status: "review", reason: error, itemId: subject.itemId, candidateUrl: url } : { status: "refused", httpStatus, error, ...(needsFreshConsent ? { needsFreshConsent } : {}) });

  // 1. Which source: the one named, else the one already at this canonical URL, else a new one. A registry that cannot be read refuses: an empty answer here would mint a duplicate.
  let sourceId: string | null = input.existingSourceId ?? null;
  let reused = !!sourceId;
  if (!sourceId) {
    const found = await lookupExactHost(db, canon);
    if (!found.ok) return { status: "refused", httpStatus: 503, error: `Source registry lookup failed; aborting to avoid a duplicate insert: ${found.error}` };
    const hit = findExistingSourceByCanonicalUrl(found.rows, canon);
    if (hit) {
      sourceId = hit.id;
      reused = true;
    }
  }
  const durable: string[] = [];
  let created = false;
  if (!sourceId) {
    const gate = await checkVerticalFitGate(db, { name: subject.name, url: canon });
    if (!gate.allow) return refuse(422, `vertical-fit gate: ${gate.reason}`, true);
    const classTier = classTierForHost(hostOf(canon), subject.name);
    const chosen = input.assignedTier ?? null;
    if (classTier == null && chosen == null) return refuse(400, "the host is not placed by the class table; set the tier (1-7) in individual review");
    const base = (classTier ?? chosen) as number;
    const built = buildPromotedSourceRow({ name: subject.name, url: canon, description: subject.description, discovered_via: subject.discoveredVia }, base, { promotedBy: `reviewer ${actorId.slice(0, 8)}`, ...(note ? { note: `${subject.context} ${note}`.trim() } : subject.context ? { note: subject.context } : {}), nowIso });
    const ins = await db.from("sources").insert({ ...built, domains: input.domains ?? [], jurisdictions: input.jurisdictions ?? [], transport_modes: input.transport_modes ?? [], topic_tags: input.topic_tags ?? [] }).select("id").single();
    if (ins.error || !ins.data) throw ins.error ? dbError(ins.error) : new HttpError(500, "Failed to insert source: no row returned");
    sourceId = (ins.data as { id: string }).id;
    created = true;
    durable.push(`source ${sourceId} created`);
    try {
      await writeTrustEvent(db, { sourceId, type: "manual_review", details: { decision: "approve", provenance: `${input.kind}_source_candidate`, candidateId: input.id, intelligenceItemId: subject.itemId, reviewerNotes: note, classification: { class_tier: classTier, tier: base, domains: input.domains, jurisdictions: input.jurisdictions, transport_modes: input.transport_modes, topic_tags: input.topic_tags } }, actorId });
      durable.push("audit row written");
      if (chosen != null && chosen !== base) {
        await applyTierOverride(db, actorId, sourceId, { tier: chosen, reason: note ?? "operator tier at approval" });
        durable.push(`tier override ${chosen}`);
      }
      if (subject.biasTags) await writeBiasTags({ insertRows: async (rows) => db.from("source_bias_tags").insert(rows) }, sourceId, subject.biasTags);
    } catch (e) {
      return { status: "partial", sourceId, itemId: subject.itemId, failed: msg(e), durable, remediation: "the source exists; finish the audit, override or tags by hand and do not approve again (it would reuse this source)" };
    }
  }

  // 2. Link the item, then close the candidate. A failure after the source exists is partial and names what is durable.
  if (input.kind === "canonical" && subject.itemId) {
    const link = await db.from("intelligence_items").update({ source_id: sourceId, source_url: canon, updated_at: nowIso }).eq("id", subject.itemId);
    if (link.error) return { status: "partial", sourceId, itemId: subject.itemId, failed: `item link: ${link.error.message}`, durable, remediation: "the source exists; link the item to it by hand, then close the candidate" };
    durable.push("item linked");
  }
  const done = await closed("approved", sourceId, reused && !created ? `[reused existing source ${sourceId.slice(0, 8)}: canonical URL already in registry, no duplicate created]` : null);
  if (done.error) return { status: "partial", sourceId, itemId: subject.itemId, failed: `candidate mark: ${done.error.message}`, durable, remediation: "the source and the item link are durable; close the candidate by hand and do not approve again" };
  return { status: "approved", sourceId, itemId: subject.itemId, created, reused: reused && !created, notes: durable };
}

const classification = { assignedTier: z.number().int().min(1).max(7).nullish(), domains: z.array(z.number().int()).max(20).optional(), jurisdictions: z.array(z.string().max(40)).max(60).optional(), transport_modes: z.array(z.string().max(40)).max(10).optional(), topic_tags: z.array(z.string().max(60)).max(40).optional(), reviewerNotes: z.string().max(2000).nullish() };
const canonicalBody = z.object({ candidateId: uuid, decision: z.enum(["approve", "reject", "defer"]), existingSourceId: uuid.nullish(), editedFields: z.object({ candidate_url: z.string().max(2000).optional(), candidate_title: z.string().max(500).optional(), candidate_publisher: z.string().max(300).optional() }).optional(), ...classification });
const provisionalBody = z.object({ provisionalSourceId: uuid, decision: z.enum(["approve", "reject", "defer"]), ...classification });

/** A decision result as the response: refused is its status, partial is a 500 that names the durable state, everything else is a 200. */
function respond(admin: Parameters<typeof reply>[0], r: DecisionResult): Response {
  if (r.status === "refused") throw new HttpError(r.httpStatus, r.error);
  if (r.status === "partial") return reply(admin, { success: false, partial: true, error: r.failed, sourceId: r.sourceId, itemId: r.itemId, durable: r.durable, remediation: r.remediation }, 500);
  return reply(admin, { success: true, ...r });
}

export const decideCanonical = adminRoute("/api/admin/canonical-sources/decide", async (admin, request) => {
  const b = await parseJson(request, canonicalBody);
  const { candidateId, ...rest } = b;
  return respond(admin, await decideSourceCandidate(admin.service(), admin.userId, { kind: "canonical", id: candidateId, ...rest }, new Date(performance.timeOrigin + performance.now()).toISOString()));
});

export const decideProvisional = adminRoute("/api/admin/sources/promote", async (admin, request) => {
  const b = await parseJson(request, provisionalBody);
  const { provisionalSourceId, ...rest } = b;
  return respond(admin, await decideSourceCandidate(admin.service(), admin.userId, { kind: "provisional", id: provisionalSourceId, ...rest }, new Date(performance.timeOrigin + performance.now()).toISOString()));
});

/** Approve many canonical candidates at their class tier. Each row runs the one decision; a row that needs a person (an unplaced host, a gated host, an unreadable registry for that row) is listed for review and the batch goes on. */
export const bulkApprove = adminRoute("/api/admin/canonical-sources/bulk-approve", async (admin, request) => {
  const b = await parseJson(request, z.object({ candidateIds: z.array(uuid).min(1).max(BULK_MAX), reviewerNotes: z.string().max(2000).nullish() }));
  const db = admin.service();
  const rows = await rowsByIds<{ id: string; decision: string }>(db, "canonical_source_candidates", "id, decision", b.candidateIds);
  if (!rows.length) throw new HttpError(404, "No matching candidates found");
  const nowIso = new Date(performance.timeOrigin + performance.now()).toISOString();
  const results: Record<string, unknown>[] = [];
  const review: { candidateId: string; itemId: string | null; candidateUrl: string; reason: string }[] = [];
  let approved = 0;
  let created = 0;
  let failed = 0;
  for (const c of rows) {
    if (c.decision !== "pending") {
      results.push({ candidateId: c.id, skipped: true, reason: `Candidate already in decision state '${c.decision}'` });
      continue;
    }
    try {
      const r = await decideSourceCandidate(db, admin.userId, { kind: "canonical", id: c.id, decision: "approve", reviewerNotes: b.reviewerNotes, bulk: true }, nowIso);
      if (r.status === "review") review.push({ candidateId: c.id, itemId: r.itemId, candidateUrl: r.candidateUrl, reason: r.reason });
      else if (r.status === "approved") {
        approved += 1;
        created += r.created ? 1 : 0;
        results.push({ candidateId: c.id, itemId: r.itemId, sourceId: r.sourceId, createdSource: r.created, success: true });
      } else {
        failed += 1;
        results.push({ candidateId: c.id, error: r.status === "partial" ? `partial: ${r.failed}` : r.status === "refused" ? r.error : r.status, ...(r.status === "partial" ? { partial: true, sourceId: r.sourceId } : {}) });
      }
    } catch (e) {
      failed += 1;
      results.push({ candidateId: c.id, error: msg(e) });
    }
  }
  return reply(admin, { success: true, total: b.candidateIds.length, approved, created_sources: created, failed, requires_individual_review: review.length, results, review_queue: review });
});
